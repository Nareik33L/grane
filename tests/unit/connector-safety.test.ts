/**
 * Workstream 2 — connector safety parity.
 *
 * Proves the promises every warehouse adapter must keep: one write guard,
 * timeout wiring, session read-only / UTC where the engine can, empty-result
 * columns, introspected types that classify, and the executed SQL comment.
 * Cloud warehouses are asserted via exported session SQL/settings (no creds).
 */
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { DuckDbConnector } from "../../src/connectors/duckdb.js";
import { PostgresConnector } from "../../src/connectors/postgres/client.js";
import {
  POSTGRES_READ_ONLY_BEGIN,
  POSTGRES_SESSION_UTC,
  postgresStatementTimeoutSql,
} from "../../src/connectors/postgres/client.js";
import {
  MYSQL_SESSION_READONLY,
  MYSQL_SESSION_UTC,
  MysqlConnector,
  mysqlMaxExecutionTimeSql,
  mysqlQueryWithDeadline,
} from "../../src/connectors/mysql.js";
import { clickhouseQuerySettings, ClickHouseConnector } from "../../src/connectors/clickhouse.js";
import { snowflakeSessionSetupSql } from "../../src/connectors/snowflake.js";
import { DATABRICKS_SESSION_UTC, DatabricksConnector, databricksStatementOptions } from "../../src/connectors/databricks.js";
import { BigQueryConnector, bigQueryJobOptions, DEFAULT_BIGQUERY_MAX_BYTES_BILLED } from "../../src/connectors/bigquery.js";
import { duckdbDialect, isNumericType, isTemporalType, WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";
import {
  isWriteSql,
  timeoutSeconds,
  WRITE_KEYWORDS,
  type DatabaseSchema,
  type ExecutedRows,
  type WarehouseConnector,
} from "../../src/connectors/types.js";
import { executeCompiled } from "../../src/execute/executor.js";
import type { CompiledQuery } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { postgresLiveEnv } from "../helpers/postgres-live.js";
import { mysqlLiveEnv } from "../helpers/mysql-live.js";
import { clickhouseLiveEnv } from "../helpers/clickhouse-live.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const CONNECTOR_QUERY_FILES = [
  "src/connectors/postgres/client.ts",
  "src/connectors/mysql.ts",
  "src/connectors/snowflake.ts",
  "src/connectors/bigquery.ts",
  "src/connectors/duckdb.ts",
  "src/connectors/clickhouse.ts",
  "src/connectors/databricks.ts",
  "src/execute/executor.ts",
];

const LOCAL_WRITE_REGEX = /\/\^[^/\n]*(insert\|update\|delete)/i;

const LIMITS = { max_rows: 1000, default_rows: 100, timeout_ms: 30_000 };

const ENGINE_INTROSPECTED_TYPES: Record<WarehouseType, { numeric: string[]; temporal: string[] }> = {
  postgres: {
    numeric: ["integer", "numeric", "double precision", "bigint"],
    temporal: ["date", "timestamp without time zone", "timestamp with time zone"],
  },
  redshift: {
    numeric: ["integer", "numeric", "double precision"],
    temporal: ["date", "timestamp without time zone", "timestamp with time zone"],
  },
  mysql: {
    numeric: ["int", "decimal", "double", "bigint"],
    temporal: ["date", "datetime", "DATETIME", "timestamp"],
  },
  snowflake: {
    numeric: ["NUMBER", "FLOAT", "NUMBER(18,2)"],
    temporal: ["DATE", "TIMESTAMP_NTZ", "TIMESTAMP_TZ", "TIMESTAMP_LTZ"],
  },
  bigquery: {
    numeric: ["INT64", "NUMERIC", "BIGNUMERIC", "FLOAT64"],
    temporal: ["DATE", "DATETIME", "TIMESTAMP"],
  },
  duckdb: {
    numeric: ["INTEGER", "DECIMAL(18,2)", "DOUBLE", "BIGINT"],
    temporal: ["DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE"],
  },
  clickhouse: {
    numeric: ["Int64", "Nullable(Decimal(18,2))", "Float64", "UInt32"],
    temporal: ["Date", "DateTime", "DateTime64(3)", "Nullable(Date)"],
  },
  databricks: {
    numeric: ["INT", "DECIMAL(18,2)", "DOUBLE", "BIGINT"],
    temporal: ["DATE", "TIMESTAMP", "TIMESTAMP_NTZ"],
  },
};

