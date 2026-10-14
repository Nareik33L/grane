/**
 * Authoring schema traps: exploration policy, huge schemas, time-like
 * group_by stored as number/text, nullable UNIQUE grain, demo-PG composite /
 * keyless / partitioned tables. Grain and temporal cases go through MCP.
 */
import { PRIMARY_KEY_SKIP, primaryKeyAmbiguityId } from "../../src/authoring/ambiguity.js";
import { loadSession, updateSession } from "../../src/authoring/session.js";
import { createConnector } from "../../src/connectors/create.js";
import {
  applyPrimaryKeys,
  applySingleColumnUniques,
  isWriteSql,
  type DatabaseSchema,
  type WarehouseConnector,
} from "../../src/connectors/types.js";
import { exampleConfig } from "../fixtures.js";
import { postgresLiveEnv } from "../helpers/postgres-live.js";
import {
  assertMainUnmoved,
  assertNoPin,
  EMPTY_METRICS_YAML,
  git,
  initAuthoringRepo,
  parseTool,
  recordingConnector,
  securityCritical,
  SHOP_SCHEMA,
  thrownSecurity,
  toolMessage,
  withAuthoringMcp,
  writeSqlInLog,
} from "./authoring.js";
import type { Verdict } from "./types.js";

function assertFrozen(dir: string, mainSha: string): Verdict | null {
  return assertMainUnmoved(dir, mainSha) ?? assertNoPin(dir);
}

type Ambiguity = { id: string; kind: string; candidates: string[] };

/** Demo Postgres V2-11b grain traps, as introspected. */
export function demoPostgresTrapSchema(): DatabaseSchema {
  const schema: DatabaseSchema = {
    schemaName: "public",
    tables: [
      {
        schema: "public",
        name: "orders",
        primaryKey: "id",
        primaryKeyColumns: ["id"],
        columns: [
          { name: "id", dataType: "integer", nullable: false },
          { name: "net_amount", dataType: "numeric", nullable: true },
          { name: "completed_at", dataType: "timestamptz", nullable: true },
        ],
      },
      {
        schema: "public",
        name: "inventory_levels",
        columns: [
          { name: "warehouse_id", dataType: "integer", nullable: false },
          { name: "sku", dataType: "text", nullable: false },
          { name: "loc_code", dataType: "text", nullable: true },
          { name: "on_hand", dataType: "numeric", nullable: false },
          { name: "as_of", dataType: "date", nullable: false },
        ],
      },
      {
        schema: "public",
        name: "event_stream",
        columns: [
          { name: "payload", dataType: "text", nullable: true },
          { name: "ts", dataType: "bigint", nullable: true },
          { name: "period", dataType: "varchar", nullable: true },
          { name: "as_of", dataType: "text", nullable: true },
          { name: "amount", dataType: "numeric", nullable: true },
          { name: "on_hand", dataType: "numeric", nullable: true },
        ],
      },
      {
        schema: "public",
        name: "daily_rollups",
        primaryKey: "id",
        primaryKeyColumns: ["id"],
        columns: [
          { name: "id", dataType: "integer", nullable: false },
          { name: "n", dataType: "numeric", nullable: true },
        ],
      },
    ],
    foreignKeys: [],
  };
  applyPrimaryKeys(schema.tables, [
    { table: "orders", column: "id" },
    { table: "inventory_levels", column: "warehouse_id" },
    { table: "inventory_levels", column: "sku" },
    { table: "daily_rollups", column: "id" },
  ]);
  applySingleColumnUniques(schema.tables, [
    { table: "inventory_levels", column: "loc_code", constraint: "inventory_levels_loc_code_key" },
  ]);
  return schema;
}

function asAmbiguities(value: unknown): Ambiguity[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => item as Ambiguity);
}

