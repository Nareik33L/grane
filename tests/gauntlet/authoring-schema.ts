/**
 * Authoring schema traps: exploration policy, huge schemas, time-like
 * group_by stored as number/text, nullable UNIQUE grain, demo-PG composite /
 * keyless / partitioned tables.
 */
import {
  generateDraftYaml,
} from "../../src/authoring/generate.js";
import {
  GLOBAL_SNAPSHOT_GROUP_BY,
  PRIMARY_KEY_SKIP,
  detectAmbiguities,
  isForbiddenSemiGroupByColumn,
  primaryKeyAmbiguityId,
  semiAdditiveGroupByAmbiguity,
} from "../../src/authoring/ambiguity.js";
import { createSession } from "../../src/authoring/session.js";
import {
  applyPrimaryKeys,
  applySingleColumnUniques,
  grainUniqueColumns,
  type DatabaseSchema,
} from "../../src/connectors/types.js";
import { looksTemporal } from "../../src/connectors/dialect.js";
import { exampleConfig } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import {
  assertMainUnmoved,
  assertNoPin,
  git,
  initAuthoringRepo,
  parseTool,
  recordingConnector,
  SHOP_SCHEMA,
  withAuthoringMcp,
} from "./authoring.js";
import type { Verdict } from "./types.js";

function assertFrozen(dir: string, mainSha: string): Verdict | null {
  return assertMainUnmoved(dir, mainSha) ?? assertNoPin(dir);
}

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
          return { code: "SECURITY CRITICAL", detail: "profile_column allowed an excluded column" };
        }
        const otherSchema = await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "secrets", column: "token" },
        });
        if (!otherSchema.isError) {
          return { code: "SECURITY CRITICAL", detail: "profile_column allowed a table outside the schema" };
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
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
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
          return { code: "FAIL", detail: "discover_schema refused a large schema" };
        }
        const payload = parseTool(discovered) as { schema?: { tables?: unknown[] } };
        if ((payload.schema?.tables?.length ?? 0) < 200) {
          return { code: "FAIL", detail: "huge schema was truncated without a bound" };
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
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringTimeLikeGroupBy(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const schema = demoPostgresTrapSchema();
    const stream = schema.tables.find((table) => table.name === "event_stream")!;
    for (const column of ["ts", "period", "as_of"] as const) {
      const col = stream.columns.find((item) => item.name === column)!;
      if (!looksTemporal(col.name, col.dataType)) {
        return {
          code: "CRITICAL FAIL",
          detail: `${column} ${col.dataType} passed looksTemporal — must not be a group_by key`,
        };
      }
      if (!isForbiddenSemiGroupByColumn(schema, "event_stream", "amount", column)) {
        return {
          code: "CRITICAL FAIL",
          detail: `${column} (${col.dataType}) was allowed as semi-additive group_by`,
        };
      }
    }
    const followUp = semiAdditiveGroupByAmbiguity(schema, "event_stream", "amount");
    const leaked = followUp.candidates.filter((c) => /ts|period|as_of/.test(c) && c !== GLOBAL_SNAPSHOT_GROUP_BY);
    if (leaked.length > 0) {
      return {
        code: "CRITICAL FAIL",
        detail: `time-like group_by candidates offered: ${leaked.join(", ")}`,
      };
    }
    const freeze = assertFrozen(repo.dir, repo.mainSha);
    if (freeze) return freeze;
    return {
      code: "PASS — POLICY",
      detail: "ts bigint, period varchar, as_of text are refused as semi-additive group_by",
    };
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringDemoGrain(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const schema = demoPostgresTrapSchema();
    const inventory = schema.tables.find((table) => table.name === "inventory_levels")!;
    if (grainUniqueColumns(inventory).includes("loc_code")) {
      return {
        code: "CRITICAL FAIL",
        detail: "nullable UNIQUE loc_code was accepted as grain",
      };
    }
    const session = createSession(repo.dir, {
      warehouse_ref: { type: "postgres", locator: "demo" },
      resolved_ambiguities: [
        {
          id: primaryKeyAmbiguityId("inventory_levels"),
          kind: "primary_key",
          question: "nullable unique",
          candidates: ["inventory_levels.loc_code", PRIMARY_KEY_SKIP],
          chosen: "inventory_levels.loc_code",
        },
        {
          id: primaryKeyAmbiguityId("event_stream"),
          kind: "primary_key",
          question: "keyless",
          candidates: ["event_stream.payload", PRIMARY_KEY_SKIP],
          chosen: PRIMARY_KEY_SKIP,
        },
      ],
    });
    try {
      generateDraftYaml({ session, schema, inferred: {} });
      return { code: "CRITICAL FAIL", detail: "generateDraftYaml accepted nullable UNIQUE as grain" };
    } catch (err) {
      if (!(err instanceof GraneError) && !(err instanceof Error)) {
        return { code: "FAIL", detail: String(err) };
      }
      const message = err instanceof Error ? err.message : String(err);
      if (!/inventory_levels/.test(message)) {
        return { code: "FAIL", detail: `unexpected generate error: ${message}` };
      }
    }
    const skippedSession = createSession(repo.dir, {
      warehouse_ref: { type: "postgres", locator: "demo" },
      resolved_ambiguities: [
        {
          id: "amb-revenue-like-orders",
          kind: "revenue_like_columns",
          question: "revenue",
          candidates: ["orders.net_amount"],
          chosen: "orders.net_amount",
        },
        {
          id: primaryKeyAmbiguityId("inventory_levels"),
          kind: "primary_key",
          question: "skip composite",
          candidates: [PRIMARY_KEY_SKIP],
          chosen: PRIMARY_KEY_SKIP,
        },
        {
          id: primaryKeyAmbiguityId("event_stream"),
          kind: "primary_key",
          question: "skip keyless",
          candidates: [PRIMARY_KEY_SKIP],
          chosen: PRIMARY_KEY_SKIP,
        },
      ],
    });
    const { files, skipped_tables } = generateDraftYaml({ session: skippedSession, schema, inferred: {} });
    if (!skipped_tables.includes("inventory_levels") || !skipped_tables.includes("event_stream")) {
      return {
        code: "CRITICAL FAIL",
        detail: `composite/keyless not skipped: ${skipped_tables.join(",")}`,
      };
    }
    const yaml = `${files["entities.yml"] ?? ""}\n${files["metrics.yml"] ?? ""}`;
    if (/inventory_levels|event_stream/.test(yaml)) {
      return { code: "CRITICAL FAIL", detail: "skipped demo tables leaked into draft YAML" };
    }
    const detected = detectAmbiguities({ schema, relationships: {}, session: skippedSession });
    const openPk = detected.filter((item) => item.kind === "primary_key").map((item) => item.id);
    if (openPk.some((id) => id.includes("daily_rollups"))) {
      return { code: "FAIL", detail: "partitioned daily_rollups with a single PK asked for a grain" };
    }
    const freeze = assertFrozen(repo.dir, repo.mainSha);
    if (freeze) return freeze;
    if (git(repo.dir, ["rev-parse", "main"]) !== repo.mainSha) {
      return { code: "SECURITY CRITICAL", detail: "grain traps moved main" };
    }
    return {
      code: "PASS — POLICY",
      detail: "Nullable UNIQUE refused as grain; demo PG composite/keyless skipped; partitioned PK kept",
    };
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}
