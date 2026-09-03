/**
 * project.week.starts determines civil week-bucket boundaries.
 *
 * monday: [Monday, next Monday)
 * sunday: [Sunday, next Sunday)
 *
 * DATE is not shifted by project.timezone. Timestamps use the existing
 * localized civil date, then the configured week start.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graneConfigSchema, type WeekStarts } from "../../src/config/schema.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleKernel } from "../fixtures.js";
import { getDialect, WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";

function civilKey(value: unknown): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const s = String(value);
  return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : s;
}

function compileWeek(type: WarehouseType, starts: WeekStarts) {
  const kernel = exampleKernel();
  kernel.config.connection.type = type;
  kernel.config.project.week = { starts };
  if (type === "bigquery") {
    kernel.config.connection.project = "acme";
    kernel.config.connection.dataset = "analytics";
    kernel.config.connection.schema = undefined;
  }
  if (type === "mysql") kernel.config.connection.schema = "shop";
  if (type === "duckdb") kernel.config.connection.schema = "main";
  if (type === "databricks") {
    kernel.config.connection.catalog = "main";
    kernel.config.connection.schema = "analytics";
  }
  return kernel.compile({
    metrics: ["revenue"],
    time: { from: "2026-08-01", to: "2026-09-30", grain: "week" },
  }).compiled;
}

describe("week.starts compile-inspect", () => {
  const markers: Record<WarehouseType, { monday: RegExp; sunday: RegExp }> = {
    postgres: { monday: /\+ 6\) % 7/, sunday: /EXTRACT\(DOW FROM/ },
    duckdb: { monday: /\+ 6\) % 7/, sunday: /EXTRACT\(DOW FROM/ },
    redshift: { monday: /\+ 6\) % 7/, sunday: /EXTRACT\(DOW FROM/ },
    mysql: { monday: /WEEKDAY\(/, sunday: /DAYOFWEEK\(/ },
    snowflake: { monday: /1 - DAYOFWEEKISO/, sunday: /MOD\(DAYOFWEEKISO/ },
    bigquery: { monday: /WEEK\(MONDAY\)/, sunday: /WEEK\(SUNDAY\)/ },
    databricks: { monday: /dayofweek\(.+\) \+ 5/, sunday: /dayofweek\(.+\) - 1/ },
    clickhouse: { monday: /toStartOfWeek\(.+, 1\)/, sunday: /toStartOfWeek\(.+, 0\)/ },
  };

  for (const type of WAREHOUSE_TYPES) {
    it(`${type}: monday and sunday emit different deterministic week SQL`, () => {
      const mon = compileWeek(type, "monday");
      const sun = compileWeek(type, "sunday");
      expect(mon.sql).not.toBe(sun.sql);
      expect(mon.sql).toMatch(markers[type].monday);
      expect(sun.sql).toMatch(markers[type].sunday);
      expect(mon.sql).not.toMatch(/date_trunc\('week'/i);
      expect(sun.sql).not.toMatch(/date_trunc\('week'/i);
    });
  }

  it("day/month/quarter/year grains ignore week.starts", () => {
    for (const grain of ["day", "month", "quarter", "year"] as const) {
      const a = exampleKernel();
      const b = exampleKernel();
      b.config.project.week = { starts: "sunday" };
      const qa = { metrics: ["revenue"] as string[], time: { from: "2026-08-01", to: "2026-08-31", grain } };
      expect(a.compile(qa).compiled.sql).toBe(b.compile(qa).compiled.sql);
    }
  });

  it("dialect.dateTrunc week is explicit for both starts", () => {
    for (const type of WAREHOUSE_TYPES) {
      const d = getDialect(type);
      const mon = d.dateTrunc("week", '"d"', "date", "monday");
      const sun = d.dateTrunc("week", '"d"', "date", "sunday");
      expect(mon, type).not.toBe(sun);
      expect(mon, type).toMatch(markers[type].monday);
      expect(sun, type).toMatch(markers[type].sunday);
    }
  });
});

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string, opts?: Record<string, string>) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
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
const duckdbOk = await duckdbAvailable();

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

describe.skipIf(!duckdbOk)("week.starts executed matrix (DuckDB)", () => {
  let path: string;
  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-week-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE t (
        id INTEGER,
        d DATE,
        x NUMERIC,
        segment VARCHAR,
        store_id INTEGER
      );
      CREATE TABLE stores (id INTEGER, country VARCHAR);
      INSERT INTO stores VALUES (1, 'US'), (2, 'DE');
      INSERT INTO t VALUES
        (1,  DATE '2026-08-29', 1,    'A', 1),
        (2,  DATE '2026-08-30', 2,    'A', 1),
        (3,  DATE '2026-08-31', 4,    'A', 1),
        (4,  DATE '2026-09-01', 8,    'A', 1),
        (5,  DATE '2026-09-05', 16,   'A', 1),
        (6,  DATE '2026-09-06', 32,   'B', 1),
        (7,  DATE '2026-09-07', 64,   'A', 2),
        (10, DATE '2025-12-28', 100,  'A', 1),
        (11, DATE '2025-12-29', 200,  'A', 1),
        (12, DATE '2025-12-31', 400,  'A', 1),
        (13, DATE '2026-01-01', 800,  'A', 1),
        (14, DATE '2026-01-03', 1600, 'A', 1),
        (15, DATE '2026-01-04', 3200, 'A', 1),
        (16, DATE '2026-01-05', 6400, 'A', 1);
      CREATE TABLE instants (id INTEGER, ts TIMESTAMPTZ, x NUMERIC);
      INSERT INTO instants VALUES
        (1, TIMESTAMPTZ '2026-08-31 02:00:00+00', 1000),
        (2, TIMESTAMPTZ '2026-08-31 10:00:00+00', 2000),
        (3, TIMESTAMPTZ '2026-08-30 04:00:00+00', 4000),
        (4, TIMESTAMPTZ '2026-08-30 16:00:00+00', 8000);
    `);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  function kernel(starts: WeekStarts, timezone = "UTC"): GraneKernel {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "week-starts", timezone, week: { starts } },
        connection: { type: "duckdb", path, schema: "main" },
        entities: {
          fact: { table: "t", primary_key: "id" },
          instant: { table: "instants", primary_key: "id" },
        },
        metrics: {
          total_x: { entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}" },
          n_rows: { entity: "fact", type: "count", sql: "${t.id}", time_dimension: "${t.d}" },
          a_only: {
            entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}",
            filters: { "t.segment": "A" },
          },
          x_per_row: { entity: "fact", type: "ratio", numerator: "total_x", denominator: "n_rows" },
          instant_sum: { entity: "instant", type: "sum", sql: "${instants.x}", time_dimension: "${instants.ts}" },
        },
        dimensions: {
          segment: { entity: "fact", sql: "${t.segment}" },
          country: { entity: "fact", sql: "${stores.country}" },
        },
        relationships: {
          t_stores: { from: "t.store_id", to: "stores.id", type: "many_to_one" },
        },
      }),
    );
    kernels.push(k);
    return k;
  }

  async function buckets(
    starts: WeekStarts,
    from: string,
    to: string,
    timezone = "UTC",
    extra: Record<string, unknown> = {},
  ) {
    const k = kernel(starts, timezone);
    const query = {
      metrics: ["total_x"],
      time: { from, to, grain: "week" as const },
      ...extra,
    };
    const result = await k.query(query);
    expect(result.trust).toBe("governed");
    const map = Object.fromEntries(
      result.rows.map((r) => [civilKey(r.period_week), Number(r.total_x)]),
    );
    const sql = k.compile(query).compiled.sql;
    expect(sql).not.toMatch(/AT TIME ZONE/);
    return { map, result, sql, k };
  }

  it("W1: DATE + monday", async () => {
    const { map } = await buckets("monday", "2026-08-29", "2026-09-07");
    expect(map).toEqual({ "2026-08-24": 3, "2026-08-31": 60, "2026-09-07": 64 });
  });

  it("W2: DATE + sunday", async () => {
    const { map } = await buckets("sunday", "2026-08-29", "2026-09-07");
    expect(map).toEqual({ "2026-08-23": 1, "2026-08-30": 30, "2026-09-06": 96 });
  });

  it("W3: monday and sunday produce different buckets", async () => {
    const mon = await buckets("monday", "2026-08-29", "2026-09-07");
    const sun = await buckets("sunday", "2026-08-29", "2026-09-07");
    expect(mon.map).not.toEqual(sun.map);
    expect(Object.keys(mon.map).sort()).not.toEqual(Object.keys(sun.map).sort());
  });

  it("W4–W6: DATE week membership is invariant under timezone", async () => {
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      const mon = await buckets("monday", "2026-08-29", "2026-09-07", tz);
      const sun = await buckets("sunday", "2026-08-29", "2026-09-07", tz);
      expect(mon.map, `monday ${tz}`).toEqual({ "2026-08-24": 3, "2026-08-31": 60, "2026-09-07": 64 });
      expect(sun.map, `sunday ${tz}`).toEqual({ "2026-08-23": 1, "2026-08-30": 30, "2026-09-06": 96 });
    }
  });

  async function instantBuckets(starts: WeekStarts, timezone: string) {
    const k = kernel(starts, timezone);
    const query = {
      metrics: ["instant_sum"],
      time: { from: "2026-08-29", to: "2026-09-01", grain: "week" as const },
    };
    const result = await k.query(query);
    expect(result.trust).toBe("governed");
    return Object.fromEntries(result.rows.map((r) => [civilKey(r.period_week), Number(r.instant_sum)]));
  }

  it("W7: timestamp + monday in UTC", async () => {
    // UTC civil: 08-30 Sun (4000+8000), 08-31 Mon 02:00Z+10:00Z (1000+2000)
    expect(await instantBuckets("monday", "UTC")).toEqual({
      "2026-08-24": 12000,
      "2026-08-31": 3000,
    });
  });

  it("W8: timestamp + sunday in UTC", async () => {
    expect(await instantBuckets("sunday", "UTC")).toEqual({
      "2026-08-30": 15000,
    });
  });

  it("W9/W10: timestamp + America/New_York (UTC Monday can be local Sunday)", async () => {
    // EDT = UTC-4. 08-31 02:00Z = 08-30 22:00 EDT Sunday → 1000
    // 08-31 10:00Z = 08-31 06:00 EDT Monday → 2000
    // 08-30 04:00Z = 08-30 00:00 EDT Sunday → 4000
    // 08-30 16:00Z = 08-30 12:00 EDT Sunday → 8000
    expect(await instantBuckets("monday", "America/New_York")).toEqual({
      "2026-08-24": 13000,
      "2026-08-31": 2000,
    });
    expect(await instantBuckets("sunday", "America/New_York")).toEqual({
      "2026-08-30": 15000,
    });
  });

  it("W11: timestamp + Asia/Tokyo (UTC Sunday can be local Monday)", async () => {
    // JST UTC+9
    // 08-31 04:00Z = 08-31 13:00 JST Monday → 1000
    // 08-31 10:00Z = 08-31 19:00 JST Monday → 2000
    // 08-30 04:00Z = 08-30 13:00 JST Sunday → 4000
    // 08-30 16:00Z = 08-31 01:00 JST Monday → 8000
    // Local: Sun 08-30: 4000; Mon 08-31: 1000+2000+8000=11000
    expect(await instantBuckets("monday", "Asia/Tokyo")).toEqual({
      "2026-08-24": 4000,
      "2026-08-31": 11000,
    });
    expect(await instantBuckets("sunday", "Asia/Tokyo")).toEqual({
      "2026-08-30": 15000,
    });
  });

  it("W12: week grain + metric filter", async () => {
    const k = kernel("monday");
    const result = await k.query({
      metrics: ["a_only"],
      time: { from: "2026-08-29", to: "2026-09-07", grain: "week" },
    });
    expect(result.trust).toBe("governed");
    const map = Object.fromEntries(result.rows.map((r) => [civilKey(r.period_week), Number(r.a_only)]));
    // segment B (32 on 2026-09-06) excluded from the 08-31 bucket: 60-32=28
    expect(map).toEqual({ "2026-08-24": 3, "2026-08-31": 28, "2026-09-07": 64 });
  });

  it("W13: week grain + query filter", async () => {
    const { map } = await buckets("sunday", "2026-08-29", "2026-09-07", "UTC", {
      filters: [{ field: "segment", operator: "=", value: "B" }],
    });
    expect(map).toEqual({ "2026-09-06": 32 });
  });

  it("W14: week grain + joined dimension", async () => {
    const k = kernel("monday");
    const result = await k.query({
      metrics: ["total_x"],
      dimensions: ["country"],
      time: { from: "2026-08-29", to: "2026-09-07", grain: "week" },
    });
    expect(result.trust).toBe("governed");
    const by = result.rows.map((r) => `${civilKey(r.period_week)}|${r.country}|${Number(r.total_x)}`).sort();
    expect(by).toEqual([
      "2026-08-24|US|3",
      "2026-08-31|US|60",
      "2026-09-07|DE|64",
    ]);
  });

  it("W15: week grain + ratio", async () => {
    const k = kernel("monday");
    const result = await k.query({
      metrics: ["x_per_row"],
      time: { from: "2026-08-29", to: "2026-09-07", grain: "week" },
    });
    expect(result.trust).toBe("governed");
    const map = Object.fromEntries(
      result.rows.map((r) => [civilKey(r.period_week), Number(r.x_per_row)]),
    );
    expect(map["2026-08-24"]).toBe(1.5);
    expect(map["2026-08-31"]).toBe(15);
    expect(map["2026-09-07"]).toBe(64);
  });

  it("W16: multiple weeks present", async () => {
    const { map } = await buckets("monday", "2026-08-29", "2026-09-07");
    expect(Object.keys(map)).toHaveLength(3);
  });

  it("W17: month boundary Sat 08-29 / Tue 09-01 stay in their week", async () => {
    const mon = await buckets("monday", "2026-08-29", "2026-09-01");
    expect(mon.map).toEqual({ "2026-08-24": 3, "2026-08-31": 12 });
    const sun = await buckets("sunday", "2026-08-29", "2026-09-01");
    expect(sun.map).toEqual({ "2026-08-23": 1, "2026-08-30": 14 });
  });

  it("W18: year boundary Dec 2025 / Jan 2026", async () => {
    const mon = await buckets("monday", "2025-12-28", "2026-01-05");
    expect(mon.map).toEqual({ "2025-12-22": 100, "2025-12-29": 6200, "2026-01-05": 6400 });
    const sun = await buckets("sunday", "2025-12-28", "2026-01-05");
    expect(sun.map).toEqual({ "2025-12-28": 3100, "2026-01-04": 9600 });
  });
});