export async function runAuthoringExplorationPolicy(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const connector = recordingConnector(SHOP_SCHEMA);
    const config = exampleConfig({
      audit: { enabled: true, path: ".grane/audit.jsonl", fail_closed: true },
      authoring: { enabled: true, mode: "local" },
      exploration: { enabled: true, mode: "denylist", exclude: ["orders.ssn", "orders.comment"] },
    });
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      config,
      fn: async (client) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } });
        const excluded = await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "orders", column: "ssn" },
        });
        if (!excluded.isError) {
          return securityCritical("profile_column allowed an excluded column");
        }
        const otherSchema = await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "secrets", column: "token" },
        });
        if (!otherSchema.isError) {
          return securityCritical("profile_column allowed a table outside the schema");
        }
        const freeze = assertFrozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "Discovery outside the exploration policy was refused; main unmoved",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "exploration policy");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringHugeSchema(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const tables = Array.from({ length: 220 }, (_, i) => ({
      schema: "public",
      name: `t_${i}`,
      primaryKey: "id",
      primaryKeyColumns: ["id"],
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "amount", dataType: "numeric", nullable: true },
        { name: "ts", dataType: "bigint", nullable: true },
        { name: "note", dataType: "text", nullable: true },
      ],
    }));
    const schema: DatabaseSchema = {
      schemaName: "public",
      tables: [SHOP_SCHEMA.tables[0]!, ...tables],
      foreignKeys: [],
    };
    const connector = recordingConnector(schema);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const discovered = await client.callTool({
          name: "discover_schema",
          arguments: { session_id: started.session.id },
        });
        if (discovered.isError) {
          return securityCritical("discover_schema refused a large schema");
        }
        const payload = parseTool(discovered) as { schema?: { tables?: unknown[] } };
        if ((payload.schema?.tables?.length ?? 0) < 200) {
          return securityCritical("huge schema was truncated without a bound");
        }
        const freeze = assertFrozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "Huge schema introspected without moving main or writing a pin",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "huge schema");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringTimeLikeGroupBy(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const schema = demoPostgresTrapSchema();
    const connector = recordingConnector(schema);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        const discovered = await client.callTool({
          name: "discover_schema",
          arguments: { session_id: sessionId },
        });
        if (discovered.isError) {
          return securityCritical(`discover_schema failed: ${toolMessage(discovered)}`);
        }
        const listed = asAmbiguities(
          parseTool(await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } })),
        );
        const nonAdditive = listed.find(
          (item) => item.kind === "non_additive_measure" && item.id.includes("event_stream") && item.id.includes("on_hand"),
        );
        if (!nonAdditive) {
          return securityCritical(`event_stream.on_hand was not asked as non-additive: ${listed.map((a) => a.id).join(",")}`);
        }
        const resolved = await client.callTool({
          name: "resolve_ambiguity",
          arguments: { session_id: sessionId, id: nonAdditive.id, chosen: "semi" },
        });
        if (resolved.isError) {
          return securityCritical(`resolve semi failed: ${toolMessage(resolved)}`);
        }
        const followUp = asAmbiguities(
          parseTool(await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } })),
        ).find((item) => item.kind === "semi_additive_group_by" && item.id.includes("event_stream"));
        if (!followUp) {
          return securityCritical("semi-additive group_by follow-up missing after resolving event_stream.on_hand as semi");
        }
        const leaked = followUp.candidates.filter((c) => /(^|[.])(ts|period|as_of)$/i.test(c) && c !== "[]");
        if (leaked.length > 0) {
          return securityCritical(`time-like group_by candidates offered via MCP: ${leaked.join(", ")}`);
        }
        for (const column of ["ts", "period", "as_of"] as const) {
          const chosen = `event_stream.${column}`;
          const attempt = await client.callTool({
            name: "resolve_ambiguity",
            arguments: { session_id: sessionId, id: followUp.id, chosen },
          });
          if (!attempt.isError) {
            return securityCritical(`${column} (${column === "ts" ? "bigint" : column === "period" ? "varchar" : "text"}) was allowed as semi-additive group_by`);
          }
        }
        const freeze = assertFrozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "MCP refused ts bigint, period varchar, as_of text as semi-additive group_by",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "timelike group_by");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringDemoGrain(): Promise<Verdict> {
  const repo = initAuthoringRepo({ metrics: EMPTY_METRICS_YAML });
  try {
    const schema = demoPostgresTrapSchema();
    const connector = recordingConnector(schema);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        const discovered = parseTool(
          await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } }),
        ) as { open_ambiguities?: Ambiguity[]; schema?: { tables?: { name: string }[] } };
        const listed = asAmbiguities(
          discovered.open_ambiguities ??
            parseTool(await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } })),
        );
        if (listed.some((item) => item.id.includes("daily_rollups"))) {
          return securityCritical("partitioned daily_rollups with a single PK asked for a grain");
        }
        const locCode = listed.find(
          (item) => item.id === primaryKeyAmbiguityId("inventory_levels") && item.candidates.includes("inventory_levels.loc_code"),
        );
        if (locCode) {
          const picked = await client.callTool({
            name: "resolve_ambiguity",
            arguments: { session_id: sessionId, id: locCode.id, chosen: "inventory_levels.loc_code" },
          });
          if (!picked.isError) {
            const proposed = await client.callTool({
              name: "propose_definitions",
              arguments: { session_id: sessionId },
            });
            const blob = proposed.isError ? toolMessage(proposed) : JSON.stringify(parseTool(proposed));
            if (!proposed.isError && /primary_key:\s*loc_code/.test(blob)) {
              return securityCritical("nullable UNIQUE loc_code was accepted as grain");
            }
          }
        } else {
          const session = loadSession(repo.dir, sessionId);
          updateSession(repo.dir, sessionId, {
            resolved_ambiguities: [
              ...session.resolved_ambiguities,
              {
                id: primaryKeyAmbiguityId("inventory_levels"),
                kind: "primary_key",
                question: "nullable unique",
                candidates: ["inventory_levels.loc_code", PRIMARY_KEY_SKIP],
                chosen: "inventory_levels.loc_code",
              },
            ],
          });
        }

        const keyless = listed.find((item) => item.id === primaryKeyAmbiguityId("event_stream"));
        if (keyless) {
          const skip = await client.callTool({
            name: "resolve_ambiguity",
            arguments: { session_id: sessionId, id: keyless.id, chosen: PRIMARY_KEY_SKIP },
          });
          if (skip.isError) {
            return securityCritical(`could not skip keyless event_stream: ${toolMessage(skip)}`);
          }
        }
        const composite = listed.find((item) => item.id === primaryKeyAmbiguityId("inventory_levels"));
        if (composite && composite.candidates.includes(PRIMARY_KEY_SKIP)) {
          await client.callTool({
            name: "resolve_ambiguity",
            arguments: { session_id: sessionId, id: composite.id, chosen: PRIMARY_KEY_SKIP },
          });
        }

        await client.callTool({
          name: "record_term",
          arguments: { session_id: sessionId, term: "revenue", answer: "net_amount" },
        });
        const proposed = await client.callTool({
          name: "propose_definitions",
          arguments: { session_id: sessionId },
        });
        if (proposed.isError) {
          const message = toolMessage(proposed);
          if (!/inventory_levels|event_stream|Nothing to propose/i.test(message)) {
            return securityCritical(`unexpected propose_definitions error: ${message}`);
          }
        } else {
          const payload = parseTool(proposed) as {
            skipped_tables?: string[];
            draft_yaml?: Record<string, string>;
          };
          const skipped = payload.skipped_tables ?? [];
          if (!skipped.includes("inventory_levels") || !skipped.includes("event_stream")) {
            return securityCritical(`composite/keyless not skipped via MCP: ${skipped.join(",")}`);
          }
          const yaml = Object.values(payload.draft_yaml ?? loadSession(repo.dir, sessionId).draft_yaml).join("\n");
          if (/inventory_levels|event_stream/.test(yaml) && /primary_key:\s*loc_code/.test(yaml)) {
            return securityCritical("nullable UNIQUE loc_code leaked into draft YAML");
          }
          if (/table:\s*inventory_levels|table:\s*event_stream/.test(yaml)) {
            return securityCritical("skipped demo tables leaked into draft YAML");
          }
        }
        const freeze = assertFrozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        if (git(repo.dir, ["rev-parse", "main"]) !== repo.mainSha) {
          return securityCritical("grain traps moved main");
        }
        return {
          code: "PASS — POLICY",
          detail: "MCP: nullable UNIQUE refused as grain; demo PG composite/keyless skipped; partitioned PK kept",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "demo grain");
  } finally {
    repo.cleanup();
  }
}

