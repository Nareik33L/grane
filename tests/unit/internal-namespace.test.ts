/**
 * Internal `__grane_` namespace must not collide with user analytical fields.
 *
 * Current-main (pre-fix) failure: a metric named `__grane_row` compiled
 * `SUM(...) AS "__grane_row"` next to `1 AS "__grane_row"`. Hidden-column
 * cleanup stripped the name. The query succeeded; the requested field was gone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import {
  INTERNAL_IDENT_PREFIX,
  isReservedInternalIdent,
} from "../../src/compile/internal-namespace.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mergeContributions } from "../../src/providers/merge.js";
import { emptyContribution } from "../../src/providers/types.js";
import { mcpTrustText } from "../../src/query/trust.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";

const DDL = `
  CREATE TABLE sales (
    id INTEGER,
    customer_id INTEGER,
    segment VARCHAR,
    amount DOUBLE PRECISION,
    sold_on DATE,
    "__grane_row" DOUBLE PRECISION
  );
  INSERT INTO sales VALUES
    (1, 1, 'A', 100, DATE '2026-01-01', 1),
    (2, 2, NULL, NULL, DATE '2026-01-02', 2);
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, country VARCHAR);
  INSERT INTO customers VALUES (1, 'US'), (2, NULL);
  CREATE TABLE dim_dup (customer_id INTEGER, label VARCHAR);
  INSERT INTO dim_dup VALUES (1, 'x'), (1, 'y');
`;

const Q = { from: "2026-01-01", to: "2026-01-31" } as const;

function baseMaps() {
  return {
    entities: {
      sale: { table: "sales", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
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
      trial_revenue: {
        entity: "sale",
        type: "sum",
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        status: "experimental" as const,
      },
      grane_row: {
        entity: "sale",
        type: "sum",
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
      },
    },
    dimensions: {
      segment: { entity: "sale", sql: "${sales.segment}" },
      country: { entity: "customer", sql: "${customers.country}" },
      dup_label: { entity: "dup", sql: "${dim_dup.label}" },
    },
    relationships: {
      sales_customers: {
        from: "sales.customer_id",
        to: "customers.customer_id",
        type: "many_to_one" as const,
      },
      sales_dups: { from: "sales.customer_id", to: "dim_dup.customer_id", type: "many_to_one" as const },
    },
  };
}

function config(connection: Record<string, unknown>, extra: Record<string, unknown> = {}, defaultRows = 1000) {
  return graneConfigSchema.parse({
    project: { name: "ns", timezone: "UTC" },
    connection,
    limits: { default_rows: defaultRows, max_rows: 10000, timeout_ms: 30000 },
    exploration: { enabled: true, schemas: ["main", "public"] },
    ...baseMaps(),
    ...extra,
  });
}

function expectRefuse(fn: () => unknown, status: string, ident: string) {
  try {
    fn();
    throw new Error("expected refusal");
  } catch (err) {
    expect(err).toBeInstanceOf(GraneError);
    const refusal = (err as GraneError).refusal;
    expect(refusal.status).toBe(status);
    expect(refusal.message).toContain(INTERNAL_IDENT_PREFIX);
    expect(refusal.message).toContain(ident);
    expect(JSON.stringify(refusal.details)).toContain(ident);
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

describe("isReservedInternalIdent", () => {
  it("reserves the __grane_ prefix case-insensitively and leaves nearby names alone", () => {
    for (const name of [
      "__grane_row",
      "__grane_n",
      "__grane_card_0",
      "__grane_card_1",
      "__grane_pop",
      "__grane_pop_0",
      "__grane_result",
      "__grane_guard",
      "__grane_metric",
      "__grane_ratio",
      "__grane_",
      "__grane_row_extra",
      "__GRANE_ROW",
      "__GrAnE_rOw",
    ]) {
      expect(isReservedInternalIdent(name), name).toBe(true);
    }
    for (const name of ["grane_row", "_grane_row", "___grane_row", "__grane", "x__grane_row", "revenue"]) {
      expect(isReservedInternalIdent(name), name).toBe(false);
    }
  });
});

describe("native YAML reservation", () => {
  const connection = { type: "duckdb", path: ":memory:", schema: "main" };

  it("I1–I10: reserved metric/dimension/entity/table names are config_error", () => {
    const cases: Array<{ ident: string; patch: Record<string, unknown> }> = [
      { ident: "__grane_row", patch: { metrics: { ...baseMaps().metrics, __grane_row: baseMaps().metrics.revenue } } },
      { ident: "__grane_n", patch: { dimensions: { ...baseMaps().dimensions, __grane_n: baseMaps().dimensions.segment } } },
      { ident: "__grane_card_0", patch: { metrics: { ...baseMaps().metrics, __grane_card_0: baseMaps().metrics.revenue } } },
      { ident: "__grane_card_1", patch: { metrics: { ...baseMaps().metrics, __grane_card_1: baseMaps().metrics.revenue } } },
      { ident: "__grane_pop", patch: { entities: { ...baseMaps().entities, __grane_pop: { table: "sales", primary_key: "id" } } } },
      { ident: "__grane_pop_0", patch: { entities: { ...baseMaps().entities, sale: { table: "__grane_pop_0", primary_key: "id" } } } },
      { ident: "__grane_result", patch: { entities: { ...baseMaps().entities, sale: { table: "__grane_result", primary_key: "id" } } } },
      { ident: "__grane_guard", patch: { metrics: { ...baseMaps().metrics, __grane_guard: baseMaps().metrics.revenue } } },
      { ident: "__grane_metric", patch: { dimensions: { ...baseMaps().dimensions, __grane_metric: baseMaps().dimensions.segment } } },
      { ident: "__grane_ratio", patch: { metrics: { ...baseMaps().metrics, __grane_ratio: baseMaps().metrics.revenue } } },
    ];
    for (const c of cases) {
      expectRefuse(() => new GraneKernel(config(connection, c.patch)), "config_error", c.ident);
    }
  });

  it("case variants of __grane_row are reserved", () => {
    expectRefuse(
      () =>
        new GraneKernel(
          config(connection, {
            metrics: { ...baseMaps().metrics, __GRANE_ROW: baseMaps().metrics.revenue },
          }),
        ),
      "config_error",
      "__GRANE_ROW",
    );
  });

  it("harmless nearby names construct", () => {
    for (const name of ["grane_row", "_grane_row", "___grane_row", "__grane", "x__grane_row"]) {
      const k = new GraneKernel(
        config(connection, {
          metrics: { ...baseMaps().metrics, [name]: baseMaps().metrics.revenue },
        }),
      );
      expect(k.model.metrics.has(name)).toBe(true);
    }
  });
});

describe("provider imports cannot bypass reservation", () => {
  it("skips reserved metric names as unsupported", () => {
    const part = emptyContribution();
    part.metrics.__grane_row = {
      entity: "sale",
      type: "sum",
      sql: "${sales.amount}",
      source: { provider: "dbt", path: "models.yml" },
    };
    part.metrics.revenue = { entity: "sale", type: "sum", sql: "${sales.amount}", source: { provider: "dbt" } };
    const merged = mergeContributions([part]);
    expect(merged.metrics.__grane_row).toBeUndefined();
    expect(merged.metrics.revenue).toBeDefined();
    expect(merged.unsupported.some((u) => u.name === "__grane_row" && u.kind === "metric")).toBe(true);
  });
});

describe.skipIf(!duckdbOk)("namespace at execution (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = await import("@duckdb/node-api");
    path = join(mkdtempSync(join(tmpdir(), "grane-ns-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(DDL);
    conn.closeSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(defaultRows = 1000): GraneKernel {
    const k = new GraneKernel(config({ type: "duckdb", path, schema: "main" }, {}, defaultRows));
    kernels.push(k);
    return k;
  }

  function expectNoInternalLeak(result: { columns: string[]; rows: Record<string, unknown>[] }) {
    for (const col of result.columns) expect(isReservedInternalIdent(col), col).toBe(false);
    for (const row of result.rows) {
      for (const key of Object.keys(row)) expect(isReservedInternalIdent(key), key).toBe(false);
    }
  }

  it("current-main failure class: metric __grane_row is refused, not stripped", () => {
    expectRefuse(
      () =>
        new GraneKernel(
          config(
            { type: "duckdb", path, schema: "main" },
            { metrics: { __grane_row: baseMaps().metrics.revenue } },
          ),
        ),
      "config_error",
      "__grane_row",
    );
  });

  it("Q1–Q16 non-colliding shapes keep user columns and hide internals", async () => {
    const k = kernel();
    const shapes = [
      { metrics: ["revenue"], time: Q },
      { metrics: ["revenue"], dimensions: ["segment"], time: Q },
      { metrics: ["revenue"], dimensions: ["segment", "country"], time: Q },
      { metrics: ["revenue", "orders"], dimensions: ["segment"], time: Q },
      { metrics: ["aov"], time: Q },
      { metrics: ["revenue"], filters: [{ field: "segment", operator: "=", value: "A" }], time: Q },
      { metrics: ["revenue"], time: { ...Q, grain: "month" as const } },
      { metrics: ["revenue"], dimensions: ["country"], time: Q },
      { metrics: ["revenue"], dimensions: ["country"], time: Q },
      { metrics: ["revenue"], time: Q },
      { metrics: ["grane_row"], time: Q },
      { metrics: ["revenue"], dimensions: ["segment"], time: Q, limit: 5 },
      { metrics: ["revenue"], dimensions: ["segment"], time: Q },
    ];
    for (const q of shapes) {
      const result = await k.query(q);
      expect(result.rows.length).toBeGreaterThan(0);
      expectNoInternalLeak(result);
      expect(result.completeness).toEqual(result.provenance.completeness);
    }
    await expect(k.query({ metrics: ["revenue"], dimensions: ["dup_label"], time: Q })).rejects.toBeInstanceOf(
      GraneError,
    );
  });

  it("harmless grane_row metric survives execution with value 100+NULL", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["grane_row"], time: Q });
    expect(result.columns).toContain("grane_row");
    expect(Number(result.rows[0]!.grane_row)).toBe(100);
    expect(result.trust).toBe("governed");
    expectNoInternalLeak(result);
  });

  it("raw physical column sales.__grane_row is preserved (mixed grouped)", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["sales.__grane_row"],
      time: Q,
    });
    expect(result.trust).toBe("mixed");
    expect(result.columns).toContain("revenue");
    expect(result.columns).toContain("sales.__grane_row");
    expect(result.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(result.rows.length).toBeGreaterThan(0);
    expectNoInternalLeak(result);
  });

  it("raw metric alias __grane_row is invalid_query; explain agrees", async () => {
    const k = kernel();
    const q = { raw_metrics: [{ field: "sales.amount", type: "sum" as const, alias: "__grane_row" }], time: Q };
    expectRefuse(() => k.compile(q), "invalid_query", "__grane_row");
    await expect(k.explain(q)).rejects.toBeInstanceOf(GraneError);
    const report = k.validate();
    expect(report.ok).toBe(true);
  });

  it("MCP refusal for reserved raw alias; success payload has no internals", async () => {
    const k = kernel();
    try {
      k.compile({ raw_metrics: [{ field: "sales.amount", type: "sum", alias: "__grane_n" }], time: Q });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("invalid_query");
    }
    const result = await k.query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    const text = mcpTrustText({
      trust: result.trust,
      columns: result.columns,
      rows: result.rows,
      completeness: result.completeness,
      provenance: result.provenance,
    });
    const payload = JSON.parse(text.slice(text.indexOf("{"))) as { columns: string[]; rows: Record<string, unknown>[] };
    expect(payload.columns).toEqual(result.columns);
    expect(payload.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(payload.columns).not.toContain(RESULT_TOTAL_COLUMN);
  });

  it("PR #27: real all-NULL joined group survives; empty grouped query stays empty", async () => {
    const k = kernel();
    const real = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "segment", operator: "is_null" }],
      time: Q,
    });
    expect(real.rows).toHaveLength(1);
    expect(real.rows[0]!.country).toBeNull();
    expect(real.rows[0]!.revenue).toBeNull();
    expect(real.trust).toBe("governed");
    expect(real.completeness.status).toBe("complete");
    expectNoInternalLeak(real);
    const empty = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "segment", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(empty.rows).toEqual([]);
    expect(empty.completeness.status).toBe("complete");
  });

  it("PR #26: below-cap complete, exact-cap complete, cap+1 truncated, semantic top-N complete", async () => {
    const uncapped = await kernel(1000).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    const n = uncapped.rows.length;
    expect(n).toBeGreaterThan(0);
    expect(uncapped.completeness.status).toBe("complete");
    const exact = await kernel(n).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
    expect(exact.rows).toHaveLength(n);
    expect(exact.completeness.status).toBe("complete");
    expect(exact.provenance.completeness).toEqual(exact.completeness);
    if (n > 1) {
      const plus = await kernel(n - 1).query({ metrics: ["revenue"], dimensions: ["country"], time: Q });
      expect(plus.rows).toHaveLength(n - 1);
      expect(plus.completeness.status).toBe("truncated");
    }
    const top = await kernel(1000).query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: Q,
      limit: 1,
    });
    expect(top.completeness).toEqual({ status: "complete", limit: 1, source: "query" });
    expectNoInternalLeak(top);
  });

  it("trust remains orthogonal: governed, mixed, exploratory", async () => {
    const k = kernel(1);
    const gov = await k.query({ metrics: ["revenue"], time: Q });
    expect(gov.trust).toBe("governed");
    const mixed = await k.query({ metrics: ["trial_revenue"], dimensions: ["country"], time: Q });
    expect(mixed.trust).toBe("mixed");
    expect(mixed.completeness.status).toBe("truncated");
  });

  it("all dialects still emit internal markers off plan.columns", () => {
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
      const { compiled } = k.compile({ metrics: ["revenue"], dimensions: ["country"], time: Q });
      expect(compiled.sql, type).toMatch(/__grane_row/);
      expect(compiled.plan.columns, type).not.toContain(RESULT_ROW_COLUMN);
      expect(compiled.plan.columns, type).not.toContain(RESULT_TOTAL_COLUMN);
    }
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

describe.skipIf(!pgOk)("namespace at execution (PostgreSQL)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_ns_${Date.now().toString(36)}`;
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

  it("refuses reserved metric names and preserves a harmless grane_row metric", async () => {
    expectRefuse(
      () =>
        new GraneKernel(
          config({ type: "postgres", url: PG_URL, schema: SCHEMA }, { metrics: { __grane_row: baseMaps().metrics.revenue } }),
        ),
      "config_error",
      "__grane_row",
    );
    const k = new GraneKernel(config({ type: "postgres", url: PG_URL, schema: SCHEMA }));
    kernels.push(k);
    const result = await k.query({ metrics: ["grane_row"], time: Q });
    expect(Number(result.rows[0]!.grane_row)).toBe(100);
    expect(result.columns).not.toContain(RESULT_ROW_COLUMN);
  });
});
