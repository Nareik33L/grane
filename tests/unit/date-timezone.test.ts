/**
 * DATE / timestamp time-dimension semantics and DuckDB session determinism.
 *
 * A DATE is a civil calendar value. project.timezone must not turn
 * 2026-08-01 into 2026-07-31. Timestamp-like columns still localize.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { getDialect, WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";
import { exampleConfig, exampleSchema } from "../fixtures.js";

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string, opts?: Record<string, string>) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
        runAndReadAll?: (sql: string) => Promise<{ getRowObjectsJS?: () => Record<string, unknown>[] }>;
        closeSync?: () => void;
        disconnectSync?: () => void;
      }>;
      closeSync?: () => void;
    }>;
  };
};

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
const available = await duckdbAvailable();

const TIMEZONES = [
  "UTC",
  "America/New_York",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Berlin",
  "Asia/Tokyo",
  "Australia/Sydney",
] as const;

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

async function buildWarehouse(name: string, ddl: string[]): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), `grane-tz-${name}-`)), "db.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const sql of ddl) await conn.run(sql);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

function kernelAt(path: string, timezone: string): GraneKernel {
  const k = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "tz", timezone },
      connection: { type: "duckdb", path, schema: "main" },
      entities: {
        fact: { table: "t", primary_key: "id" },
        snap: { table: "snapshots", primary_key: "id" },
        order: { table: "orders", primary_key: "id" },
        instant: { table: "instants", primary_key: "id" },
      },
      metrics: {
        total_x: { entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}" },
        ending_bal: {
          entity: "snap", type: "sum", sql: "${snapshots.balance}",
          time_dimension: "${snapshots.as_of}", additive: "semi",
          semi_additive: { window: "last", group_by: ["${snapshots.account_id}"] },
        },
        grouped_ending: {
          entity: "snap", type: "sum", sql: "${snapshots.balance}",
          time_dimension: "${snapshots.as_of}", additive: "semi",
          semi_additive: { window: "last", group_by: ["${snapshots.account_id}"] },
        },
        july_only: {
          entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}",
          filters: { "t.segment": "A" },
        },
        order_amount: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        instant_sum: { entity: "instant", type: "sum", sql: "${instants.x}", time_dimension: "${instants.ts_utc}" },
        naive_sum: { entity: "instant", type: "sum", sql: "${instants.x}", time_dimension: "${instants.ts_naive}" },
      },
      dimensions: {
        segment: { entity: "fact", sql: "${t.segment}" },
        account: { entity: "snap", sql: "${snapshots.account_id}" },
        country: { entity: "order", sql: "${customers.country}" },
      },
      relationships: {
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    }),
  );
  kernels.push(k);
  return k;
}

const FACT_DDL = [
  `CREATE TABLE t (id INTEGER, d DATE, x NUMERIC, segment VARCHAR)`,
  `INSERT INTO t VALUES
     (1, '2026-07-31', 50, 'A'),
     (2, '2026-08-01', 80, 'A'),
     (3, '2026-08-01', 120, 'B'),
     (4, '2026-08-31', 15, 'A'),
     (5, '2026-09-01', 9, 'A'),
     (6, '2025-12-31', 3, 'A'),
     (7, '2026-01-01', 4, 'A'),
     (8, '2026-03-08', 1, 'A'),
     (9, '2026-03-09', 1, 'A'),
     (10, '2026-11-01', 1, 'A')`,
  `CREATE TABLE snapshots (id INTEGER, account_id INTEGER, as_of DATE, balance NUMERIC)`,
  `INSERT INTO snapshots VALUES
     (1, 1, '2026-07-31', 10),
     (2, 1, '2026-08-01', 20),
     (3, 1, '2026-08-15', 30),
     (4, 2, '2026-08-01', 5)`,
  `CREATE TABLE customers (id INTEGER, country VARCHAR)`,
  `INSERT INTO customers VALUES (1, 'US'), (2, 'DE')`,
  `CREATE TABLE orders (id INTEGER, customer_id INTEGER, amount NUMERIC, ordered_at DATE)`,
  `INSERT INTO orders VALUES
     (1, 1, 100, '2026-08-01'),
     (2, 2, 40, '2026-08-01'),
     (3, 1, 7, '2026-07-31')`,
  `CREATE TABLE instants (id INTEGER, ts_utc TIMESTAMPTZ, ts_naive TIMESTAMP, x NUMERIC)`,
  // 04:00 UTC on 1 Aug = midnight in America/New_York (EDT, UTC-4)
  // 03:00 UTC on 1 Aug = 23:00 on 31 Jul in America/New_York
  `INSERT INTO instants VALUES
     (1, TIMESTAMPTZ '2026-08-01 04:00:00+00', TIMESTAMP '2026-08-01 04:00:00', 10),
     (2, TIMESTAMPTZ '2026-08-01 03:00:00+00', TIMESTAMP '2026-08-01 03:00:00', 100)`,
];

describe.skipIf(!available)("DATE civil-date invariant (A1–A13)", () => {
  let path: string;
  beforeAll(async () => {
    path = await buildWarehouse("date", FACT_DDL);
  });

  it("A1: DATE + timezone + one-day filter is 200 in every project timezone", async () => {
    for (const tz of TIMEZONES) {
      const k = kernelAt(path, tz);
      const result = await k.query({ metrics: ["total_x"], time: { from: "2026-08-01", to: "2026-08-01" } });
      expect(result.trust, tz).toBe("governed");
      expect(Number(result.rows[0]!.total_x), tz).toBe(200);
      expect(k.compile({ metrics: ["total_x"], time: { from: "2026-08-01", to: "2026-08-01" } }).compiled.sql).not.toMatch(
        /t"\."d".*AT TIME ZONE/,
      );
    }
  });

  it("A2: DATE + timezone + month filter is 215 (Aug 1+31)", async () => {
    for (const tz of TIMEZONES) {
      const result = await kernelAt(path, tz).query({
        metrics: ["total_x"],
        time: { from: "2026-08-01", to: "2026-08-31" },
      });
      expect(Number(result.rows[0]!.total_x), tz).toBe(215);
    }
  });

  it("A3: DATE + timezone + day grouping keeps civil days", async () => {
    const ny = await kernelAt(path, "America/New_York").query({
      metrics: ["total_x"],
      time: { from: "2026-08-01", to: "2026-08-31", grain: "day" },
    });
    const days = ny.rows.map((r) => String(r.period_day).slice(0, 10));
    expect(days).toContain("2026-08-01");
    expect(days).not.toContain("2026-07-31");
    expect(Number(ny.rows.find((r) => String(r.period_day).startsWith("2026-08-01"))!.total_x)).toBe(200);
  });

  it("A4: DATE + timezone + month grouping keeps August", async () => {
    const tokyo = await kernelAt(path, "Asia/Tokyo").query({
      metrics: ["total_x"],
      time: { from: "2026-07-01", to: "2026-09-30", grain: "month" },
    });
    const byMonth = Object.fromEntries(
      tokyo.rows.map((r) => [String(r.period_month).slice(0, 7), Number(r.total_x)]),
    );
    expect(byMonth["2026-08"]).toBe(215);
    expect(byMonth["2026-07"]).toBe(50);
  });

  it("A5: DATE + semi-additive snapshot is last-as-of the civil range", async () => {
    for (const tz of TIMEZONES) {
      const result = await kernelAt(path, tz).query({
        metrics: ["ending_bal"],
        time: { from: "2026-08-01", to: "2026-08-31" },
      });
      expect(Number(result.rows[0]!.ending_bal), tz).toBe(35);
    }
  });

  it("A6: DATE + joined dimension", async () => {
    const result = await kernelAt(path, "America/New_York").query({
      metrics: ["order_amount"],
      dimensions: ["country"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(result.trust).toBe("governed");
    const byCountry = Object.fromEntries(result.rows.map((r) => [String(r.country), Number(r.order_amount)]));
    expect(byCountry).toEqual({ US: 100, DE: 40 });
  });

  it("A7: DATE + base query filter", async () => {
    const result = await kernelAt(path, "Europe/London").query({
      metrics: ["total_x"],
      filters: [{ field: "segment", operator: "=", value: "A" }],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(Number(result.rows[0]!.total_x)).toBe(80);
  });

  it("A8: DATE + metric-definition filter", async () => {
    const result = await kernelAt(path, "Asia/Tokyo").query({
      metrics: ["july_only"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(Number(result.rows[0]!.july_only)).toBe(80);
  });

  it("A9: DATE + grouped snapshot", async () => {
    const result = await kernelAt(path, "America/Los_Angeles").query({
      metrics: ["grouped_ending"],
      dimensions: ["account"],
      time: { from: "2026-08-01", to: "2026-08-31" },
    });
    const byAcct = Object.fromEntries(result.rows.map((r) => [String(r.account), Number(r.grouped_ending)]));
    expect(byAcct).toEqual({ "1": 30, "2": 5 });
  });

  it("A10: DATE + relationship cardinality guard still refuses a participating duplicate", async () => {
    const dupPath = await buildWarehouse("card", [
      ...FACT_DDL,
      `INSERT INTO customers VALUES (1, 'US-DUP')`,
    ]);
    const k = kernelAt(dupPath, "America/New_York");
    try {
      await k.query({
        metrics: ["order_amount"],
        dimensions: ["country"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
      expect((err as GraneError).refusal.message).toMatch(/customers/);
    }
  });

  it("A11: month and year boundaries stay on the civil DATE", async () => {
    const k = kernelAt(path, "America/New_York");
    const dec = await k.query({ metrics: ["total_x"], time: { from: "2025-12-31", to: "2025-12-31" } });
    const jan = await k.query({ metrics: ["total_x"], time: { from: "2026-01-01", to: "2026-01-01" } });
    expect(Number(dec.rows[0]!.total_x)).toBe(3);
    expect(Number(jan.rows[0]!.total_x)).toBe(4);
  });

  it("A12: DST-adjacent civil dates are not shifted", async () => {
    // US spring-forward 2026-03-08; EU 2026-03-29; US fall-back 2026-11-01.
    const k = kernelAt(path, "America/New_York");
    const spring = await k.query({ metrics: ["total_x"], time: { from: "2026-03-08", to: "2026-03-09" } });
    const fall = await k.query({ metrics: ["total_x"], time: { from: "2026-11-01", to: "2026-11-01" } });
    expect(Number(spring.rows[0]!.total_x)).toBe(2);
    expect(Number(fall.rows[0]!.total_x)).toBe(1);
  });

  it("A13: the seven project timezones agree on every DATE-backed total", async () => {
    const values = [];
    for (const tz of TIMEZONES) {
      const result = await kernelAt(path, tz).query({
        metrics: ["total_x"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      values.push(Number(result.rows[0]!.total_x));
    }
    expect(new Set(values)).toEqual(new Set([200]));
  });
});

describe.skipIf(!available)("A16 timestamp controls remain localized", () => {
  it("timestamptz localizes to project.timezone (NY midnight vs previous evening)", async () => {
    const path = await buildWarehouse("instants", FACT_DDL);
    const nyKernel = kernelAt(path, "America/New_York");
    const ny = await nyKernel.query({
      metrics: ["instant_sum"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    const utc = await kernelAt(path, "UTC").query({
      metrics: ["instant_sum"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(Number(ny.rows[0]!.instant_sum)).toBe(10);
    expect(Number(utc.rows[0]!.instant_sum)).toBe(110);
    const sql = nyKernel.compile({
      metrics: ["instant_sum"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    }).compiled.sql;
    expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(sql).not.toMatch(/ts_utc"\)::date/);
  });

  it("timestamp without time zone is treated as a UTC wall-clock instant", async () => {
    const path = await buildWarehouse("naive", FACT_DDL);
    const ny = await kernelAt(path, "America/New_York").query({
      metrics: ["naive_sum"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(Number(ny.rows[0]!.naive_sum)).toBe(10);
  });

  it("refuses to localize an unknown column type when timezone is not UTC", () => {
    const config = exampleConfig();
    config.project.timezone = "America/New_York";
    const k = new GraneKernel(config);
    k.setSchema({
      schemaName: "public",
      tables: [
        {
          schema: "public",
          name: "orders",
          columns: [{ name: "completed_at", dataType: "varchar", nullable: true }],
        },
      ],
      foreignKeys: [],
    });
    try {
      k.compile({ metrics: ["revenue"], time: { from: "2026-07-01", to: "2026-07-31" } });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
      expect((err as GraneError).refusal.message).toMatch(/unknown|not a known DATE/i);
    }
  });

  it("refuses non-UTC localization when no schema is available", () => {
    const config = exampleConfig();
    config.project.timezone = "America/New_York";
    const k = new GraneKernel(config);
    try {
      k.compile({ metrics: ["revenue"], time: { from: "2026-07-01", to: "2026-07-31" } });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
      expect((err as GraneError).refusal.message).toMatch(/unknown at compile time/);
    }
  });
});

describe.skipIf(!available)("A14 DuckDB host/session timezone determinism", () => {
  it("the old DATE localization shape is session-dependent; civil DATE SQL is not", async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    const results: Record<string, number> = {};
    const civil: Record<string, number> = {};
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      const instance = await mod.DuckDBInstance.create(":memory:", { TimeZone: tz });
      const conn = await instance.connect();
      await conn.run?.(`SET TimeZone = '${tz}'`);
      await conn.run?.(
        `CREATE TABLE t (d DATE, x INTEGER); INSERT INTO t VALUES ('2026-08-01', 80), ('2026-08-01', 120)`,
      );
      const buggy = await conn.runAndReadAll?.(
        `SELECT COALESCE(SUM(x), 0) AS v FROM t
         WHERE (d::timestamptz AT TIME ZONE 'America/New_York') >= TIMESTAMP '2026-08-01'
           AND (d::timestamptz AT TIME ZONE 'America/New_York') < TIMESTAMP '2026-08-02'`,
      );
      const ok = await conn.runAndReadAll?.(
        `SELECT COALESCE(SUM(x), 0) AS v FROM t WHERE d >= DATE '2026-08-01' AND d < DATE '2026-08-02'`,
      );
      results[tz] = Number((buggy?.getRowObjectsJS?.() ?? [])[0]?.v);
      civil[tz] = Number((ok?.getRowObjectsJS?.() ?? [])[0]?.v);
      conn.closeSync?.();
      instance.closeSync?.();
    }
    expect(new Set(Object.values(civil))).toEqual(new Set([200]));
    // At least one session timezone disagrees with another under the old shape.
    expect(new Set(Object.values(results)).size).toBeGreaterThan(1);
  });

  it("the same Grane query/data/config returns 200 under differing host TZ", async () => {
    const path = await buildWarehouse("hosttz", FACT_DDL);
    const values: number[] = [];
    const previous = process.env.TZ;
    try {
      for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
        process.env.TZ = tz;
        const result = await kernelAt(path, "America/New_York").query({
          metrics: ["total_x"],
          time: { from: "2026-08-01", to: "2026-08-01" },
        });
        values.push(Number(result.rows[0]!.total_x));
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
    expect(values).toEqual([200, 200, 200]);
  });
});

describe("compile-only DATE vs timestamp SQL by dialect", () => {
  const dateSchema = {
    schemaName: "public",
    tables: [
      {
        schema: "public",
        name: "orders",
        columns: [
          { name: "completed_at", dataType: "date", nullable: true },
          { name: "net_amount", dataType: "numeric", nullable: true },
          { name: "status", dataType: "text", nullable: true },
          { name: "id", dataType: "integer", nullable: false },
          { name: "customer_id", dataType: "integer", nullable: true },
        ],
      },
      ...exampleSchema().tables.filter((t) => t.name !== "orders"),
    ],
    foreignKeys: [],
  };

  it("DATE time dimensions never emit timezone localization in any dialect", () => {
    for (const type of WAREHOUSE_TYPES) {
      const config = exampleConfig();
      config.project.timezone = "America/New_York";
      config.connection.type = type as WarehouseType;
      if (type === "bigquery") {
        config.connection.project = "acme";
        config.connection.dataset = "analytics";
        config.connection.schema = undefined;
      }
      const k = new GraneKernel(config);
      k.setSchema(dateSchema);
      const sql = k.compile({
        metrics: ["revenue"],
        time: { from: "2026-08-01", to: "2026-08-01", grain: "month" },
      }).compiled.sql;
      expect(sql, type).not.toMatch(/AT TIME ZONE|CONVERT_TIMEZONE|CONVERT_TZ|from_utc_timestamp|DATETIME\(|toTimeZone/);
      expect(sql, type).toMatch(/::date|AS DATE|TO_DATE|toDate|DATE\(/);
    }
  });

  it("timestamptz time dimensions still localize in every dialect", () => {
    for (const type of WAREHOUSE_TYPES) {
      const config = exampleConfig();
      config.project.timezone = "Europe/London";
      config.connection.type = type as WarehouseType;
      if (type === "bigquery") {
        config.connection.project = "acme";
        config.connection.dataset = "analytics";
        config.connection.schema = undefined;
      }
      const k = new GraneKernel(config);
      k.setSchema(exampleSchema());
      const sql = k.compile({
        metrics: ["revenue"],
        time: { from: "2026-07-01", to: "2026-07-31" },
      }).compiled.sql;
      if (type === "postgres" || type === "duckdb") {
        expect(sql, type).toContain("AT TIME ZONE 'Europe/London'");
      } else if (type === "mysql") {
        expect(sql, type).toContain("CONVERT_TZ");
      } else if (type === "snowflake" || type === "redshift") {
        expect(sql, type).toContain("CONVERT_TIMEZONE");
      } else if (type === "bigquery") {
        expect(sql, type).toContain("DATETIME(");
      } else if (type === "databricks") {
        expect(sql, type).toContain("from_utc_timestamp");
      } else if (type === "clickhouse") {
        expect(sql, type).toContain("toTimeZone");
      }
    }
  });

  it("exposes dialect.castDate for every warehouse", () => {
    for (const type of WAREHOUSE_TYPES) {
      expect(getDialect(type).castDate("$1")).toMatch(/date|DATE|toDate|TO_DATE/i);
    }
  });
});