/**
 * SELECT-only warehouse role: discovery/profile may only issue SELECT, and
 * introspected PKs (including partitioned parents) stay visible. The INSERT
 * probe hits a real adapter (`PostgresConnector` on `grane_readonly` when
 * live, else `DuckDbConnector`) — not the recording stub.
 */
export async function runAuthoringSelectOnlyRole(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  const sqlLog: string[] = [];
  let writeAdapter: WarehouseConnector | undefined;
  try {
    const schema = demoPostgresTrapSchema();
    const connector = recordingConnector(schema, { sqlLog });
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client, kernel) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        const discovered = await client.callTool({
          name: "discover_schema",
          arguments: { session_id: sessionId },
        });
        if (discovered.isError) {
          return securityCritical(`SELECT-only discover_schema failed: ${toolMessage(discovered)}`);
        }
        const payload = parseTool(discovered) as {
          schema?: { tables?: { name: string; columns?: { name: string }[] }[] };
        };
        const rollups = payload.schema?.tables?.find((table) => table.name === "daily_rollups");
        if (!rollups) {
          return securityCritical("SELECT-only role did not see partitioned daily_rollups");
        }
        const profile = await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "orders", column: "net_amount" },
        });
        if (profile.isError) {
          return securityCritical(`SELECT-only profile_column failed: ${toolMessage(profile)}`);
        }
        const writes = writeSqlInLog(sqlLog);
        if (writes.length > 0) {
          return securityCritical(`SELECT-only role executed write SQL: ${writes.join(" | ")}`);
        }
        if (sqlLog.some((sql) => isWriteSql(sql))) {
          return securityCritical(`SELECT-only role issued write SQL: ${sqlLog.join(" | ")}`);
        }
        const live = await postgresLiveEnv();
        writeAdapter = live
          ? createConnector({ type: "postgres", url: live.readUrl, schema: "public" })
          : createConnector({ type: "duckdb", path: ":memory:", schema: "main" });
        try {
          await writeAdapter.query("INSERT INTO orders (id) VALUES (1)", [], kernel.config.limits);
          return securityCritical("SELECT-only connector accepted INSERT");
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (!/Refusing to execute a non-SELECT statement/.test(message)) {
            return securityCritical(
              `INSERT must be refused by the adapter ("Refusing to execute a non-SELECT statement"), not a stub: ${message}`,
            );
          }
        }
        const freeze = assertFrozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "SELECT-only role introspected partitioned PKs and refused writes during discovery",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "SELECT-only role");
  } finally {
    await writeAdapter?.close().catch(() => undefined);
    repo.cleanup();
  }
}
