/**
 * Metric-filter support consistency (PR #31).
 *
 * Merged-main failure: a metric-definition filter on an unreachable or
 * fan-out-only table compiled `FILTER (WHERE "ghost"."flag" = …)` / `"items"."sku"`
 * without joining that table. Model validate flagged `filter_out_of_scope`,
 * but MCP validate (explain) returned SQL and query hit DuckDB
 * `Binder Error: Referenced table "…" not found!`.
 *
 * Query filters that name a metric never become HAVING. They must not be
 * rewritten as a physical column of the same public name.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mcpTrustText } from "../../src/query/trust.js";
import { SemanticModel } from "../../src/model/model.js";
import { validateModel } from "../../src/validate/validate.js";

const execFileAsync = promisify(execFile);
const Q = { from: "2026-01-01", to: "2026-01-31" } as const;

const DDL = `
  CREATE TABLE sales (
    id INTEGER,
    customer_id INTEGER,
    amount DOUBLE PRECISION,
    sold_on DATE,
    revenue DOUBLE PRECISION,
    status VARCHAR
  );
  INSERT INTO sales VALUES
    (1, 1, 10, DATE '2026-01-15', 999, 'completed'),
    (2, 2, 20, DATE '2026-01-20', 999, 'completed'),
    (3, 2, 5,  DATE '2026-01-22', 999, 'pending'),
    (4, NULL, 7, DATE '2026-01-23', 999, 'completed');
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, country VARCHAR, code VARCHAR);
  INSERT INTO customers VALUES (1, 'US', 'JOIN'), (2, 'UK', 'JOIN');
  CREATE TABLE items (sale_id INTEGER, sku VARCHAR);
  INSERT INTO items VALUES (1, 'A'), (1, 'B');
  CREATE TABLE payments (sale_id INTEGER, amount DOUBLE PRECISION, status VARCHAR);
  INSERT INTO payments VALUES
    (1, 100, 'succeeded'),
    (2, 200, 'succeeded'),
    (3, 50, 'failed');
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION,
    book VARCHAR
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-01', 100, 'main'),
    (2, 1, DATE '2026-01-31', 110, 'main'),
    (3, 2, DATE '2026-01-31', 50, 'main');
`;

function baseMaps() {
  return {
    entities: {
      sale: { table: "sales", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
      item: { table: "items", primary_key: "sale_id" },
      snap: { table: "snapshots", primary_key: "row_id" },
    },
    metrics: {
      revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        synonyms: ["sales"],
      },
      orders: {
        entity: "sale",
        type: "count" as const,
        sql: "${sales.id}",
        time_dimension: "${sales.sold_on}",
      },
      aov: { entity: "sale", type: "ratio" as const, numerator: "revenue", denominator: "orders" },
      completed_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "completed" },
      },
      uk_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "customers.country": "UK" },
      },
      uk_completed: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "completed", "customers.country": "UK" },
      },
      ghost_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "ghost.flag": true },
      },
      sku_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "items.sku": "A" },
      },
      paid: {
        entity: "sale",
        type: "sum" as const,
        sql: "${payments.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "payments.status": "succeeded" },
      },
      uk_paid: {
        entity: "sale",
        type: "sum" as const,
        sql: "${payments.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "customers.country": "UK" },
      },
      avg_amount: {
        entity: "sale",
        type: "avg" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "customers.country": "UK" },
      },
      min_amount: {
        entity: "sale",
        type: "min" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "completed" },
      },
      max_amount: {
        entity: "sale",
        type: "max" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "completed" },
      },
      distinct_customers: {
        entity: "sale",
        type: "count_distinct" as const,
        sql: "${sales.customer_id}",
        time_dimension: "${sales.sold_on}",
        filters: { "customers.country": "UK" },
      },
      ending_bal: {
        entity: "snap",
        type: "sum" as const,
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi" as const,
        semi_additive: { window: "last" as const, group_by: [] as string[] },
      },
      main_ending: {
        entity: "snap",
        type: "sum" as const,
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi" as const,
        semi_additive: { window: "last" as const, group_by: [] as string[] },
        filters: { "snapshots.book": "main" },
      },
      joined_ending: {
        entity: "snap",
        type: "sum" as const,
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi" as const,
        semi_additive: { window: "last" as const, group_by: [] as string[] },
        filters: { "customers.country": "UK" },
      },
      trial_uk: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        status: "experimental" as const,
        filters: { "customers.country": "UK" },
      },
      dbt_ghost: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "ghost.flag": true },
        source: { provider: "dbt", path: "models.yml" },
      },
      filtered_aov: {
        entity: "sale",
        type: "ratio" as const,
        numerator: "revenue",
        denominator: "orders",
        filters: { "sales.status": "completed" },
      },
      code: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
      },
    },
    dimensions: {
      country: { entity: "customer", sql: "${customers.country}" },
      status: { entity: "sale", sql: "${sales.status}" },
      code: { entity: "sale", sql: "${sales.status}" },
      segment: { entity: "sale", sql: "${sales.status}" },
    },
    relationships: {
      sales_customers: {
        from: "sales.customer_id",
        to: "customers.customer_id",
        type: "many_to_one" as const,
      },
      sales_items: { from: "sales.id", to: "items.sale_id", type: "one_to_many" as const },
      sales_payments: { from: "payments.sale_id", to: "sales.id", type: "many_to_one" as const },
    },
  };
}

function config(connection: Record<string, unknown>, extra: Record<string, unknown> = {}, defaultRows = 1000) {
  return graneConfigSchema.parse({
    project: { name: "mfilter", timezone: "UTC" },
    connection,
    limits: { default_rows: defaultRows, max_rows: 10000, timeout_ms: 30000 },
    exploration: { enabled: true, schemas: ["main", "public"] },
    ...baseMaps(),
    ...extra,
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

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
const duckdbOk = await duckdbAvailable();

describe.skipIf(!duckdbOk)("metric-filter support consistency (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = await import("@duckdb/node-api");
    path = join(mkdtempSync(join(tmpdir(), "grane-mfilter-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(DDL);
    conn.closeSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(extra: Record<string, unknown> = {}, defaultRows = 1000): GraneKernel {
    const k = new GraneKernel(config({ type: "duckdb", path, schema: "main" }, extra, defaultRows));
    kernels.push(k);
    return k;
  }

  async function oracleNumber(sql: string): Promise<number> {
    const mod = await import("@duckdb/node-api");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    try {
      const reader = (await conn.runAndReadAll(sql)) as {
        getRowObjectsJS?: () => Record<string, unknown>[];
        getRowObjects?: () => Record<string, unknown>[];
      };
      const row = (reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? [])[0]!;
      return Number(Object.values(row)[0]);
    } finally {
      conn.closeSync?.();
      instance.closeSync?.();
    }
  }

  function expectSurfacesRefuse(k: GraneKernel, q: { metrics: string[]; dimensions?: string[]; time?: typeof Q }, status: string, needle: string) {
    const resolved = refusal(() => k.resolve(q));
    const compiled = refusal(() => k.compile(q));
    expect(resolved.status).toBe(status);
    expect(compiled.status).toBe(status);
    expect(resolved.message).toMatch(needle);
    expect(compiled.message).toMatch(needle);
    expect(JSON.stringify(resolved)).not.toMatch(/Binder Error/i);
    expect(JSON.stringify(compiled)).not.toMatch(/Binder Error/i);
  }

  it("historical class: unreachable ghost.flag is a Grane refusal on every query surface", async () => {
    const k = kernel();
    const q = { metrics: ["ghost_revenue"], time: Q };
    const report = k.validate();
    expect(report.ok).toBe(false);
    expect(report.metrics.find((m) => m.metric === "ghost_revenue")!.issues.some((i) => i.code === "filter_out_of_scope")).toBe(
      true,
    );
    expectSurfacesRefuse(k, q, "invalid_query", /ghost/);
    const explained = await refusalAsync(() => k.explain(q));
    const queried = await refusalAsync(() => k.query(q));
    expect(explained.status).toBe("invalid_query");
    expect(queried.status).toBe("invalid_query");
    expect(explained.message).toBe(queried.message);
    expect(queried.message).not.toMatch(/Binder Error/i);
  });

  it("historical class: one_to_many items.sku is unsafe_query, never a binder error", async () => {
    const k = kernel();
    const q = { metrics: ["sku_revenue"], time: Q };
    expect(k.validate().ok).toBe(false);
    expectSurfacesRefuse(k, q, "unsafe_query", /items/);
    const queried = await refusalAsync(() => k.query(q));
    expect(queried.status).toBe("unsafe_query");
    expect(queried.message).not.toMatch(/Binder Error|column not found|GROUP BY/i);
  });

  it("many_to_one parent filter is supported and oracle-correct (scalar)", async () => {
    const k = kernel();
    expect(k.validate().metrics.find((m) => m.metric === "uk_revenue")!.ok).toBe(true);
    const q = { metrics: ["uk_revenue"], time: Q };
    const explained = await k.explain(q);
    expect(explained.generated_sql).toMatch(/"customers"\."country"/);
    expect(explained.generated_sql).toMatch(/LEFT JOIN "customers"/);
    const result = await k.query(q);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.uk_revenue)).toBe(25);
    expect(Number(result.rows[0]!.uk_revenue)).not.toBe(999);
    const oracle = await oracleNumber(`
      SELECT SUM(s.amount) FROM sales s
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      WHERE s.sold_on >= DATE '2026-01-01' AND s.sold_on < DATE '2026-02-01'
        AND c.country = 'UK'
    `);
    expect(Number(result.rows[0]!.uk_revenue)).toBe(oracle);
  });

  it("grain-table metric filter is oracle-correct", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["completed_revenue"], time: Q });
    const oracle = await oracleNumber(`
      SELECT SUM(amount) FROM sales
      WHERE sold_on >= DATE '2026-01-01' AND sold_on < DATE '2026-02-01'
        AND status = 'completed'
    `);
    expect(Number(result.rows[0]!.completed_revenue)).toBe(oracle);
    expect(oracle).toBe(37);
  });

  it("grouped / time-grained / joined parent filters stay oracle-correct", async () => {
    const k = kernel();
    const grouped = await k.query({ metrics: ["uk_revenue"], dimensions: ["country"], time: Q });
    const uk = grouped.rows.find((r) => r.country === "UK");
    expect(Number(uk!.uk_revenue)).toBe(25);
    const grained = await k.query({ metrics: ["uk_revenue"], time: { ...Q, grain: "month" } });
    expect(grained.columns[0]).toBe("period_month");
    expect(Number(grained.rows[0]!.uk_revenue)).toBe(25);
    const joined = await k.query({
      metrics: ["uk_revenue"],
      dimensions: ["country"],
      filters: [{ field: "status", operator: "=", value: "completed" }],
      time: Q,
    });
    const ukDone = joined.rows.find((r) => r.country === "UK");
    expect(Number(ukDone!.uk_revenue)).toBe(20);
  });

  it("multiple metric-definition filters are order-independent", async () => {
    const k = kernel();
    const a = await k.query({ metrics: ["uk_completed"], time: Q });
    const flipped = kernel({
      metrics: {
        ...baseMaps().metrics,
        uk_completed: {
          ...baseMaps().metrics.uk_completed,
          filters: { "customers.country": "UK", "sales.status": "completed" },
        },
      },
    });
    const b = await flipped.query({ metrics: ["uk_completed"], time: Q });
    expect(Number(a.rows[0]!.uk_completed)).toBe(20);
    expect(Number(b.rows[0]!.uk_completed)).toBe(20);
  });

  it("AVG / MIN / MAX / COUNT DISTINCT parent or grain filters", async () => {
    const k = kernel();
    expect(Number((await k.query({ metrics: ["avg_amount"], time: Q })).rows[0]!.avg_amount)).toBe(12.5);
    expect(Number((await k.query({ metrics: ["min_amount"], time: Q })).rows[0]!.min_amount)).toBe(7);
    expect(Number((await k.query({ metrics: ["max_amount"], time: Q })).rows[0]!.max_amount)).toBe(20);
    const distinct = await k.query({ metrics: ["distinct_customers"], time: Q });
    expect(Number(distinct.rows[0]!.distinct_customers)).toBe(1);
    expect(distinct.provenance.generated_sql).toMatch(/COUNT\(DISTINCT/);
  });

  it("preagg measure-table filter and parent filter are oracle-correct", async () => {
    const k = kernel();
    const paid = await k.query({ metrics: ["paid"], time: Q });
    expect(Number(paid.rows[0]!.paid)).toBe(300);
    const ukPaid = await k.query({ metrics: ["uk_paid"], time: Q });
    const oracle = await oracleNumber(`
      SELECT SUM(p.amount) FROM payments p
      JOIN sales s ON p.sale_id = s.id
      LEFT JOIN customers c ON s.customer_id = c.customer_id
      WHERE s.sold_on >= DATE '2026-01-01' AND s.sold_on < DATE '2026-02-01'
        AND c.country = 'UK'
    `);
    expect(Number(ukPaid.rows[0]!.uk_paid)).toBe(oracle);
    expect(oracle).toBe(250);
    expect(ukPaid.provenance.generated_sql).toMatch(/LEFT JOIN "customers"/);
    expect(ukPaid.provenance.generated_sql).toMatch(/FILTER \(WHERE "customers"\."country"/);
    const cte = ukPaid.provenance.generated_sql.match(/"m_uk_paid" AS \(([\s\S]*?)\n\)/)?.[1] ?? "";
    expect(cte).toContain("payments");
    expect(cte).not.toContain("customers");
  });

  it("query filter on a metric name is invalid_query on every surface, even when a physical column shares the name", async () => {
    const k = kernel();
    const q = { metrics: ["revenue"], filters: [{ field: "revenue", operator: ">", value: 5 }], time: Q };
    expectSurfacesRefuse(k, q, "invalid_query", /metric "revenue"/);
    const explained = await refusalAsync(() => k.explain(q));
    const queried = await refusalAsync(() => k.query(q));
    expect(explained.status).toBe(queried.status);
    expect(queried.message).not.toMatch(/sales\.revenue|Binder Error/i);
    const other = { metrics: ["orders"], filters: [{ field: "revenue", operator: ">", value: 5 }], time: Q };
    expect(refusal(() => k.resolve(other)).status).toBe("invalid_query");
  });

  it("metric synonym in a query filter is refused, not bound as a dimension or column", () => {
    const k = kernel();
    expectSurfacesRefuse(
      k,
      { metrics: ["revenue"], filters: [{ field: "sales", operator: ">", value: 5 }], time: Q },
      "invalid_query",
      /metric "revenue"/,
    );
  });

  it("raw table.column filter on the physical revenue column is mixed exploration, not the metric", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "sales.revenue", operator: "=", value: 999 }],
      time: Q,
    });
    expect(result.trust).toBe("mixed");
    expect(Number(result.rows[0]!.revenue)).toBe(42);
  });

  it("filter-only dimension code does not collide with selected metric code (#30)", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["code"],
      filters: [{ field: "code", operator: "=", value: "completed" }],
      time: Q,
    });
    expect(result.columns).toEqual(["code"]);
    expect(Number(result.rows[0]!.code)).toBe(37);
    expect(refusal(() => k.resolve({ metrics: ["code"], dimensions: ["code"], time: Q })).status).toBe("ambiguous_query");
  });

  it("ratio-owned YAML filters refuse; component filters still apply through the component", async () => {
    const k = kernel();
    expect(k.validate().metrics.find((m) => m.metric === "filtered_aov")!.issues.some((i) => i.code === "filter_out_of_scope")).toBe(
      true,
    );
    expectSurfacesRefuse(k, { metrics: ["filtered_aov"], time: Q }, "invalid_query", /Ratio metric/);
    const ok = await k.query({ metrics: ["aov"], time: Q });
    expect(Number(ok.rows[0]!.aov)).toBeCloseTo(42 / 4);
  });

  it("query filter on a ratio name is invalid_query, not HAVING", () => {
    const k = kernel();
    expectSurfacesRefuse(
      k,
      { metrics: ["aov"], filters: [{ field: "aov", operator: ">", value: 0 }], time: Q },
      "invalid_query",
      /metric "aov"/,
    );
  });

  it("semi-additive grain filter is snapshot-correct; joined semi-additive filter is refused", async () => {
    const k = kernel();
    const main = await k.query({ metrics: ["main_ending"], time: Q });
    expect(Number(main.rows[0]!.main_ending)).toBe(160);
    expectSurfacesRefuse(k, { metrics: ["joined_ending"], time: Q }, "unsafe_query", /before the snapshot/);
    const unfiltered = await k.query({ metrics: ["ending_bal"], time: Q });
    expect(Number(unfiltered.rows[0]!.ending_bal)).toBe(160);
  });

  it("raw metric alias in a query filter is refused; qualified raw metric still works", async () => {
    const k = kernel();
    expectSurfacesRefuse(
      k,
      {
        metrics: [],
        raw_metrics: [{ field: "sales.amount", type: "sum", alias: "tot" }],
        filters: [{ field: "tot", operator: ">", value: 0 }],
        time: { ...Q, dimension: "sales.sold_on" },
      },
      "invalid_query",
      /raw metric alias/,
    );
    const ok = await k.query({
      metrics: [],
      raw_metrics: [{ field: "sales.amount", type: "sum", alias: "tot" }],
      time: { ...Q, dimension: "sales.sold_on" },
    });
    expect(ok.trust).toBe("exploratory");
    expect(Number(ok.rows[0]!.tot)).toBe(42);
  });

  it("NULL / unmatched join groups: parent equality filter excludes NULL country", async () => {
    const k = kernel();
    const uk = await k.query({ metrics: ["uk_revenue"], time: Q });
    expect(Number(uk.rows[0]!.uk_revenue)).toBe(25);
    const all = await k.query({ metrics: ["revenue"], time: Q });
    expect(Number(all.rows[0]!.revenue)).toBe(42);
  });

  it("experimental parent-filter metric stays mixed; deprecated grain filter stays governed", async () => {
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        old_uk: {
          ...baseMaps().metrics.uk_revenue,
          status: "deprecated" as const,
        },
      },
    });
    const trial = await kernel().query({ metrics: ["trial_uk"], time: Q });
    expect(trial.trust).toBe("mixed");
    expect(Number(trial.rows[0]!.trial_uk)).toBe(25);
    const old = await k.query({ metrics: ["old_uk"], time: Q });
    expect(old.trust).toBe("governed");
    expect(Number(old.rows[0]!.old_uk)).toBe(25);
  });

  it("provider-imported ghost filter is refused at query time, not executed as governed", async () => {
    const k = kernel();
    expectSurfacesRefuse(k, { metrics: ["dbt_ghost"], time: Q }, "invalid_query", /ghost/);
  });

  it("completeness describes the post-filter result; no __grane_n leak", async () => {
    const capped = kernel({}, 1);
    const truncated = await capped.query({ metrics: ["uk_revenue"], dimensions: ["country"], time: Q });
    expect(truncated.completeness.status).toBe("truncated");
    expect(truncated.columns).not.toContain(RESULT_TOTAL_COLUMN);
    expect(truncated.columns).not.toContain(RESULT_ROW_COLUMN);
    const top = await kernel().query({
      metrics: ["uk_revenue"],
      dimensions: ["country"],
      time: Q,
      limit: 1,
    });
    expect(top.completeness).toEqual({ status: "complete", limit: 1, source: "query" });
  });

  it("select A filter-definition B (paid selected, uk_revenue not selected) does not require B's alias", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["paid"], time: Q });
    expect(result.columns).toEqual(["paid"]);
    expect(Number(result.rows[0]!.paid)).toBe(300);
  });

  it("PR #29 period_month + grain=month remains ambiguous_query", () => {
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        period_month: baseMaps().metrics.revenue,
      },
    });
    expect(refusal(() => k.resolve({ metrics: ["period_month"], time: { ...Q, grain: "month" } })).status).toBe(
      "ambiguous_query",
    );
  });

  it("PR #28 reserved names remain closed", () => {
    expect(refusal(() => kernel({ metrics: { ...baseMaps().metrics, __grane_n: baseMaps().metrics.revenue } })).status).toBe(
      "config_error",
    );
  });

  it("MCP validate/query text agrees for supported and unsupported cases", async () => {
    const k = kernel();
    const ok = await k.explain({ metrics: ["uk_revenue"], time: Q });
    const ran = await k.query({ metrics: ["uk_revenue"], time: Q });
    expect(ok.trust).toBe(ran.trust);
    const text = mcpTrustText({
      trust: ran.trust,
      columns: ran.columns,
      rows: ran.rows,
      completeness: ran.completeness,
      provenance: ran.provenance,
    });
    expect(text).toMatch(/governed/i);
    const badExplain = await refusalAsync(() => k.explain({ metrics: ["ghost_revenue"], time: Q }));
    const badQuery = await refusalAsync(() => k.query({ metrics: ["ghost_revenue"], time: Q }));
    expect(badExplain).toEqual(badQuery);
  });

  it("all dialects compile supported metric-filter SQL; unsupported refuses before dialect SQL", () => {
    const k = kernel();
    for (const type of WAREHOUSE_TYPES) {
      k.config.connection.type = type;
      if (type === "bigquery") {
        k.config.connection.project = "acme";
        k.config.connection.dataset = "analytics";
      }
      if (type === "databricks") {
        k.config.connection.catalog = "main";
        k.config.connection.schema = "main";
      }
      const { compiled } = k.compile({ metrics: ["uk_revenue"], time: Q });
      expect(compiled.sql, type).toMatch(/country/);
      expect(compiled.sql, type).not.toMatch(/ghost/);
      const refused = refusal(() => k.compile({ metrics: ["ghost_revenue"], time: Q }));
      expect(refused.status, type).toBe("invalid_query");
    }
  });

  it("CLI --sql and query refuse the historical ghost filter with a Grane status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-mfilter-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:\n  name: cli-mfilter\n  timezone: UTC\nconnection:\n  type: duckdb\n  path: ${JSON.stringify(path)}\n  schema: main\n`,
    );
    writeFileSync(
      join(dir, "model.yml"),
      `entities:
  sale:
    table: sales
    primary_key: id
  customer:
    table: customers
    primary_key: customer_id
metrics:
  ghost_revenue:
    entity: sale
    type: sum
    sql: "\${sales.amount}"
    time_dimension: "\${sales.sold_on}"
    filters:
      ghost.flag: true
  uk_revenue:
    entity: sale
    type: sum
    sql: "\${sales.amount}"
    time_dimension: "\${sales.sold_on}"
    filters:
      customers.country: UK
dimensions:
  country:
    entity: customer
    sql: "\${customers.country}"
relationships:
  sales_customers:
    from: sales.customer_id
    to: customers.customer_id
    type: many_to_one
`,
    );
    mkdirSync(join(dir, "unused"), { recursive: true });
    const cli = join(process.cwd(), "src/cli/index.ts");
    const run = async (args: string[]) => {
      try {
        const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], {
          cwd: process.cwd(),
          timeout: 30000,
        });
        return { code: 0, stdout: out.stdout, stderr: out.stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    };
    const sql = await run(["query", "ghost_revenue", "--from", "2026-01-01", "--to", "2026-01-31", "--sql"]);
    const exec = await run(["query", "ghost_revenue", "--from", "2026-01-01", "--to", "2026-01-31", "--json"]);
    expect(sql.code).not.toBe(0);
    expect(exec.code).not.toBe(0);
    expect(sql.stderr + sql.stdout).toMatch(/ERROR \(invalid_query\)/);
    const refused = JSON.parse(exec.stdout) as { ok: false; status: string };
    expect(refused).toMatchObject({ ok: false, status: "invalid_query" });
    expect(sql.stderr + exec.stderr).not.toMatch(/Binder Error/i);
    const ok = await run(["query", "uk_revenue", "--from", "2026-01-01", "--to", "2026-01-31", "--json"]);
    expect(ok.code).toBe(0);
    const payload = JSON.parse(ok.stdout) as { rows: { uk_revenue: number }[]; trust: string };
    expect(payload.trust).toBe("governed");
    expect(Number(payload.rows[0]!.uk_revenue)).toBe(25);
  });
});

describe("metric-filter bind-scope is structural (no warehouse)", () => {
  it("model validate and resolve agree on ghost vs parent filters using example relationships", () => {
    const cfg = config({ type: "postgres", schema: "public" });
    const model = new SemanticModel(cfg);
    const report = validateModel(model);
    expect(report.metrics.find((m) => m.metric === "ghost_revenue")!.ok).toBe(false);
    expect(report.metrics.find((m) => m.metric === "uk_revenue")!.ok).toBe(true);
    expect(report.metrics.find((m) => m.metric === "sku_revenue")!.ok).toBe(false);
    expect(report.metrics.find((m) => m.metric === "paid")!.ok).toBe(true);
    const k = new GraneKernel(cfg);
    expect(refusal(() => k.resolve({ metrics: ["ghost_revenue"], time: Q })).status).toBe("invalid_query");
    expect(k.resolve({ metrics: ["uk_revenue"], time: Q }).metrics[0]!.name).toBe("uk_revenue");
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

describe.skipIf(!(await postgresUp()))("metric-filter support (PostgreSQL)", () => {
  it("executes the supported parent filter and refuses the historical ghost class", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL });
    const schema = `mfilter_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    const ddl = DDL.replaceAll("DOUBLE PRECISION", "DOUBLE PRECISION").replaceAll("VARCHAR", "TEXT");
    await pool.query(`SET search_path TO ${schema}`);
    for (const stmt of ddl.split(";").map((s) => s.trim()).filter(Boolean)) {
      await pool.query(stmt);
    }
    const k = new GraneKernel(
      config({ type: "postgres", url: PG_URL, schema }),
    );
    try {
      const ok = await k.query({ metrics: ["uk_revenue"], time: Q });
      expect(Number(ok.rows[0]!.uk_revenue)).toBe(25);
      const bad = await refusalAsync(() => k.query({ metrics: ["ghost_revenue"], time: Q }));
      expect(bad.status).toBe("invalid_query");
      expect(bad.message).not.toMatch(/Binder|does not exist/i);
    } finally {
      await k.close();
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
});
