import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DISCOVERY_SAMPLE_ROW_HARD_CAP,
  assertDiscoverySql,
  clampDiscoverySampleRows,
  createDiscovery,
  runDiscoveryQuery,
} from "../../src/authoring/discover.js";
import { createSession, sessionPath } from "../../src/authoring/session.js";
import { getDialect } from "../../src/connectors/dialect.js";
import { isWriteSql, type DatabaseSchema, type ExecutedRows, type WarehouseConnector } from "../../src/connectors/types.js";
import { GraneError } from "../../src/errors.js";
import { exampleConfig } from "../fixtures.js";

const temps: string[] = [];
const SECRET_SAMPLE = "SECRET_SAMPLE_VALUE";
const SECRET_PASSWORD = "SUPERSECRET_PASSWORD";
const SECRET_TOKEN = "SECRET_AGENT_TOKEN";
const SECRET_URL = `postgres://grane:${SECRET_PASSWORD}@localhost:5432/grane_demo`;

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-discover-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

const SCHEMA: DatabaseSchema = {
  schemaName: "public",
  tables: [
    {
      schema: "public",
      name: "customers",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "email", dataType: "text", nullable: true },
        { name: "status", dataType: "text", nullable: true },
      ],
    },
    {
      schema: "public",
      name: "orders",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "customer_id", dataType: "integer", nullable: false },
      ],
    },
  ],
  foreignKeys: [
    {
      constraintName: "orders_customer_id_fkey",
      table: "orders",
      column: "customer_id",
      refTable: "customers",
      refColumn: "id",
    },
  ],
};

