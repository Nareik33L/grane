/**
 * Semi-additive series-key proof (H1–H10).
 *
 * Grane can prove a key is the metric entity's declared grain (primary_key).
 * It cannot prove temporal stability from a relationship or from current-data
 * cardinality. Explicit non-PK group_by is the native YAML series declaration.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { vacuousSnapshotSeriesKeys } from "../../src/model/model.js";

/**
 * Independently chosen history:
 *   C1 Jan 100 / Feb 120 / Mar 80
 *   C2 Jan 130 / Feb 150
 *   C3 Feb  30 / Mar 120
 *   SUM=730  global last=200  global first=230
 *   per-customer last=350  per-customer first=260
 */
const DDL = `
  CREATE TABLE snapshots (
    snapshot_row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION,
    segment VARCHAR,
    region VARCHAR
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-01', 100, 'ent', 'US'),
    (2, 1, DATE '2026-02-01', 120, 'ent', 'US'),
    (3, 1, DATE '2026-03-01',  80, 'smb', 'US'),
    (4, 2, DATE '2026-01-01', 130, 'smb', 'DE'),
    (5, 2, DATE '2026-02-01', 150, 'smb', 'DE'),
    (6, 3, DATE '2026-02-01',  30, 'ent', 'UK'),
    (7, 3, DATE '2026-03-01', 120, 'ent', 'UK');
  CREATE TABLE dim_customers (customer_id INTEGER PRIMARY KEY, country VARCHAR);
  INSERT INTO dim_customers VALUES (1, 'US'), (2, 'DE'), (3, 'UK');
  CREATE TABLE dim_rows (snapshot_row_id INTEGER PRIMARY KEY, note VARCHAR);
  INSERT INTO dim_rows VALUES
    (1, 'r1'), (2, 'r2'), (3, 'r3'), (4, 'r4'), (5, 'r5'), (6, 'r6'), (7, 'r7');
  CREATE TABLE dim_obs (obs_id INTEGER PRIMARY KEY, label VARCHAR);
  INSERT INTO dim_obs VALUES
    (1, 'o1'), (2, 'o2'), (3, 'o3'), (4, 'o4'), (5, 'o5'), (6, 'o6'), (7, 'o7');
  CREATE TABLE dim_unreachable (id INTEGER PRIMARY KEY, label VARCHAR);
  INSERT INTO dim_unreachable VALUES (99, 'none');
  CREATE TABLE dim_dup_customers (customer_id INTEGER, country VARCHAR);
  INSERT INTO dim_dup_customers VALUES (1, 'US'), (1, 'US');
`;

const HISTORY = 730;
const GLOBAL_LAST = 200;
const GLOBAL_FIRST = 230;
const CUSTOMER_LAST = 350;
const CUSTOMER_FIRST = 260;
const Q1 = { from: "2026-01-01", to: "2026-03-31" };

function semi(
  entity: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entity,
    type: "sum",
    sql: "${snapshots.balance}",
    time_dimension: "${snapshots.snapshot_date}",
    additive: "semi",
    ...extra,
  };
}