function stubCompiled(sql: string): CompiledQuery {
  return {
    sql,
    params: [],
    plan: {
      baseTable: "orders",
      joins: [],
      preAggregations: [],
      columns: [],
      groupColumns: [],
      population: { analytical: null, contributing: null },
    },
    guards: [],
    metricVersions: {},
    metricSources: {},
    trust: "governed",
    governed: [],
    ungoverned: [],
    warning: null,
    rowLimit: 1000,
    rowLimitSource: "default",
  };
}

class RecordingConnector implements WarehouseConnector {
  lastSql = "";
  readonly type = "duckdb" as const;
  readonly dialect = duckdbDialect;
  async query(sql: string): Promise<ExecutedRows> {
    this.lastSql = sql;
    return { columns: ["v"], rows: [{ v: 1 }] };
  }
  async introspect(): Promise<DatabaseSchema> {
    return { schemaName: "main", tables: [], foreignKeys: [] };
  }
  async close(): Promise<void> {}
}

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}

describe("single write guard", () => {
  it("exports one WRITE_KEYWORDS list", () => {
    expect(WRITE_KEYWORDS.test("INSERT INTO t VALUES (1)")).toBe(true);
    expect(isWriteSql("SELECT 1")).toBe(false);
  });

  it("every connector and the executor import isWriteSql from types.ts", () => {
    for (const rel of CONNECTOR_QUERY_FILES) {
      const src = readFileSync(join(repoRoot, rel), "utf8");
      expect(src, rel).toMatch(/\bisWriteSql\b/);
      expect(src, rel).toMatch(/types\.js/);
      if (rel !== "src/connectors/types.ts") {
        expect(src, rel).not.toMatch(LOCAL_WRITE_REGEX);
        expect(src, rel).not.toMatch(/\bWRITE_KEYWORDS\s*=/);
      }
    }
  });

  it("no other src/connectors file defines a write-keyword regex", () => {
    const dir = join(repoRoot, "src/connectors");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const name of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, name.name);
        if (name.isDirectory()) walk(p);
        else if (name.name.endsWith(".ts")) files.push(p);
      }
    };
    walk(dir);
    for (const file of files) {
      if (file.endsWith(`${join("connectors", "types.ts")}`)) continue;
      const src = readFileSync(file, "utf8");
      expect(src, file).not.toMatch(LOCAL_WRITE_REGEX);
    }
  });
});

describe("timeout / read-only / UTC session SQL (no cloud creds)", () => {
  it("Postgres/Redshift wrap in READ ONLY + statement_timeout + UTC", () => {
    expect(POSTGRES_READ_ONLY_BEGIN).toBe("BEGIN TRANSACTION READ ONLY");
    expect(postgresStatementTimeoutSql(1500)).toBe("SET LOCAL statement_timeout = 1500");
    expect(POSTGRES_SESSION_UTC).toBe("SET LOCAL TIME ZONE 'UTC'");
  });

  it("MySQL pins read-only, UTC, and max_execution_time", () => {
    expect(MYSQL_SESSION_READONLY).toBe("SET SESSION TRANSACTION READ ONLY");
    expect(MYSQL_SESSION_UTC).toBe("SET time_zone = '+00:00'");
    expect(mysqlMaxExecutionTimeSql(2500)).toBe("SET SESSION max_execution_time = 2500");
  });

  it("MySQL client deadline rejects and destroys when the query hangs", async () => {
    let destroyed = false;
    const hang = new Promise<never>(() => undefined);
    await expect(mysqlQueryWithDeadline(hang, 40, () => {
      destroyed = true;
    })).rejects.toThrow(/timeout_ms/);
    expect(destroyed).toBe(true);
  });

  it("ClickHouse sets timeout, readonly, join_use_nulls, UTC, and empty-agg NULL", () => {
    expect(clickhouseQuerySettings(1500)).toEqual({
      max_execution_time: timeoutSeconds(1500),
      readonly: "1",
      join_use_nulls: "1",
      session_timezone: "UTC",
      aggregate_functions_null_for_empty: 1,
      output_format_json_quote_64bit_integers: 1,
    });
  });

  it("Snowflake sets statement timeout, TIMEZONE UTC, and QUERY_TAG", () => {
    const setup = snowflakeSessionSetupSql(1500);
    expect(setup.combined).toBe(
      "ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS = 2, TIMEZONE = 'UTC', QUERY_TAG = 'grane'",
    );
    expect(setup.timeoutOnly).toContain("STATEMENT_TIMEOUT_IN_SECONDS = 2");
    expect(setup.timezoneOnly).toBe("ALTER SESSION SET TIMEZONE = 'UTC'");
    expect(setup.queryTagOnly).toBe("ALTER SESSION SET QUERY_TAG = 'grane'");
  });

  it("Databricks pins SET TIME ZONE UTC and uses queryTimeout seconds", () => {
    expect(DATABRICKS_SESSION_UTC).toBe("SET TIME ZONE 'UTC'");
    expect(timeoutSeconds(1500)).toBe(2);
  });
});

