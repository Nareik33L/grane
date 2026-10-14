import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { getDialect } from "../../src/connectors/dialect.js";
import { isWriteSql, type DatabaseSchema, type ExecutedRows, type WarehouseConnector } from "../../src/connectors/types.js";
import { GraneError } from "../../src/errors.js";
import { exampleConfig } from "../fixtures.js";

const temps: string[] = [];
const SECRET_SAMPLE = "SECRET_SAMPLE_VALUE";

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

describe("discovery sample cap", () => {
  it("clamps requested rows to the hard cap", () => {
    expect(clampDiscoverySampleRows(1)).toBe(1);
    expect(clampDiscoverySampleRows(DISCOVERY_SAMPLE_ROW_HARD_CAP)).toBe(DISCOVERY_SAMPLE_ROW_HARD_CAP);
    expect(clampDiscoverySampleRows(10_000)).toBe(DISCOVERY_SAMPLE_ROW_HARD_CAP);
    expect(clampDiscoverySampleRows(0)).toBe(1);
  });
});

describe("assertDiscoverySql / runDiscoveryQuery", () => {
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
  it("introspects, infers relationships, and emits one discovery line per call", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: exampleConfig({ audit: { enabled: true, path: ".grane/audit.jsonl" } }),
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
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events.map((event) => event.operation)).toEqual(["introspect", "relationships"]);
    for (const event of events) {
      expect(event.kind).toBe("discovery");
      expect(event.read_only).toBe(true);
      expect(event.session_id).toBe("sess-1");
      expect(event).not.toHaveProperty("samples");
      expect(event).not.toHaveProperty("rows");
      expect(event).not.toHaveProperty("values");
    }
  });

  it("profiles distinct counts and samples without logging sampled values", async () => {
    const dir = tempProject();
    const connector = recordingConnector();
    const discovery = createDiscovery({
      config: exampleConfig({
        audit: { enabled: true, path: ".grane/audit.jsonl" },
        exploration: { enabled: true, exclude: [] },
      }),
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
    const raw = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8");
    expect(raw).not.toContain(SECRET_SAMPLE);
    const event = JSON.parse(raw.trim()) as Record<string, unknown>;
    expect(event.operation).toBe("profile");
    expect(event.read_only).toBe(true);
    expect(event).not.toHaveProperty("samples");
    expect(typeof event.snapshot_hash).toBe("string");
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