function metrics(): Record<string, unknown> {
  return {
    // H10
    h10_last: semi("snap_row", { semi_additive: { window: "last", group_by: [] } }),
    h10_first: semi("snap_row", { semi_additive: { window: "first", group_by: [] } }),
    // H3
    h3_last: semi("snap_row", { semi_additive: { window: "last", group_by: ["${snapshots.customer_id}"] } }),
    h3_first: semi("snap_row", { semi_additive: { window: "first", group_by: ["${snapshots.customer_id}"] } }),
    // H1 default own-PK
    h1_last: semi("snap_row"),
    h1_first: semi("snap_row", { semi_additive: { window: "first" } }),
    // H2 explicit own PK
    h2_last: semi("snap_row", { semi_additive: { window: "last", group_by: ["${snapshots.snapshot_row_id}"] } }),
    h2_first: semi("snap_row", { semi_additive: { window: "first", group_by: ["${snapshots.snapshot_row_id}"] } }),
    // H4 explicit non-PK per-observation key (authoritative series declaration)
    h4_last: semi("snap_customer", {
      semi_additive: { window: "last", group_by: ["${snapshots.snapshot_row_id}"] },
    }),
    h4_first: semi("snap_customer", {
      semi_additive: { window: "first", group_by: ["${snapshots.snapshot_row_id}"] },
    }),
    // H5 own PK + true business relationship (still the entity grain)
    h5_last: semi("snap_customer"),
    h5_first: semi("snap_customer", { semi_additive: { window: "first" } }),
    // H6 own PK + per-observation 1:1 (same metadata shape as H5)
    h6_last: semi("snap_row"),
    // H7 stable foreign entity (explicit non-PK + relationship)
    h7_last: semi("snap_row", { semi_additive: { window: "last", group_by: ["${snapshots.customer_id}"] } }),
    h7_first: semi("snap_row", { semi_additive: { window: "first", group_by: ["${snapshots.customer_id}"] } }),
    // H8 / H9 multi-key including the entity PK
    h8_last: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.customer_id}", "${snapshots.snapshot_row_id}"] },
    }),
    h8_first: semi("snap_row", {
      semi_additive: { window: "first", group_by: ["${snapshots.customer_id}", "${snapshots.snapshot_row_id}"] },
    }),
    h9_last: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.snapshot_row_id}", "${snapshots.customer_id}"] },
    }),
    h9_first: semi("snap_row", {
      semi_additive: { window: "first", group_by: ["${snapshots.snapshot_row_id}", "${snapshots.customer_id}"] },
    }),
    // Multi-key of two non-PK columns (authoritative composite)
    h_customer_region_last: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.customer_id}", "${snapshots.region}"] },
    }),
    additive_balance: {
      entity: "snap_row",
      type: "sum",
      sql: "${snapshots.balance}",
      time_dimension: "${snapshots.snapshot_date}",
    },
    ratio_unsafe_num: {
      entity: "snap_row",
      type: "ratio",
      numerator: "h1_last",
      denominator: "additive_balance",
    },
    ratio_unsafe_den: {
      entity: "snap_row",
      type: "ratio",
      numerator: "additive_balance",
      denominator: "h2_last",
    },
    ratio_safe: {
      entity: "snap_row",
      type: "ratio",
      numerator: "h3_last",
      denominator: "h7_last",
    },
  };
}

function entities(): Record<string, unknown> {
  return {
    snap_row: { table: "snapshots", primary_key: "snapshot_row_id" },
    snap_customer: { table: "snapshots", primary_key: "customer_id" },
    customer: { table: "dim_customers", primary_key: "customer_id" },
    dim_row: { table: "dim_rows", primary_key: "snapshot_row_id" },
    dim_obs_ent: { table: "dim_obs", primary_key: "obs_id" },
    unreachable: { table: "dim_unreachable", primary_key: "id" },
    dup_customer: { table: "dim_dup_customers", primary_key: "customer_id" },
  };
}

function dimensions(): Record<string, unknown> {
  return {
    segment: { entity: "snap_row", sql: "${snapshots.segment}" },
    region: { entity: "snap_row", sql: "${snapshots.region}" },
    country: { entity: "customer", sql: "${dim_customers.country}" },
    row_note: { entity: "dim_row", sql: "${dim_rows.note}" },
    obs_label: { entity: "dim_obs_ent", sql: "${dim_obs.label}" },
    unreachable_label: { entity: "unreachable", sql: "${dim_unreachable.label}" },
    dup_country: { entity: "dup_customer", sql: "${dim_dup_customers.country}" },
  };
}

type RelFlag = "none" | "business" | "row1to1" | "obs" | "unreachable" | "dup" | "all";

function relationships(flag: RelFlag): Record<string, unknown> {
  const rels: Record<string, unknown> = {};
  if (flag === "business" || flag === "all") {
    rels.snaps_customers = {
      from: "snapshots.customer_id",
      to: "dim_customers.customer_id",
      type: "many_to_one",
    };
  }
  if (flag === "row1to1" || flag === "all") {
    rels.snaps_rows = {
      from: "snapshots.snapshot_row_id",
      to: "dim_rows.snapshot_row_id",
      type: "many_to_one",
    };
  }
  if (flag === "obs" || flag === "all") {
    rels.snaps_obs = {
      from: "snapshots.snapshot_row_id",
      to: "dim_obs.obs_id",
      type: "many_to_one",
    };
  }
  if (flag === "unreachable" || flag === "all") {
    rels.snaps_unreach = {
      from: "snapshots.customer_id",
      to: "dim_unreachable.id",
      type: "many_to_one",
    };
  }
  if (flag === "dup" || flag === "all") {
    rels.snaps_dups = {
      from: "snapshots.customer_id",
      to: "dim_dup_customers.customer_id",
      type: "many_to_one",
    };
  }
  return rels;
}