function recordingConnector(opts?: {
  query?: (sql: string) => Promise<ExecutedRows>;
  introspect?: () => Promise<DatabaseSchema>;
}): WarehouseConnector & { sql: string[] } {
  const sql: string[] = [];
  const connector: WarehouseConnector & { sql: string[] } = {
    sql,
    type: "postgres",
    dialect: getDialect("postgres"),
    async query(statement: string) {
      sql.push(statement);
      if (opts?.query) return opts.query(statement);
      if (/COUNT\s*\(\s*DISTINCT/i.test(statement)) {
        return { columns: ["n"], rows: [{ n: 3 }] };
      }
      return { columns: ["v"], rows: [{ v: SECRET_SAMPLE }, { v: "active" }] };
    },
    async introspect() {
      return opts?.introspect ? opts.introspect() : SCHEMA;
    },
    async close() {},
  };
  return connector;
}

function readJsonl(path: string): Record<string, unknown>[] {
  if (!readFileSync(path, "utf8").trim()) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function walkText(dir: string): string {
  const chunks: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else chunks.push(readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

function secretfulConfig(dir: string, extra: Record<string, unknown> = {}) {
  return exampleConfig({
    connection: { type: "postgres", schema: "public", url: SECRET_URL, password: SECRET_PASSWORD },
    auth: { agents: [{ id: "authoring", token: SECRET_TOKEN }] },
    audit: { enabled: true, path: ".grane/audit.jsonl" },
    ...extra,
  });
}

describe("discovery sample cap", () => {
  it("clamps requested rows to the hard cap", () => {
    expect(clampDiscoverySampleRows(1)).toBe(1);
    expect(clampDiscoverySampleRows(DISCOVERY_SAMPLE_ROW_HARD_CAP)).toBe(DISCOVERY_SAMPLE_ROW_HARD_CAP);
    expect(clampDiscoverySampleRows(10_000)).toBe(DISCOVERY_SAMPLE_ROW_HARD_CAP);
    expect(clampDiscoverySampleRows(0)).toBe(1);
  });
});

describe("assertDiscoverySql / runDiscoveryQuery", () => {
  it("does not treat SELECT FOR UPDATE as write SQL (engine must still refuse it)", async () => {
    const { SELECT_FOR_UPDATE, selectForUpdateIsNotWriteSql } = await import("../helpers/discovery-readonly.js");
    expect(selectForUpdateIsNotWriteSql()).toBe(true);
    expect(isWriteSql(SELECT_FOR_UPDATE)).toBe(false);
    assertDiscoverySql(SELECT_FOR_UPDATE);
  });

  it("refuses write SQL before the connector is invoked", async () => {
    expect(() => assertDiscoverySql("INSERT INTO t VALUES (1)")).toThrow(GraneError);
    expect(isWriteSql("INSERT INTO t VALUES (1)")).toBe(true);
    const connector = recordingConnector();
    await expect(
      runDiscoveryQuery(connector, "INSERT INTO t VALUES (1)", {
        max_rows: 100,
        default_rows: 100,
        timeout_ms: 1000,
      }),
    ).rejects.toMatchObject({ refusal: { status: "unsafe_query" } });
    expect(connector.sql).toEqual([]);
  });

  it("allows SELECT through the connector", async () => {
    assertDiscoverySql("SELECT 1 AS v");
    const connector = recordingConnector();
    const result = await runDiscoveryQuery(connector, "SELECT 1 AS v", {
      max_rows: 100,
      default_rows: 100,
      timeout_ms: 1000,
    });
    expect(connector.sql).toEqual(["SELECT 1 AS v"]);
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe("createDiscovery", () => {
  it("emits exactly one JSONL line per discovery call (V2-02 / #88)", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: secretfulConfig(dir, {
        exploration: { enabled: true, mode: "denylist", exclude: ["*.email"] },
      }),
      connector,
      projectDir: dir,
      sessionId: "sess-1",
      agent: "authoring",
    });
    const schema = await discovery.introspectSchema();
    expect(schema.tables.map((t) => t.name).sort()).toEqual(["customers", "orders"]);
    const inferred = await discovery.inferRelationships(schema);
    expect(inferred.orders_to_customers).toEqual({
      from: "orders.customer_id",
      to: "customers.id",
      type: "many_to_one",
    });
    await discovery.profileColumn("customers", "status");
    await expect(discovery.profileColumn("customers", "email")).rejects.toMatchObject({
      refusal: { status: "column_not_permitted" },
    });
    const raw = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(4);
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events).toHaveLength(4);
    expect(events.map((event) => event.operation)).toEqual([
      "introspect",
      "relationships",
      "profile",
      "profile",
    ]);
    for (const event of events) {
      expect(event.kind).toBe("discovery");
      expect(event.read_only).toBe(true);
      expect(event.session_id).toBe("sess-1");
      expect(event).not.toHaveProperty("query");
      expect(event).not.toHaveProperty("samples");
      expect(event).not.toHaveProperty("rows");
      expect(event).not.toHaveProperty("values");
      expect(event).not.toHaveProperty("token");
      expect(event).not.toHaveProperty("password");
    }
    expect(events[3]!.refusal).toMatchObject({ status: "column_not_permitted" });
  });

  it("returns samples only to the caller; never writes samples or credentials to audit or session state", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: secretfulConfig(dir, { exploration: { enabled: true, exclude: [] } }),
      connector,
      projectDir: dir,
      sessionId: "sess-1",
      agent: "authoring",
      sampleRows: 10_000,
    });
    const profile = await discovery.profileColumn("customers", "status");
    expect(profile.distinctCount).toBe(3);
    expect(profile.samples).toContain(SECRET_SAMPLE);
    expect(profile.sql.every((sql) => !isWriteSql(sql))).toBe(true);
    expect(profile.sql.some((sql) => /LIMIT 50\b/.test(sql))).toBe(true);

    const session = createSession(dir, {
      id: "sess-1",
      warehouse_ref: { type: "postgres", locator: "analytics.example/shop" },
      discovered_snapshot_hash: profile.sampleHash ?? null,
    });
    expect(session.discovered_snapshot_hash).toBe(profile.sampleHash);
    expect(session).not.toHaveProperty("samples");
    expect(session.warehouse_ref).not.toHaveProperty("url");
    expect(session.warehouse_ref).not.toHaveProperty("password");
    expect(session.warehouse_ref).not.toHaveProperty("token");

    const persisted = walkText(join(dir, ".grane"));
    for (const secret of [SECRET_SAMPLE, SECRET_PASSWORD, SECRET_TOKEN, SECRET_URL]) {
      expect(persisted).not.toContain(secret);
    }
    const audit = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.operation).toBe("profile");
    expect(readFileSync(sessionPath(dir, "sess-1"), "utf8")).not.toContain(SECRET_SAMPLE);
  });

  it("skips samples when sampling is off (setup decision)", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: exampleConfig({
        audit: { enabled: true, path: ".grane/audit.jsonl" },
        authoring: { sampling: false, sample_rows: 20 },
      }),
      connector,
      projectDir: dir,
    });
    const profile = await discovery.profileColumn("customers", "status");
    expect(profile.samples).toEqual([]);
    expect(profile.sampleHash).toBeUndefined();
    expect(profile.sql.some((sql) => /COUNT\s*\(\s*DISTINCT/i.test(sql))).toBe(true);
    expect(profile.sql.some((sql) => /\bLIMIT\b/i.test(sql))).toBe(false);
    expect(readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8")).not.toContain(SECRET_SAMPLE);
  });

  it("refuses excluded columns and never queries them", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: exampleConfig({
        audit: { enabled: true, path: ".grane/audit.jsonl" },
        exploration: { enabled: true, mode: "denylist", exclude: ["*.email", "customers.email"] },
      }),
      connector,
      projectDir: dir,
    });
    await expect(discovery.profileColumn("customers", "email")).rejects.toMatchObject({
      refusal: { status: "column_not_permitted" },
    });
    expect(connector.sql).toEqual([]);
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(event.operation).toBe("profile");
    expect(event.refusal).toMatchObject({ status: "column_not_permitted" });
    expect(JSON.stringify(event)).not.toContain(SECRET_SAMPLE);
  });

  it("refuses the discovery call when fail_closed and the audit append fails", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, "blocked"), "not a directory");
    const discovery = createDiscovery({
      config: exampleConfig({
        audit: { enabled: true, path: "blocked/audit.jsonl", fail_closed: true },
      }),
      connector: recordingConnector(),
      projectDir: dir,
    });
    await expect(discovery.introspectSchema()).rejects.toMatchObject({
      refusal: { status: "config_error" },
    });
  });
});
