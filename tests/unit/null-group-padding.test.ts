/**
 * NULL analytical groups vs wrapper padding.
 *
 * The cardinality wrapper (`__grane_card LEFT JOIN __grane_result ON TRUE`)
 * materializes a synthetic row when GROUP BY is empty. That row is not a
 * real group. A real group whose visible values happen to be NULL is.
 *
 * Independent gold: /tmp/adversarial/gold.sql (same rows as DDL below).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mcpTrustText } from "../../src/query/trust.js";

const DDL = `
  CREATE TABLE facts (
    id INTEGER,
    customer_id INTEGER,
    segment VARCHAR,
    region VARCHAR,
    kind VARCHAR,
    amount DOUBLE PRECISION,
    sold_on DATE
  );
  INSERT INTO facts VALUES
    (1, 1,  'A',  'EU', 'A', 100, DATE '2026-01-01'),
    (2, 2,  NULL, 'EU', 'B',  50, DATE '2026-01-02'),
    (3, 3,  'C',  'US', 'C', NULL, DATE '2026-01-03'),
    (4, 4,  NULL, NULL, 'D', NULL, DATE '2026-01-04'),
    (5, 4,  NULL, NULL, 'D', NULL, DATE '2026-01-05'),
    (6, 2,  NULL, 'EU', 'B',  25, DATE '2026-01-06'),
    (7, 99, NULL, 'AP', 'U', NULL, DATE '2026-01-07'),
    (8, 99, NULL, 'AP', 'U',  10, DATE '2026-01-08'),
    (9, 10, 'X',  'EU', 'N', NULL, DATE '2026-01-09');
  CREATE TABLE customers (
    customer_id INTEGER PRIMARY KEY,
    country VARCHAR,
    status VARCHAR
  );
  INSERT INTO customers VALUES
    (1,  'US', 'active'),
    (2,  NULL, 'active'),
    (3,  'DE', 'churned'),
    (4,  'FR', 'active'),
    (10, NULL, 'active');
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION,
    segment VARCHAR
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-01', 100, 'A'),
    (2, 1, DATE '2026-01-31', 110, 'A'),
    (3, 2, DATE '2026-01-01',  40, NULL),
    (4, 2, DATE '2026-01-31',  45, NULL),
    (5, 3, DATE '2026-01-31', NULL, 'C');
  CREATE TABLE dim_dup (customer_id INTEGER, label VARCHAR);
  INSERT INTO dim_dup VALUES (1, 'x'), (1, 'y');
`;

const Q = { from: "2026-01-01", to: "2026-01-31" } as const;

function config(connection: Record<string, unknown>, defaultRows = 1000, maxRows = 10000) {
  return graneConfigSchema.parse({
    project: { name: "null-pad", timezone: "UTC" },
    connection,
    limits: { default_rows: defaultRows, max_rows: maxRows, timeout_ms: 30000 },
    entities: {
      sale: { table: "facts", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
      snap: { table: "snapshots", primary_key: "row_id" },
      dup: { table: "dim_dup", primary_key: "customer_id" },
    },
    metrics: {
      revenue: {
        entity: "sale",
        type: "sum",
        sql: "${facts.amount}",
        time_dimension: "${facts.sold_on}",
      },
      orders: {
        entity: "sale",
        type: "count",
        sql: "${facts.id}",
        time_dimension: "${facts.sold_on}",
      },
      aov: { entity: "sale", type: "ratio", numerator: "revenue", denominator: "orders" },
      avg_amount: {
        entity: "sale",
        type: "avg",
        sql: "${facts.amount}",
        time_dimension: "${facts.sold_on}",
      },
      min_amount: {
        entity: "sale",
        type: "min",
        sql: "${facts.amount}",
        time_dimension: "${facts.sold_on}",
      },
      max_amount: {
        entity: "sale",
        type: "max",
        sql: "${facts.amount}",
        time_dimension: "${facts.sold_on}",
      },
      trial_revenue: {
        entity: "sale",
        type: "sum",
        sql: "${facts.amount}",
        time_dimension: "${facts.sold_on}",
        status: "experimental",
      },
      last_balance: {
        entity: "snap",
        type: "sum",
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi",
        semi_additive: { window: "last", group_by: [] },
      },
      first_balance: {
        entity: "snap",
        type: "sum",
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi",
        semi_additive: { window: "first", group_by: [] },
      },
      last_by_segment: {
        entity: "snap",
        type: "sum",
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi",
        semi_additive: { window: "last", group_by: ["${snapshots.segment}"] },
      },
      last_row_default: {
        entity: "snap",
        type: "sum",
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi",
      },
    },
    dimensions: {
      segment: { entity: "sale", sql: "${facts.segment}" },
      region: { entity: "sale", sql: "${facts.region}" },
      kind: { entity: "sale", sql: "${facts.kind}" },
      country: { entity: "customer", sql: "${customers.country}" },
      status: { entity: "customer", sql: "${customers.status}" },
      snap_segment: { entity: "snap", sql: "${snapshots.segment}" },
      dup_label: { entity: "dup", sql: "${dim_dup.label}" },
    },
    relationships: {
      facts_customers: {
        from: "facts.customer_id",
        to: "customers.customer_id",
        type: "many_to_one",
      },
      facts_dups: { from: "facts.customer_id", to: "dim_dup.customer_id", type: "many_to_one" },
    },
  });
}

function isNull(v: unknown): boolean {
  return v === null || v === undefined;
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

describe.skipIf(!duckdbOk)("NULL groups vs wrapper padding (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-null-pad-")), "db.duckdb");
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

  function kernel(defaultRows = 1000, maxRows = 10000): GraneKernel {
    const k = new GraneKernel(config({ type: "duckdb", path, schema: "main" }, defaultRows, maxRows));
    kernels.push(k);
    return k;
  }

  function expectNoLeak(result: { columns: string[]; rows: Record<string, unknown>[] }) {
    expect(result.columns).not.toContain(RESULT_TOTAL_COLUMN);
    expect(result.columns).not.toContain(RESULT_ROW_COLUMN);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty(RESULT_TOTAL_COLUMN);
      expect(row).not.toHaveProperty(RESULT_ROW_COLUMN);
    }
  }

  it("reproduces: joined all-NULL group is a real GROUP BY row (gold: 1 row)", async () => {
    const k = kernel();
    const compiled = k.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(compiled.compiled.guards.length).toBeGreaterThan(0);
    expect(compiled.compiled.plan.groupColumns.length).toBeGreaterThan(0);
    const result = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    // Independent gold: LEFT JOIN country for kind=N → one group (NULL, NULL).
    expect(result.rows).toHaveLength(1);
    expect(isNull(result.rows[0]!.country)).toBe(true);
    expect(isNull(result.rows[0]!.revenue)).toBe(true);
    expect(result.trust).toBe("governed");
    expect(result.completeness.status).toBe("complete");
    expectNoLeak(result);
  });

  it("N1–N12 core matrix", async () => {
    const k = kernel();
    const n1 = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "A" }],
      time: Q,
    });
    expect(n1.rows).toHaveLength(1);
    expect(n1.rows[0]!.country).toBe("US");
    expect(Number(n1.rows[0]!.revenue)).toBe(100);

    const n2 = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment"],
      filters: [{ field: "kind", operator: "=", value: "B" }],
      time: Q,
    });
    expect(n2.rows).toHaveLength(1);
    expect(isNull(n2.rows[0]!.segment)).toBe(true);
    expect(Number(n2.rows[0]!.revenue)).toBe(75);

    const n3 = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "C" }],
      time: Q,
    });
    expect(n3.rows).toHaveLength(1);
    expect(n3.rows[0]!.country).toBe("DE");
    expect(isNull(n3.rows[0]!.revenue)).toBe(true);

    const n4 = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(n4.rows).toHaveLength(1);
    expect(isNull(n4.rows[0]!.country)).toBe(true);
    expect(isNull(n4.rows[0]!.revenue)).toBe(true);

    const n5 = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment"],
      filters: [{ field: "kind", operator: "=", value: "B" }],
      time: Q,
    });
    expect(n5.rows).toHaveLength(1);
    expect(Number(n5.rows[0]!.revenue)).toBe(75);

    const n6 = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(n6.rows).toHaveLength(1);
    expect(n6.rows[0]!.country).toBe("FR");
    expect(isNull(n6.rows[0]!.revenue)).toBe(true);

    const n7 = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "region"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(n7.rows).toHaveLength(1);
    expect(isNull(n7.rows[0]!.segment)).toBe(true);
    expect(isNull(n7.rows[0]!.region)).toBe(true);
    expect(isNull(n7.rows[0]!.revenue)).toBe(true);

    const n8 = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(n8.rows).toEqual([]);
    expect(n8.completeness.status).toBe("complete");

    const n9 = n8;
    expect(n9.rows).toEqual([]);

    const n10 = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(n10.rows).toHaveLength(1);
    expect(isNull(n10.rows[0]!.revenue)).toBe(true);

    const n11 = await k.query({
      metrics: ["orders"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(n11.rows).toHaveLength(1);
    expect(Number(n11.rows[0]!.orders)).toBe(0);

    const n12 = await k.query({
      metrics: ["aov"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(n12.rows).toHaveLength(1);
    expect(isNull(n12.rows[0]!.aov)).toBe(true);
    for (const r of [n1, n4, n7, n8, n10]) {
      expect(r.trust).toBe("governed");
      expect(r.completeness.status).toBe("complete");
      expect(r.provenance.completeness).toEqual(r.completeness);
    }
  });

  it("NULL-dimension combinations survive when they are real groups", async () => {
    const k = kernel();
    const one = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment"],
      filters: [{ field: "kind", operator: "=", value: "B" }],
      time: Q,
    });
    expect(one.rows).toHaveLength(1);
    expect(isNull(one.rows[0]!.segment)).toBe(true);

    const firstNull = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "region"],
      filters: [{ field: "kind", operator: "=", value: "B" }],
      time: Q,
    });
    expect(firstNull.rows).toHaveLength(1);
    expect(isNull(firstNull.rows[0]!.segment)).toBe(true);
    expect(firstNull.rows[0]!.region).toBe("EU");

    const secondNull = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "region"],
      filters: [{ field: "kind", operator: "=", value: "C" }],
      time: Q,
    });
    expect(secondNull.rows).toHaveLength(1);
    expect(secondNull.rows[0]!.segment).toBe("C");
    expect(secondNull.rows[0]!.region).toBe("US");

    const both = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "region"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(both.rows).toHaveLength(1);
    expect(isNull(both.rows[0]!.segment)).toBe(true);
    expect(isNull(both.rows[0]!.region)).toBe(true);
    expect(isNull(both.rows[0]!.revenue)).toBe(true);
  });

  it("NULL-metric types preserve the row; COUNT is 0 not NULL", async () => {
    const k = kernel();
    const sum = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(sum.rows).toHaveLength(1);
    expect(isNull(sum.rows[0]!.revenue)).toBe(true);
    const avg = await k.query({
      metrics: ["avg_amount"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(avg.rows).toHaveLength(1);
    expect(isNull(avg.rows[0]!.avg_amount)).toBe(true);
    const mn = await k.query({
      metrics: ["min_amount"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(isNull(mn.rows[0]!.min_amount)).toBe(true);
    const mx = await k.query({
      metrics: ["max_amount"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(isNull(mx.rows[0]!.max_amount)).toBe(true);
    const cnt = await k.query({
      metrics: ["orders"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(cnt.rows).toHaveLength(1);
    expect(Number(cnt.rows[0]!.orders)).toBe(2);
  });

  it("multi-metric: all-NULL visible fields still survive; order does not matter", async () => {
    const k = kernel();
    const m1 = await k.query({
      metrics: ["revenue", "avg_amount"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(m1.rows).toHaveLength(1);
    expect(isNull(m1.rows[0]!.country)).toBe(true);
    expect(isNull(m1.rows[0]!.revenue)).toBe(true);
    expect(isNull(m1.rows[0]!.avg_amount)).toBe(true);
    const m2 = await k.query({
      metrics: ["avg_amount", "revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(m2.rows).toHaveLength(1);
    const mixed = await k.query({
      metrics: ["revenue", "orders"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(mixed.rows).toHaveLength(1);
    expect(isNull(mixed.rows[0]!.revenue)).toBe(true);
    expect(Number(mixed.rows[0]!.orders)).toBe(1);
  });

  it("ratio NULLness is not a padding marker", async () => {
    const k = kernel();
    const r = await k.query({
      metrics: ["aov"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(r.rows).toHaveLength(1);
    expect(isNull(r.rows[0]!.country)).toBe(true);
    expect(isNull(r.rows[0]!.aov)).toBe(true);
    const denom = await k.query({
      metrics: ["aov"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "D" }],
      time: Q,
    });
    expect(denom.rows).toHaveLength(1);
    expect(isNull(denom.rows[0]!.aov)).toBe(true);
  });

  it("filters distinguish one all-NULL group from zero groups", async () => {
    const k = kernel();
    const onlyNull = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "in", value: ["N"] }],
      time: Q,
    });
    expect(onlyNull.rows).toHaveLength(1);
    const ne = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "!=", value: "NOPE" }],
      time: Q,
    });
    expect(ne.rows.length).toBeGreaterThan(0);
    const contains = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "contains", value: "N" }],
      time: Q,
    });
    expect(contains.rows).toHaveLength(1);
    const isNullKind = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment"],
      filters: [{ field: "segment", operator: "is_null" }],
      time: Q,
    });
    expect(isNullKind.rows.length).toBeGreaterThan(0);
    expect(isNull(isNullKind.rows[0]!.segment)).toBe(true);
    const empty = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "status", operator: "=", value: "missing" }],
      time: Q,
    });
    expect(empty.rows).toEqual([]);
  });

  it("LEFT JOIN NULL buckets are real groups; cardinality refusals stay refusals", async () => {
    const k = kernel();
    const unmatchedAmt = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "U" }],
      time: Q,
    });
    expect(unmatchedAmt.rows).toHaveLength(1);
    expect(isNull(unmatchedAmt.rows[0]!.country)).toBe(true);
    expect(Number(unmatchedAmt.rows[0]!.revenue)).toBe(10);
    const unmatchedNull = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [
        { field: "kind", operator: "=", value: "U" },
        { field: "region", operator: "=", value: "AP" },
      ],
      time: Q,
    });
    expect(unmatchedNull.rows).toHaveLength(1);
    await expect(
      k.query({ metrics: ["revenue"], dimensions: ["dup_label"], time: Q }),
    ).rejects.toBeInstanceOf(GraneError);
  });

  it("safe semi-additive keeps a NULL series group; vacuous own-PK still refuses", async () => {
    const k = kernel();
    const global = await k.query({ metrics: ["last_balance"], time: Q });
    expect(global.trust).toBe("governed");
    expect(global.rows).toHaveLength(1);
    expect(Number(global.rows[0]!.last_balance)).toBe(155);
    const first = await k.query({ metrics: ["first_balance"], time: Q });
    expect(Number(first.rows[0]!.first_balance)).toBe(140);
    // Global last, then GROUP BY a nullable dimension (snapshot join is date-only).
    const bySeg = await k.query({ metrics: ["last_balance"], dimensions: ["snap_segment"], time: Q });
    expect(bySeg.trust).toBe("governed");
    const nullSeg = bySeg.rows.find((r) => isNull(r.snap_segment));
    expect(nullSeg).toBeDefined();
    expect(Number(nullSeg!.last_by_segment ?? nullSeg!.last_balance)).toBe(45);
    await expect(k.query({ metrics: ["last_row_default"], time: Q })).rejects.toBeInstanceOf(GraneError);
  });

  it("PR #26: NULL group counts toward completeness; padding does not", async () => {
    const below = kernel(5, 100);
    const c1 = await below.query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    expect(c1.rows.length).toBeGreaterThan(0);
    expect(c1.rows.some((r) => isNull(r.country))).toBe(true);
    expect(c1.completeness.status).toBe("complete");
    expect(c1.provenance.completeness).toEqual(c1.completeness);

    const countries = await kernel(1000).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    const n = countries.rows.length;
    expect(n).toBeGreaterThan(1);
    const exact = await kernel(n).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    expect(exact.rows).toHaveLength(n);
    expect(exact.completeness.status).toBe("complete");
    expect(exact.rows.some((r) => isNull(r.country))).toBe(true);

    const plus = await kernel(n - 1).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    expect(plus.rows).toHaveLength(n - 1);
    expect(plus.completeness.status).toBe("truncated");
    expectNoLeak(plus);

    const zero = await kernel(1).query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(zero.rows).toEqual([]);
    expect(zero.completeness.status).toBe("complete");

    const only = await kernel(1).query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(only.rows).toHaveLength(1);
    expect(only.completeness.status).toBe("complete");
    expect(only.completeness.source).toBe("default");
  });

  it("trust stays orthogonal; mixed+truncated still preserves the NULL group under a cap", async () => {
    const k = kernel(1, 100);
    const mixed = await k.query({
      metrics: ["trial_revenue"],
      dimensions: ["country"],
      time: Q,
    });
    expect(mixed.trust).toBe("mixed");
    expect(mixed.completeness.status).toBe("truncated");
    expect(mixed.rows).toHaveLength(1);
    const governed = await kernel().query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(governed.trust).toBe("governed");
    expect(governed.completeness.status).toBe("complete");
  });

  it("MCP and compile marker: structural __grane_row, no leak", async () => {
    const k = kernel();
    const { compiled } = k.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(compiled.sql).toMatch(/1 AS ["`]?__grane_row["`]?/);
    expect(compiled.plan.columns).not.toContain(RESULT_ROW_COLUMN);
    const result = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    const text = mcpTrustText({
      trust: result.trust,
      columns: result.columns,
      rows: result.rows,
      completeness: result.completeness,
      provenance: result.provenance,
    });
    const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
      rows: Record<string, unknown>[];
      completeness: unknown;
    };
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.country).toBeNull();
    expect(payload.rows[0]!.revenue).toBeNull();
    expect(payload.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(JSON.stringify(payload.rows)).not.toContain(RESULT_ROW_COLUMN);
    expect(payload.completeness).toEqual(result.completeness);
    expect(compiled.sql).toContain("__grane_row");
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

describe.skipIf(!pgOk)("NULL groups vs wrapper padding (PostgreSQL)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_np_${Date.now().toString(36)}`;
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

  function kernel(): GraneKernel {
    const k = new GraneKernel(config({ type: "postgres", url: PG_URL, schema: SCHEMA }));
    kernels.push(k);
    return k;
  }

  it("keeps joined all-NULL group and strips empty-group padding", async () => {
    const k = kernel();
    const real = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "N" }],
      time: Q,
    });
    expect(real.rows).toHaveLength(1);
    expect(real.rows[0]!.country).toBeNull();
    expect(real.rows[0]!.revenue).toBeNull();
    const empty = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "kind", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(empty.rows).toEqual([]);
  });
});