function config(connection: Record<string, unknown>, rel: RelFlag = "none") {
  return graneConfigSchema.parse({
    project: { name: "series-key", timezone: "UTC" },
    connection,
    entities: entities(),
    metrics: metrics(),
    dimensions: dimensions(),
    relationships: relationships(rel),
  });
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

function expectVacuous(k: GraneKernel, metric: string, column: string) {
  expect(vacuousSnapshotSeriesKeys(k.model, k.model.metrics.get(metric)!).map((c) => c.column)).toEqual([column]);
  expect(k.validate().issues.some((i) => i.code === "vacuous_semi_additive_group_by" && i.message.includes(metric))).toBe(
    true,
  );
  const r = refusal(() => k.compile({ metrics: [metric], time: Q1 }));
  expect(r.status).toBe("unsafe_query");
  expect(r.message).toMatch(/own primary key|declared grain|not prove it is a continuing series/);
}

function expectSafe(k: GraneKernel, metric: string) {
  expect(vacuousSnapshotSeriesKeys(k.model, k.model.metrics.get(metric)!)).toEqual([]);
  expect(k.validate().issues.some((i) => i.code === "vacuous_semi_additive_group_by" && i.message.includes(metric))).toBe(
    false,
  );
}

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

describe("series-key proof (static)", () => {
  const bare = new GraneKernel(config({ type: "postgres", schema: "public" }, "none"));
  const business = new GraneKernel(config({ type: "postgres", schema: "public" }, "business"));
  const row1to1 = new GraneKernel(config({ type: "postgres", schema: "public" }, "row1to1"));

  it("H1/H2: own PK default and explicit are vacuous", () => {
    expectVacuous(bare, "h1_last", "snapshot_row_id");
    expectVacuous(bare, "h1_first", "snapshot_row_id");
    expectVacuous(bare, "h2_last", "snapshot_row_id");
    expectVacuous(bare, "h2_first", "snapshot_row_id");
  });

  it("H3/H10: explicit non-PK customer and global [] are not vacuous", () => {
    expectSafe(bare, "h3_last");
    expectSafe(bare, "h3_first");
    expectSafe(bare, "h10_last");
    expectSafe(bare, "h10_first");
  });

  it("H4: explicit non-PK per-observation key is an authoritative series declaration", () => {
    expectSafe(bare, "h4_last");
    expectSafe(bare, "h4_first");
  });

  it("H5/H6: a relationship does not save the entity PK", () => {
    expectVacuous(business, "h5_last", "customer_id");
    expectVacuous(business, "h5_first", "customer_id");
    expectVacuous(row1to1, "h6_last", "snapshot_row_id");
    expectVacuous(bare, "h5_last", "customer_id");
  });

  it("H7: stable foreign column (non-PK) stays a series even with a relationship", () => {
    expectSafe(business, "h7_last");
    expectSafe(business, "h7_first");
  });

  it("H8/H9: a vacuous companion cannot be rescued; order does not matter", () => {
    expectVacuous(bare, "h8_last", "snapshot_row_id");
    expectVacuous(bare, "h8_first", "snapshot_row_id");
    expectVacuous(bare, "h9_last", "snapshot_row_id");
    expectVacuous(bare, "h9_first", "snapshot_row_id");
  });
});

describe.skipIf(!duckdbOk)("series-key proof (DuckDB execute)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-series-key-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(DDL);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(rel: RelFlag = "none"): GraneKernel {
    const k = new GraneKernel(config({ type: "duckdb", path, schema: "main" }, rel));
    kernels.push(k);
    return k;
  }

  async function value(k: GraneKernel, metric: string, extra: Record<string, unknown> = {}): Promise<number> {
    const result = await k.query({ metrics: [metric], ...extra });
    expect(result.trust).toBe("governed");
    expect(result.rows).toHaveLength(1);
    return Number(result.rows[0]![metric]);
  }

  it("H10: global last 200 / first 230", async () => {
    const k = kernel();
    expect(await value(k, "h10_last", { time: Q1 })).toBe(GLOBAL_LAST);
    expect(await value(k, "h10_first", { time: Q1 })).toBe(GLOBAL_FIRST);
    expect(await value(k, "additive_balance", { time: Q1 })).toBe(HISTORY);
  });

  it("H3: explicit non-PK customer last 350 / first 260", async () => {
    const k = kernel();
    expect(await value(k, "h3_last", { time: Q1 })).toBe(CUSTOMER_LAST);
    expect(await value(k, "h3_first", { time: Q1 })).toBe(CUSTOMER_FIRST);
    expect(await value(k, "h10_last", { time: Q1 })).toBe(GLOBAL_LAST);
  });

  it("H1/H2: own-PK default and explicit refuse; validate agrees", async () => {
    const k = kernel();
    for (const metric of ["h1_last", "h1_first", "h2_last", "h2_first"]) {
      expectVacuous(k, metric, "snapshot_row_id");
    }
  });

  it("H4: explicit non-PK observation key executes the declared series (identity)", async () => {
    const k = kernel();
    expectSafe(k, "h4_last");
    expect(await value(k, "h4_last", { time: Q1 })).toBe(HISTORY);
    expect(await value(k, "h4_first", { time: Q1 })).toBe(HISTORY);
  });

  it("H5: own PK + true business relationship is still refused", async () => {
    const k = kernel("business");
    expectVacuous(k, "h5_last", "customer_id");
    expectVacuous(k, "h5_first", "customer_id");
  });

  it("H6: own PK + per-observation 1:1/m2o is refused (same proof as H5)", async () => {
    const k = kernel("row1to1");
    expectVacuous(k, "h6_last", "snapshot_row_id");
  });

  it("H7: stable foreign entity last 350 / first 260", async () => {
    const k = kernel("business");
    expect(await value(k, "h7_last", { time: Q1 })).toBe(CUSTOMER_LAST);
    expect(await value(k, "h7_first", { time: Q1 })).toBe(CUSTOMER_FIRST);
  });

  it("H8/H9: multi-key with observation identity refuses in either order", async () => {
    const k = kernel();
    expectVacuous(k, "h8_last", "snapshot_row_id");
    expectVacuous(k, "h9_last", "snapshot_row_id");
    expectVacuous(k, "h8_first", "snapshot_row_id");
    expectVacuous(k, "h9_first", "snapshot_row_id");
  });

  it("query dimensions after snapshot selection do not collapse global vs per-series", async () => {
    const k = kernel("business");
    const global = await k.query({ metrics: ["h10_last"], dimensions: ["segment"], time: Q1 });
    expect(global.trust).toBe("governed");
    const bySeg = Object.fromEntries(global.rows.map((r) => [String(r.segment), Number(r.h10_last)]));
    // Global last date is Mar: C1 smb 80 + C3 ent 120
    expect(bySeg).toEqual({ smb: 80, ent: 120 });
    const perCust = await k.query({ metrics: ["h3_last"], dimensions: ["segment"], time: Q1 });
    const byCustSeg = Object.fromEntries(perCust.rows.map((r) => [String(r.segment), Number(r.h3_last)]));
    // C1 last Mar smb 80, C2 last Feb smb 150, C3 last Mar ent 120
    expect(byCustSeg).toEqual({ smb: 230, ent: 120 });
    const joined = await k.query({ metrics: ["h7_last"], dimensions: ["country"], time: Q1 });
    const byCountry = Object.fromEntries(joined.rows.map((r) => [String(r.country), Number(r.h7_last)]));
    expect(byCountry).toEqual({ US: 80, DE: 150, UK: 120 });
  });

  it("REL-E: unreachable dimension rows do not change a safe series", async () => {
    const k = kernel("unreachable");
    expect(await value(k, "h3_last", { time: Q1 })).toBe(CUSTOMER_LAST);
    const joined = await k.query({ metrics: ["h3_last"], dimensions: ["unreachable_label"], time: Q1 });
    expect(joined.trust).toBe("governed");
    expect(joined.rows.reduce((s, r) => s + Number(r.h3_last), 0)).toBe(CUSTOMER_LAST);
  });

  it("REL-F: participating duplicate keys still refuse", async () => {
    const k = kernel("dup");
    const r = await refusalAsync(() => k.query({ metrics: ["h3_last"], dimensions: ["dup_country"], time: Q1 }));
    expect(r.status).toBe("unsafe_query");
  });

  it("REL-C: PK → unique-per-observation table does not save the grain", async () => {
    const k = kernel("obs");
    expectVacuous(k, "h1_last", "snapshot_row_id");
  });

  it("filters: base query, metric definition, joined, and changing attributes", async () => {
    const k = kernel("business");
    expect(await value(k, "h10_last", { time: Q1, filters: [{ field: "segment", operator: "=", value: "ent" }] })).toBe(
      120,
    );
    expect(await value(k, "h3_last", { time: Q1, filters: [{ field: "segment", operator: "=", value: "ent" }] })).toBe(
      240,
    );
    expect(
      await value(k, "h7_last", { time: Q1, filters: [{ field: "country", operator: "=", value: "US" }] }),
    ).toBe(80);
  });

  it("ratio / multi-metric: unsafe series cannot be hidden by composition or order", async () => {
    const k = kernel();
    expect(refusal(() => k.compile({ metrics: ["h1_last", "additive_balance"], time: Q1 })).status).toBe("unsafe_query");
    expect(refusal(() => k.compile({ metrics: ["additive_balance", "h1_last"], time: Q1 })).status).toBe("unsafe_query");
    expect(refusal(() => k.compile({ metrics: ["ratio_unsafe_num"], time: Q1 })).status).toBe("unsafe_query");
    expect(refusal(() => k.compile({ metrics: ["ratio_unsafe_den"], time: Q1 })).status).toBe("unsafe_query");
    expect(k.validate().issues.some((i) => i.code === "vacuous_semi_additive_group_by" && i.message.includes("h1_last"))).toBe(
      true,
    );
    const safe = await k.query({ metrics: ["ratio_safe"], time: Q1 });
    expect(safe.trust).toBe("governed");
    expect(Number(safe.rows[0]!.ratio_safe)).toBeCloseTo(1);
    expect(refusal(() => k.compile({ metrics: ["h3_last", "h10_last"], time: Q1 })).status).toBe("unsafe_query");
  });

  it("PR #23 trust: approved stays governed; experimental is mixed; numbers match", async () => {
    const k = kernel();
    const experimental = new GraneKernel(
      graneConfigSchema.parse({
        ...config({ type: "duckdb", path, schema: "main" }),
        metrics: {
          ...metrics(),
          h10_last: { ...semi("snap_row", { semi_additive: { window: "last", group_by: [] } }), status: "experimental" },
        },
      }),
    );
    kernels.push(experimental);
    const gov = await k.query({ metrics: ["h10_last"], time: Q1 });
    const mix = await experimental.query({ metrics: ["h10_last"], time: Q1 });
    expect(gov.trust).toBe("governed");
    expect(mix.trust).toBe("mixed");
    expect(Number(gov.rows[0]!.h10_last)).toBe(GLOBAL_LAST);
    expect(Number(mix.rows[0]!.h10_last)).toBe(GLOBAL_LAST);
  });

  it("week grain still compiles for a safe series; own PK still refuses", async () => {
    const k = kernel();
    const week = await k.query({ metrics: ["h10_last"], time: { ...Q1, grain: "week" } });
    expect(week.trust).toBe("governed");
    expect(week.rows.length).toBeGreaterThan(0);
    expect(refusal(() => k.compile({ metrics: ["h1_last"], time: { ...Q1, grain: "month" } })).status).toBe(
      "unsafe_query",
    );
  });
});