describe("executed SQL attribution comment", () => {
  it("executeCompiled prefixes the statement the connector receives", async () => {
    const connector = new RecordingConnector();
    const result = await executeCompiled(connector, stubCompiled("SELECT 1 AS v"), LIMITS, {
      agentId: "finance",
      queryId: "q_deadbeefcafe",
    });
    expect(connector.lastSql).toBe("/* grane query_id=q_deadbeefcafe agent=finance */\nSELECT 1 AS v");
    expect(result.provenance.generated_sql).toBe(connector.lastSql);
  });

  it("refuses a write before the connector is invoked", async () => {
    const connector = new RecordingConnector();
    await expect(executeCompiled(connector, stubCompiled("INSERT INTO t VALUES (1)"), LIMITS)).rejects.toBeInstanceOf(
      GraneError,
    );
    expect(connector.lastSql).toBe("");
  });
});

describe("BigQuery empty-result columns", () => {
  it("reads column names from getQueryResults apiResponse, not job.metadata", async () => {
    const job = {
      metadata: {},
      getQueryResults: async () =>
        [
          [],
          null,
          { schema: { fields: [{ name: "revenue" }, { name: "country" }] } },
        ] as [Record<string, unknown>[], unknown, { schema: { fields: { name: string }[] } }],
    };
    let captured: Record<string, unknown> | undefined;
    const client = {
      createQueryJob: async (opts: Record<string, unknown>) => {
        captured = opts;
        return [job];
      },
      query: async () => {
        throw new Error("query() must not be used when createQueryJob exists");
      },
    };
    const connector = new BigQueryConnector(
      { type: "bigquery", project: "acme", dataset: "analytics" },
      client,
    );
    const result = await connector.query("SELECT 1 AS revenue, 'x' AS country LIMIT 0", [], LIMITS);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["revenue", "country"]);
    expect(captured?.jobTimeoutMs).toBe(LIMITS.timeout_ms);
    expect(captured?.maximumBytesBilled).toBe(String(DEFAULT_BIGQUERY_MAX_BYTES_BILLED));
  });

  it("wires maximumBytesBilled from limits.max_bytes_billed", () => {
    const opts = bigQueryJobOptions("SELECT 1", {}, { ...LIMITS, max_bytes_billed: 123456 }, "EU");
    expect(opts.jobTimeoutMs).toBe(LIMITS.timeout_ms);
    expect(opts.maximumBytesBilled).toBe("123456");
    expect(opts.location).toBe("EU");
  });
});

describe("Databricks queryTimeout from limits", () => {
  it("exports queryTimeout seconds from timeout_ms", () => {
    expect(databricksStatementOptions([], 1500)).toEqual({ runAsync: true, queryTimeout: 2 });
    expect(databricksStatementOptions(["x"], 30_000).ordinalParameters).toEqual(["x"]);
  });

  it("passes queryTimeout on executeStatement", async () => {
    const calls: { sql: string; opts: Record<string, unknown> }[] = [];
    const session = {
      executeStatement: async (sql: string, opts?: Record<string, unknown>) => {
        calls.push({ sql, opts: opts ?? {} });
        return {
          fetchAll: async () => [{ v: 1 }],
          getSchema: async () => ({ columns: [{ name: "v" }] }),
          close: async () => undefined,
        };
      },
      close: async () => undefined,
    };
    const connector = new DatabricksConnector(
      { type: "databricks", host: "example.cloud.databricks.com", http_path: "/sql/1.0/warehouses/x", token: "t" },
      session,
    );
    await connector.query("SELECT 1 AS v", [], { ...LIMITS, timeout_ms: 1500 });
    const select = calls.find((c) => c.sql.startsWith("SELECT"));
    expect(select?.opts.queryTimeout).toBe(2);
  });
});

describe("introspected warehouse type names classify", () => {
  it("covers every engine", () => {
    expect(Object.keys(ENGINE_INTROSPECTED_TYPES).sort()).toEqual([...WAREHOUSE_TYPES].sort());
  });

  it("isNumericType / isTemporalType accept each engine's names", () => {
    for (const [engine, names] of Object.entries(ENGINE_INTROSPECTED_TYPES)) {
      for (const type of names.numeric) {
        expect(isNumericType(type), `${engine} numeric ${type}`).toBe(true);
        expect(isTemporalType(type), `${engine} numeric is not temporal ${type}`).toBe(false);
      }
      for (const type of names.temporal) {
        expect(isTemporalType(type), `${engine} temporal ${type}`).toBe(true);
      }
    }
  });
});

