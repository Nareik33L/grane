/**
 * Result completeness: execution caps must not masquerade as complete sets.
 *
 * query.limit  → semantic top-N (complete requested result)
 * default_rows → execution cap when limit is omitted
 * max_rows     → hard safety bound
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { resultCompleteness } from "../../src/execute/executor.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mcpTrustText } from "../../src/query/trust.js";
import { resolveRowLimit } from "../../src/query/resolve.js";

const DDL = `
  CREATE TABLE sales (
    id INTEGER,
    customer_id INTEGER,
    region VARCHAR,
    channel VARCHAR,
    amount DOUBLE PRECISION,
    sold_on DATE,
    note VARCHAR
  );
  INSERT INTO sales VALUES
    (1,  1, 'US', 'web',    10, DATE '2026-01-01', 'a'),
    (2,  2, 'US', 'web',    20, DATE '2026-01-02', 'b'),
    (3,  3, 'US', 'store',  30, DATE '2026-01-03', 'c'),
    (4,  4, 'EU', 'web',    40, DATE '2026-01-04', 'd'),
    (5,  5, 'EU', 'store',  50, DATE '2026-01-05', 'e'),
    (6,  6, 'EU', 'web',    60, DATE '2026-01-06', 'f'),
    (7,  7, 'AP', 'web',    70, DATE '2026-01-07', 'g'),
    (8,  8, 'AP', 'store',  80, DATE '2026-01-08', 'h'),
    (9,  9, 'AP', 'web',    90, DATE '2026-01-09', 'i'),
    (10, 10, 'US', 'web',   100, DATE '2026-01-10', 'j'),
    (11, 11, 'EU', 'store', 110, DATE '2026-01-11', 'k'),
    (12, 12, 'AP', 'web',   120, DATE '2026-01-12', 'l');
  CREATE TABLE dim_customers (
    customer_id INTEGER PRIMARY KEY,
    country VARCHAR,
    status VARCHAR
  );
  INSERT INTO dim_customers VALUES
    (1, 'US', 'active'), (2, 'US', 'active'), (3, 'US', 'churned'),
    (4, 'DE', 'active'), (5, 'DE', 'active'), (6, 'FR', 'active'),
    (7, 'JP', 'active'), (8, 'JP', 'churned'), (9, 'AU', 'active'),
    (10, 'US', 'active'), (11, 'DE', 'active'), (12, 'JP', 'active');
  CREATE TABLE dim_dup (customer_id INTEGER, label VARCHAR);
  INSERT INTO dim_dup VALUES (1, 'x'), (1, 'y');
`;

const Q = { from: "2026-01-01", to: "2026-01-31" } as const;

function config(connection: Record<string, unknown>, defaultRows = 1000, maxRows = 10000) {
  return graneConfigSchema.parse({
    project: { name: "row-limit", timezone: "UTC" },
    connection,
    limits: { default_rows: defaultRows, max_rows: maxRows, timeout_ms: 30000 },
    entities: {
      sale: { table: "sales", primary_key: "id" },
      customer: { table: "dim_customers", primary_key: "customer_id" },
      dup: { table: "dim_dup", primary_key: "customer_id" },
    },
    metrics: {
      revenue: {
        entity: "sale",
        type: "sum",
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
      },
      orders: {
        entity: "sale",
        type: "count",
        sql: "${sales.id}",
        time_dimension: "${sales.sold_on}",
      },
      aov: { entity: "sale", type: "ratio", numerator: "revenue", denominator: "orders" },
      web_revenue: {
        entity: "sale",
        type: "sum",
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.channel": "web" },
      },
      trial_revenue: {
        entity: "sale",
        type: "sum",
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        status: "experimental",
      },
    },
    dimensions: {
      region: { entity: "sale", sql: "${sales.region}" },
      channel: { entity: "sale", sql: "${sales.channel}" },
      customer_id: { entity: "sale", sql: "${sales.customer_id}" },
      country: { entity: "customer", sql: "${dim_customers.country}" },
      status: { entity: "customer", sql: "${dim_customers.status}" },
      dup_label: { entity: "dup", sql: "${dim_dup.label}" },
    },
    relationships: {
      sales_customers: {
        from: "sales.customer_id",
        to: "dim_customers.customer_id",
        type: "many_to_one",
      },
      sales_dups: { from: "sales.customer_id", to: "dim_dup.customer_id", type: "many_to_one" },
    },
  });
}

describe("resolveRowLimit", () => {
  it("treats a request limit at or below max_rows as semantic query", () => {
    expect(resolveRowLimit(5, 1000, 10000)).toEqual({ limit: 5, source: "query" });
    expect(resolveRowLimit(10000, 1000, 10000)).toEqual({ limit: 10000, source: "query" });
  });

  it("applies default_rows when limit is omitted", () => {
    expect(resolveRowLimit(undefined, 1000, 10000)).toEqual({ limit: 1000, source: "default" });
  });

  it("binds requested or default caps with max_rows", () => {
    expect(resolveRowLimit(50000, 1000, 10000)).toEqual({ limit: 10000, source: "max" });
    expect(resolveRowLimit(undefined, 20000, 10000)).toEqual({ limit: 10000, source: "max" });
  });
});

describe("resultCompleteness", () => {
  it("marks semantic query limits complete even when more groups exist", () => {
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "query" }, 5, 12).status).toBe("complete");
  });

  it("marks execution caps complete at exact cap and truncated above it", () => {
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "default" }, 5, 5).status).toBe("complete");
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "default" }, 5, 6).status).toBe("truncated");
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "max" }, 5, 12).status).toBe("truncated");
  });

  it("treats an empty result as complete", () => {
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "default" }, 0, null).status).toBe("complete");
  });

  it("uses unknown when a safety-cap result has rows but no pre-LIMIT total", () => {
    expect(resultCompleteness({ rowLimit: 5, rowLimitSource: "default" }, 5, null).status).toBe("unknown");
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

describe.skipIf(!duckdbOk)("row-limit completeness (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-row-limit-")), "db.duckdb");
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

  async function grouped(
    k: GraneKernel,
    extra: Record<string, unknown> = {},
    metric = "revenue",
  ) {
    return k.query({ metrics: [metric], dimensions: ["customer_id"], time: Q, ...extra });
  }

  it("compiles COUNT(*) OVER() and does not put it on plan.columns", () => {
    const k = kernel();
    const { compiled, resolved } = k.compile({
      metrics: ["revenue"],
      dimensions: ["customer_id"],
      time: Q,
    });
    expect(compiled.sql).toMatch(/COUNT\(\*\) OVER\(\)/);
    expect(compiled.sql).toMatch(/LIMIT 1000/);
    expect(compiled.sql).not.toMatch(/LIMIT 1001/);
    expect(compiled.plan.columns).not.toContain(RESULT_TOTAL_COLUMN);
    expect(resolved.limitSource).toBe("default");
    expect(compiled.rowLimit).toBe(1000);
  });

  it("explain reports the planned cap, not truncation", async () => {
    const k = kernel(5);
    const explained = await k.explain({ metrics: ["revenue"], dimensions: ["customer_id"], time: Q });
    expect(explained.row_limit).toBe(5);
    expect(explained.row_limit_source).toBe("default");
    expect(explained).not.toHaveProperty("completeness");
    expect(JSON.stringify(explained)).not.toMatch(/truncated/);
  });

  it("U1–U10: semantic query.limit is a complete requested result", async () => {
    const k = kernel(1000, 10000);
    const cases: Array<{ id: string; limit?: number; filters?: unknown; order?: unknown; rows: number }> =
      [
        { id: "U1", rows: 12 },
        { id: "U2", limit: 5, rows: 5 },
        { id: "U3", limit: 12, rows: 12 },
        { id: "U4", limit: 20, rows: 12 },
        { id: "U5", limit: 1, rows: 1 },
        { id: "U6", limit: 5, order: [{ field: "revenue", direction: "desc" }], rows: 5 },
        { id: "U7", limit: 5, order: [{ field: "revenue", direction: "asc" }], rows: 5 },
        { id: "U8", limit: 10, filters: [{ field: "region", operator: "=", value: "US" }], rows: 4 },
        { id: "U9", limit: 4, filters: [{ field: "region", operator: "=", value: "US" }], rows: 4 },
        { id: "U10", limit: 2, filters: [{ field: "region", operator: "=", value: "US" }], rows: 2 },
      ];
    for (const c of cases) {
      const result = await grouped(k, {
        ...(c.limit != null ? { limit: c.limit } : {}),
        ...(c.filters ? { filters: c.filters } : {}),
        ...(c.order ? { order: c.order } : {}),
      });
      expect(result.trust, c.id).toBe("governed");
      expect(result.rows.length, c.id).toBe(c.rows);
      expect(result.completeness.status, c.id).toBe("complete");
      expect(result.provenance.completeness, c.id).toEqual(result.completeness);
      expect(result.provenance.row_count, c.id).toBe(c.rows);
      expect(result.columns, c.id).not.toContain(RESULT_TOTAL_COLUMN);
      for (const row of result.rows) expect(row, c.id).not.toHaveProperty(RESULT_TOTAL_COLUMN);
      if (c.limit != null) {
        expect(result.completeness.source, c.id).toBe("query");
        expect(result.completeness.limit, c.id).toBe(c.limit);
      } else {
        expect(result.completeness.source, c.id).toBe("default");
      }
    }
    const top = await grouped(k, { limit: 5, order: [{ field: "revenue", direction: "desc" }] });
    expect(top.rows.map((r) => Number(r.revenue))).toEqual([120, 110, 100, 90, 80]);
    const bottom = await grouped(k, { limit: 5, order: [{ field: "revenue", direction: "asc" }] });
    expect(bottom.rows.map((r) => Number(r.revenue))).toEqual([10, 20, 30, 40, 50]);
  });

  it("S1–S10: execution default cap uses pre-LIMIT count", async () => {
    const cap = 5;
    const k = kernel(cap, 100);
    const empty = await grouped(k, { filters: [{ field: "region", operator: "=", value: "NOPE" }] });
    expect(empty.rows).toEqual([]);
    expect(empty.completeness).toEqual({ status: "complete", limit: cap, source: "default" });

    const one = await grouped(k, { filters: [{ field: "customer_id", operator: "=", value: 1 }] });
    expect(one.rows).toHaveLength(1);
    expect(one.completeness.status).toBe("complete");

    const below = kernel(13, 100);
    const s3 = await grouped(below);
    expect(s3.rows).toHaveLength(12);
    expect(s3.completeness.status).toBe("complete");

    const exact = kernel(12, 100);
    const s4 = await grouped(exact);
    expect(s4.rows).toHaveLength(12);
    expect(s4.completeness.status).toBe("complete");
    expect(s4.completeness.source).toBe("default");

    const plus1 = kernel(11, 100);
    const s5 = await grouped(plus1);
    expect(s5.rows).toHaveLength(11);
    expect(s5.completeness).toEqual({ status: "truncated", limit: 11, source: "default" });
    expect(s5.provenance.row_count).toBe(11);

    const many = kernel(5, 100);
    const s6 = await grouped(many);
    expect(s6.rows).toHaveLength(5);
    expect(s6.completeness.status).toBe("truncated");
    expect(s6.completeness.limit).toBe(5);

    const filteredBelow = await grouped(many, { filters: [{ field: "region", operator: "=", value: "US" }] });
    expect(filteredBelow.rows).toHaveLength(4);
    expect(filteredBelow.completeness.status).toBe("complete");

    const four = kernel(4, 100);
    const filteredExact = await grouped(four, { filters: [{ field: "region", operator: "=", value: "US" }] });
    expect(filteredExact.rows).toHaveLength(4);
    expect(filteredExact.completeness.status).toBe("complete");

    const two = kernel(2, 100);
    const filteredAbove = await grouped(two, { filters: [{ field: "region", operator: "=", value: "US" }] });
    expect(filteredAbove.rows).toHaveLength(2);
    expect(filteredAbove.completeness.status).toBe("truncated");

    const ordered = await grouped(two, { order: [{ field: "revenue", direction: "desc" }] });
    expect(ordered.rows.map((r) => Number(r.revenue))).toEqual([120, 110]);
    expect(ordered.completeness.status).toBe("truncated");
  });

  it("max_rows binds a requested limit and can truncate that request", async () => {
    const k = kernel(1000, 5);
    const truncated = await grouped(k, { limit: 50 });
    expect(truncated.rows).toHaveLength(5);
    expect(truncated.completeness).toEqual({ status: "truncated", limit: 5, source: "max" });
    const exact = await grouped(kernel(1000, 12), { limit: 50 });
    expect(exact.rows).toHaveLength(12);
    expect(exact.completeness.status).toBe("complete");
    expect(exact.completeness.source).toBe("max");
  });

  it("scalar / global aggregates are complete one-row results", async () => {
    const k = kernel(5, 10);
    const global = await k.query({ metrics: ["revenue"], time: Q });
    expect(global.rows).toHaveLength(1);
    expect(Number(global.rows[0]!.revenue)).toBe(780);
    expect(global.completeness.status).toBe("complete");
    const ratio = await k.query({ metrics: ["aov"], time: Q });
    expect(ratio.rows).toHaveLength(1);
    expect(ratio.completeness.status).toBe("complete");
    expect(ratio.trust).toBe("governed");
  });

  it("multi-metric, ratio, mixed trust, and metric order share one completeness", async () => {
    const k = kernel(5, 100);
    const both = await k.query({
      metrics: ["revenue", "orders"],
      dimensions: ["customer_id"],
      time: Q,
    });
    expect(both.rows).toHaveLength(5);
    expect(both.completeness.status).toBe("truncated");
    const reversed = await k.query({
      metrics: ["orders", "revenue"],
      dimensions: ["customer_id"],
      time: Q,
    });
    expect(reversed.completeness).toEqual(both.completeness);
    const ratio = await k.query({ metrics: ["aov"], dimensions: ["customer_id"], time: Q });
    expect(ratio.completeness.status).toBe("truncated");
    const mixed = await k.query({
      metrics: ["trial_revenue"],
      dimensions: ["customer_id"],
      time: Q,
    });
    expect(mixed.trust).toBe("mixed");
    expect(mixed.completeness.status).toBe("truncated");
  });

  it("filters (eq, ne, in, contains, joined) affect completeness of the post-query set", async () => {
    const k = kernel(3, 100);
    const ne = await grouped(k, { filters: [{ field: "region", operator: "!=", value: "US" }] });
    expect(ne.rows).toHaveLength(3);
    expect(ne.completeness.status).toBe("truncated");
    const inn = await grouped(k, { filters: [{ field: "region", operator: "in", value: ["US"] }] });
    expect(inn.rows).toHaveLength(3);
    expect(inn.completeness.status).toBe("truncated");
    const contains = await grouped(k, { filters: [{ field: "channel", operator: "contains", value: "st" }] });
    expect(contains.rows.length).toBeGreaterThan(0);
    expect(contains.completeness.status).toBe(contains.rows.length < 3 ? "complete" : "truncated");
    const joined = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "status", operator: "=", value: "active" }],
      time: Q,
    });
    expect(joined.trust).toBe("governed");
    expect(joined.rows).toHaveLength(3);
    expect(joined.completeness.status).toBe("truncated");
    const metricFilter = await k.query({
      metrics: ["web_revenue"],
      dimensions: ["customer_id"],
      time: Q,
    });
    expect(metricFilter.completeness.source).toBe("default");
    const isNull = await grouped(k, { filters: [{ field: "region", operator: "is_null" }] });
    expect(isNull.rows).toEqual([]);
    expect(isNull.completeness.status).toBe("complete");
  });

  it("joined grouped query keeps cardinality refusals; completeness is only on success", async () => {
    const k = kernel(5);
    const ok = await k.query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    expect(ok.completeness.status).toBe("complete");
    await expect(k.query({ metrics: ["revenue"], dimensions: ["dup_label"], time: Q })).rejects.toBeInstanceOf(
      GraneError,
    );
  });

  it("MCP payload carries completeness next to rows and in provenance", async () => {
    const k = kernel(5);
    const result = await grouped(k);
    const text = mcpTrustText({
      trust: result.trust,
      columns: result.columns,
      rows: result.rows,
      completeness: result.completeness,
      provenance: result.provenance,
    });
    const payload = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
    expect(payload.completeness).toEqual({ status: "truncated", limit: 5, source: "default" });
    expect((payload.provenance as { completeness: unknown }).completeness).toEqual(payload.completeness);
    expect(JSON.stringify(payload.rows)).not.toContain(RESULT_TOTAL_COLUMN);
  });

  it("refusals do not attach completeness", () => {
    const k = kernel();
    try {
      k.compile({ metrics: ["not_a_metric"] });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect(JSON.stringify((err as GraneError).refusal)).not.toMatch(/completeness/);
    }
  });

  it("does not change trust when truncated", async () => {
    const k = kernel(3);
    const result = await grouped(k);
    expect(result.trust).toBe("governed");
    expect(result.completeness.status).toBe("truncated");
    expect(result.provenance.trust).toBe("governed");
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

describe.skipIf(!pgOk)("row-limit completeness (PostgreSQL)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_rl_${Date.now().toString(36)}`;
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

  function kernel(defaultRows = 5, maxRows = 100): GraneKernel {
    const k = new GraneKernel(config({ type: "postgres", url: PG_URL, schema: SCHEMA }, defaultRows, maxRows));
    kernels.push(k);
    return k;
  }

  it("exact cap complete, cap+1 truncated, semantic limit complete, no sentinel leak", async () => {
    const exact = await kernel(12).query({ metrics: ["revenue"], dimensions: ["customer_id"], time: Q });
    expect(exact.rows).toHaveLength(12);
    expect(exact.completeness.status).toBe("complete");
    const over = await kernel(5).query({ metrics: ["revenue"], dimensions: ["customer_id"], time: Q });
    expect(over.rows).toHaveLength(5);
    expect(over.completeness.status).toBe("truncated");
    expect(over.columns).not.toContain(RESULT_TOTAL_COLUMN);
    const top = await kernel(1000).query({
      metrics: ["revenue"],
      dimensions: ["customer_id"],
      time: Q,
      limit: 5,
      order: [{ field: "revenue", direction: "desc" }],
    });
    expect(top.completeness).toEqual({ status: "complete", limit: 5, source: "query" });
    expect(top.rows.map((r) => Number(r.revenue))).toEqual([120, 110, 100, 90, 80]);
  });
});