const PG_URL = process.env.GRANE_PG_WRITE_URL ?? "postgres://grane:grane@127.0.0.1:5432/grane_demo";

async function postgresUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}
const pgOk = await postgresUp();

describe.skipIf(!pgOk)("series-key proof (PostgreSQL execute)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_series_${Date.now().toString(36)}`;
  let pool: pg.Pool | null = null;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`SET search_path TO ${SCHEMA}`);
    await pool.query(DDL);
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } catch {
        // ignore
      }
      await pool.end();
    }
  });

  function kernel(rel: RelFlag = "none"): GraneKernel {
    const k = new GraneKernel(config({ type: "postgres", url: PG_URL, schema: SCHEMA }, rel));
    kernels.push(k);
    return k;
  }

  it("H10 200/230, H3 350/260, H1/H5/H6 refused, H4 declared identity 730", async () => {
    const bare = kernel();
    const business = kernel("business");
    const row1to1 = kernel("row1to1");
    const g = await bare.query({ metrics: ["h10_last"], time: Q1 });
    expect(g.trust).toBe("governed");
    expect(Number(g.rows[0]!.h10_last)).toBe(GLOBAL_LAST);
    expect(Number((await bare.query({ metrics: ["h10_first"], time: Q1 })).rows[0]!.h10_first)).toBe(GLOBAL_FIRST);
    expect(Number((await bare.query({ metrics: ["h3_last"], time: Q1 })).rows[0]!.h3_last)).toBe(CUSTOMER_LAST);
    expect(Number((await bare.query({ metrics: ["h3_first"], time: Q1 })).rows[0]!.h3_first)).toBe(CUSTOMER_FIRST);
    expect(Number((await bare.query({ metrics: ["h4_last"], time: Q1 })).rows[0]!.h4_last)).toBe(HISTORY);
    expect(refusal(() => bare.compile({ metrics: ["h1_last"] })).status).toBe("unsafe_query");
    expect(refusal(() => business.compile({ metrics: ["h5_last"] })).status).toBe("unsafe_query");
    expect(refusal(() => row1to1.compile({ metrics: ["h6_last"] })).status).toBe("unsafe_query");
  });
});