const duckOk = await duckdbAvailable();

describe.skipIf(!duckOk)("DuckDB connector safety", () => {
  const connectors: DuckDbConnector[] = [];

  afterAll(async () => {
    for (const c of connectors) await c.close();
  });

  it("refuses a write before touching the engine", async () => {
    const c = new DuckDbConnector({ type: "duckdb", path: ":memory:", schema: "main" });
    connectors.push(c);
    await expect(c.query("INSERT INTO t VALUES (1)", [], LIMITS)).rejects.toMatchObject({
      refusal: { status: "unsafe_query" },
    });
  });

  it("cancels a deliberately slow query via timeout_ms", async () => {
    const c = new DuckDbConnector({ type: "duckdb", path: ":memory:", schema: "main" });
    connectors.push(c);
    const started = Date.now();
    await expect(
      c.query("SELECT sum(i) AS v FROM range(10000000000) t(i)", [], { ...LIMITS, timeout_ms: 250 }),
    ).rejects.toThrow(/timeout_ms/);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("returns column names on an empty result", async () => {
    const c = new DuckDbConnector({ type: "duckdb", path: ":memory:", schema: "main" });
    connectors.push(c);
    const result = await c.query("SELECT 1 AS revenue, 'x' AS country WHERE FALSE", [], LIMITS);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["revenue", "country"]);
  });

  it("pins session timezone to UTC and does not leak", async () => {
    const c = new DuckDbConnector({ type: "duckdb", path: ":memory:", schema: "main" });
    connectors.push(c);
    await c.query("SET TimeZone = 'America/New_York'", [], LIMITS);
    const result = await c.query("SELECT current_setting('TimeZone') AS tz", [], LIMITS);
    expect(String(result.rows[0]?.tz).toUpperCase()).toBe("UTC");
  });

  it("opens file databases READ_ONLY and introspects classifiable types", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-cs-"));
    const path = join(dir, "w.duckdb");
    const mod = (await import("@duckdb/node-api")) as {
      DuckDBInstance: { create: (path: string) => Promise<{ connect: () => Promise<{
        runAndReadAll: (sql: string) => Promise<unknown>;
        closeSync?: () => void;
      }> }> };
    };
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.runAndReadAll(`CREATE TABLE type_probe (
      n DECIMAL(18,2), ni INTEGER, d DATE, ts TIMESTAMP, tstz TIMESTAMPTZ
    )`);
    conn.closeSync?.();

    const c = new DuckDbConnector({ type: "duckdb", path, schema: "main" });
    connectors.push(c);
    const mode = await c.query("SELECT current_setting('access_mode') AS m", [], LIMITS);
    expect(String(mode.rows[0]?.m).toLowerCase()).toMatch(/read_only/);
    const schema = await c.introspect();
    const probe = schema.tables.find((t) => t.name === "type_probe");
    expect(probe).toBeTruthy();
    const byName = Object.fromEntries((probe?.columns ?? []).map((col) => [col.name, col.dataType]));
    expect(isNumericType(byName.n ?? "")).toBe(true);
    expect(isNumericType(byName.ni ?? "")).toBe(true);
    expect(isTemporalType(byName.d ?? "")).toBe(true);
    expect(isTemporalType(byName.ts ?? "")).toBe(true);
    expect(isTemporalType(byName.tstz ?? "")).toBe(true);
  });
});

const pgEnv = await postgresLiveEnv();

describe.skipIf(!pgEnv)("Postgres connector safety", () => {
  const connectors: PostgresConnector[] = [];

  afterAll(async () => {
    for (const c of connectors) await c.close();
  });

  function live(): PostgresConnector {
    const c = new PostgresConnector({ type: "postgres", url: pgEnv!.writeUrl, schema: "public" });
    connectors.push(c);
    return c;
  }

  it("cancels pg_sleep via statement_timeout", async () => {
    const c = live();
    const started = Date.now();
    await expect(c.query("SELECT pg_sleep(8)", [], { ...LIMITS, timeout_ms: 400 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("refuses a write before the engine", async () => {
    const c = live();
    await expect(c.query("INSERT INTO pg_catalog.pg_class VALUES (1)", [], LIMITS)).rejects.toMatchObject({
      refusal: { status: "unsafe_query" },
    });
  });

  it("runs inside a READ ONLY UTC transaction", async () => {
    const c = live();
    const result = await c.query(
      "SELECT current_setting('transaction_read_only') AS ro, current_setting('TimeZone') AS tz",
      [],
      LIMITS,
    );
    expect(String(result.rows[0]?.ro).toLowerCase()).toMatch(/on|true|1/);
    expect(String(result.rows[0]?.tz).toUpperCase()).toBe("UTC");
  });

  it("returns column names on an empty result", async () => {
    const c = live();
    const result = await c.query("SELECT 1 AS revenue, 'x' AS country WHERE FALSE", [], LIMITS);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["revenue", "country"]);
  });
});

const mysqlEnv = await mysqlLiveEnv();

describe.skipIf(!mysqlEnv)("MySQL connector safety", () => {
  const connectors: MysqlConnector[] = [];

  afterAll(async () => {
    for (const c of connectors) await c.close();
  });

  function live(): MysqlConnector {
    const c = new MysqlConnector({ type: "mysql", url: mysqlEnv!.writeUrl, schema: "grane_demo" });
    connectors.push(c);
    return c;
  }

  it("refuses a write before the engine", async () => {
    const c = live();
    await expect(c.query("INSERT INTO t VALUES (1)", [], LIMITS)).rejects.toMatchObject({
      refusal: { status: "unsafe_query" },
    });
  });

  it("runs with SESSION TRANSACTION READ ONLY and UTC", async () => {
    const c = live();
    const result = await c.query(
      "SELECT @@session.transaction_read_only AS ro, @@session.time_zone AS tz",
      [],
      LIMITS,
    );
    expect(String(result.rows[0]?.ro).toLowerCase()).toMatch(/on|true|1/);
    expect(String(result.rows[0]?.tz)).toBe("+00:00");
  });

  it("returns column names on an empty result", async () => {
    const c = live();
    const result = await c.query("SELECT 1 AS revenue, 'x' AS country WHERE FALSE", [], LIMITS);
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["revenue", "country"]);
  });

  it("cancels a long-running SELECT via timeout_ms", async () => {
    const c = live();
    const started = Date.now();
    // SLEEP() interrupted by max_execution_time returns 1 and the statement
    // succeeds (MySQL 8.4). BENCHMARK is aborted with ER_QUERY_TIMEOUT; the
    // client deadline also destroys the socket.
    await expect(
      c.query("SELECT BENCHMARK(2000000000, SHA2('grane-timeout', 256)) AS s", [], {
        ...LIMITS,
        timeout_ms: 400,
      }),
    ).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("round-trips utf8mb4 (café) and DECIMAL as a string or number, not a binary buffer", async () => {
    const c = live();
    const result = await c.query("SELECT 'café' AS t, CAST('12.50' AS DECIMAL(18,2)) AS n", [], LIMITS);
    expect(result.rows[0]?.t).toBe("café");
    const n = result.rows[0]?.n;
    expect(n === "12.50" || n === 12.5 || n === "12.5").toBe(true);
    expect(Buffer.isBuffer(n)).toBe(false);
  });
});

const chEnv = await clickhouseLiveEnv();

describe.skipIf(!chEnv)("ClickHouse connector safety", () => {
  const connectors: ClickHouseConnector[] = [];

  afterAll(async () => {
    for (const c of connectors) await c.close();
  });

  function live(): ClickHouseConnector {
    const c = new ClickHouseConnector({ type: "clickhouse", url: chEnv!.url, schema: "default" });
    connectors.push(c);
    return c;
  }

  it("refuses a write before the engine", async () => {
    const c = live();
    await expect(c.query("INSERT INTO t VALUES (1)", [], LIMITS)).rejects.toMatchObject({
      refusal: { status: "unsafe_query" },
    });
  });

  it("pins readonly, UTC, and join_use_nulls so unmatched LEFT JOIN is NULL not 0/''", async () => {
    const c = live();
    const result = await c.query(
      `SELECT timezone() AS tz,
              r.name AS name
       FROM (SELECT toUInt8(1) AS id) AS a
       LEFT JOIN (SELECT toUInt8(2) AS id, 'x' AS name) AS r ON a.id = r.id`,
      [],
      LIMITS,
    );
    expect(String(result.rows[0]?.tz).toUpperCase()).toBe("UTC");
    expect(result.rows[0]?.name).toBeNull();
  });

  it("returns column names on an empty result", async () => {
    const c = live();
    const result = await c.query(
      "SELECT 1 AS revenue, 'x' AS country FROM system.one WHERE 0",
      [],
      LIMITS,
    );
    expect(result.rows).toEqual([]);
    expect(result.columns).toEqual(["revenue", "country"]);
  });

  it("cancels sleep via timeout_ms", async () => {
    const c = live();
    const started = Date.now();
    await expect(c.query("SELECT sleep(2) AS s", [], { ...LIMITS, timeout_ms: 400 })).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
