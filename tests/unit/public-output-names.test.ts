/**
 * Selected public output names must be unique before SQL.
 *
 * Merged-main failure: metric `code` + dimension `code` compiled
 * `fct_rev.code AS "code"` next to `SUM(...) AS "code"`. DuckDB exposed
 * `code` / `code:1` while Grane declared duplicate result.columns.
 * The query succeeded as governed/complete.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { isReservedInternalIdent } from "../../src/compile/internal-namespace.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mergeContributions } from "../../src/providers/merge.js";
import { emptyContribution } from "../../src/providers/types.js";
import { mcpTrustText } from "../../src/query/trust.js";

const DDL = `
  CREATE TABLE fct_rev (
    id INTEGER,
    customer_id INTEGER,
    segment VARCHAR,
    code VARCHAR,
    amount DOUBLE PRECISION,
    sold_on DATE,
    "__grane_row" DOUBLE PRECISION
  );
  INSERT INTO fct_rev VALUES
    (1, 1, 'A', NULL, 40, DATE '2026-01-15', 1),
    (2, 2, 'B', NULL, 50, DATE '2026-01-20', 2),
    (3, 2, NULL, NULL, NULL, DATE '2026-01-22', 3);
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, country VARCHAR, code VARCHAR);
  INSERT INTO customers VALUES (1, 'US', 'JOIN'), (2, NULL, 'JOIN');
  CREATE TABLE dim_dup (customer_id INTEGER, label VARCHAR);
  INSERT INTO dim_dup VALUES (1, 'x'), (1, 'y');
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-01', 100),
    (2, 1, DATE '2026-01-31', 110);
`;

const Q = { from: "2026-01-01", to: "2026-01-31" } as const;

function baseMaps() {
  return {
    entities: {
      sale: { table: "fct_rev", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
      dup: { table: "dim_dup", primary_key: "customer_id" },
      snap: { table: "snapshots", primary_key: "row_id" },
    },
    metrics: {
      revenue: {
        entity: "sale",
        type: "sum",
        sql: "${fct_rev.amount}",
        time_dimension: "${fct_rev.sold_on}",
        synonyms: ["sales"],
      },
      orders: {
        entity: "sale",
        type: "count",
        sql: "${fct_rev.id}",
        time_dimension: "${fct_rev.sold_on}",
      },
      aov: { entity: "sale", type: "ratio", numerator: "revenue", denominator: "orders" },
      trial_revenue: {
        entity: "sale",
        type: "sum",
        sql: "${fct_rev.amount}",
        time_dimension: "${fct_rev.sold_on}",
        status: "experimental" as const,
      },
      ending_bal: {
        entity: "snap",
        type: "sum",
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi" as const,
        semi_additive: { window: "last" as const, group_by: [] as string[] },
      },
    },
    dimensions: {
      segment: { entity: "sale", sql: "${fct_rev.segment}" },
      country: { entity: "customer", sql: "${customers.country}" },
      dup_label: { entity: "dup", sql: "${dim_dup.label}" },
    },
    relationships: {
      sales_customers: {
        from: "fct_rev.customer_id",
        to: "customers.customer_id",
        type: "many_to_one" as const,
      },
      sales_dups: { from: "fct_rev.customer_id", to: "dim_dup.customer_id", type: "many_to_one" as const },
    },
  };
}

function config(connection: Record<string, unknown>, extra: Record<string, unknown> = {}, defaultRows = 1000) {
  return graneConfigSchema.parse({
    project: { name: "public-out", timezone: "UTC" },
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
    expect(refusal.message).toContain(ident);
    expect(JSON.stringify(refusal.details)).toContain(ident);
  }
}

function expectUniqueSchema(result: { columns: string[]; rows: Record<string, unknown>[] }) {
  expect(new Set(result.columns).size).toBe(result.columns.length);
  for (const col of result.columns) {
    expect(isReservedInternalIdent(col), col).toBe(false);
    expect(col.includes(":")).toBe(false);
  }
  for (const row of result.rows) {
    expect(Object.keys(row).sort()).toEqual([...result.columns].sort());
    for (const key of Object.keys(row)) expect(key.includes(":")).toBe(false);
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

describe("model load allows coexisting metric and dimension of the same name", () => {
  it("constructs metric code + dimension code", () => {
    const k = new GraneKernel(
      config(
        { type: "duckdb", path: ":memory:", schema: "main" },
        {
          metrics: { ...baseMaps().metrics, code: baseMaps().metrics.revenue },
          dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
        },
      ),
    );
    expect(k.model.metrics.has("code")).toBe(true);
    expect(k.model.dimensions.has("code")).toBe(true);
  });
});

describe("provider imports keep coexisting names", () => {
  it("does not skip imported metric and dimension both named code", () => {
    const part = emptyContribution();
    part.metrics.code = {
      entity: "sale",
      type: "sum",
      sql: "${fct_rev.amount}",
      source: { provider: "dbt", path: "models.yml" },
    };
    part.dimensions.code = {
      entity: "sale",
      sql: "${fct_rev.code}",
      source: { provider: "cube" },
    };
    const merged = mergeContributions([part]);
    expect(merged.metrics.code).toBeDefined();
    expect(merged.dimensions.code).toBeDefined();
    expect(merged.unsupported).toEqual([]);
  });
});

describe.skipIf(!duckdbOk)("public output uniqueness (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = await import("@duckdb/node-api");
    path = join(mkdtempSync(join(tmpdir(), "grane-public-out-")), "db.duckdb");
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

  const codeModel = {
    metrics: { ...baseMaps().metrics, code: baseMaps().metrics.revenue },
    dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
  };

  it("A: metric code + dimension code is ambiguous_query (no grain)", () => {
    const k = kernel(codeModel);
    const q = { metrics: ["code"], dimensions: ["code"], time: Q };
    expectRefuse(() => k.resolve(q), "ambiguous_query", "code");
    expectRefuse(() => k.compile(q), "ambiguous_query", "code");
    expect(k.validate().ok).toBe(true);
  });

  it("order independence: metric/dimension permutations refuse the same way", () => {
    const k = kernel(codeModel);
    for (const q of [
      { metrics: ["code", "revenue"], dimensions: ["code"], time: Q },
      { metrics: ["revenue", "code"], dimensions: ["code"], time: Q },
      { metrics: ["code"], dimensions: ["code", "segment"], time: Q },
      { metrics: ["code"], dimensions: ["segment", "code"], time: Q },
    ]) {
      expectRefuse(() => k.compile(q), "ambiguous_query", "code");
    }
  });

  it("B: governed metric + raw metric is already invalid_query (mix)", () => {
    const k = kernel();
    try {
      k.compile({
        metrics: ["revenue"],
        raw_metrics: [{ field: "fct_rev.amount", type: "sum", alias: "revenue" }],
        time: Q,
      });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toMatch(/raw_metrics/);
    }
  });

  it("C: governed metric revenue + raw dimension fct_rev.code is unique", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["fct_rev.code"],
      time: Q,
    });
    expect(result.columns).toEqual(["fct_rev.code", "revenue"]);
    expectUniqueSchema(result);
    expect(result.trust).toBe("mixed");
  });

  it("D: raw metric alias code + dimension code is ambiguous_query", () => {
    const k = kernel({
      dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
    });
    expectRefuse(
      () =>
        k.compile({
          raw_metrics: [{ field: "fct_rev.amount", type: "sum", alias: "code" }],
          dimensions: ["code"],
          time: { ...Q, dimension: "fct_rev.sold_on" },
        }),
      "ambiguous_query",
      "code",
    );
  });

  it("E: dimension code + raw dimension fct_rev.code is unique", async () => {
    const k = kernel({
      dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.segment}" } },
    });
    const result = await k.query({
      metrics: ["revenue"],
      dimensions: ["code"],
      raw_dimensions: ["fct_rev.code"],
      time: Q,
    });
    expect(result.columns).toEqual(["code", "fct_rev.code", "revenue"]);
    expectUniqueSchema(result);
  });

  it("F: raw metric alias code + raw dimension fct_rev.code is unique", async () => {
    const k = kernel();
    const result = await k.query({
      raw_metrics: [{ field: "fct_rev.amount", type: "sum", alias: "code" }],
      raw_dimensions: ["fct_rev.code"],
      time: { ...Q, dimension: "fct_rev.sold_on" },
    });
    expect(result.columns).toEqual(["fct_rev.code", "code"]);
    expectUniqueSchema(result);
    expect(result.trust).toBe("exploratory");
  });

  it("G: two raw metrics with the same alias refuse; identical duplicates dedupe", async () => {
    const k = kernel();
    expectRefuse(
      () =>
        k.compile({
          raw_metrics: [
            { field: "fct_rev.amount", type: "sum", alias: "code" },
            { field: "fct_rev.id", type: "count", alias: "code" },
          ],
          time: { ...Q, dimension: "fct_rev.sold_on" },
        }),
      "ambiguous_query",
      "code",
    );
    const result = await k.query({
      raw_metrics: [
        { field: "fct_rev.amount", type: "sum", alias: "tot" },
        { field: "fct_rev.amount", type: "sum", alias: "tot" },
      ],
      time: { ...Q, dimension: "fct_rev.sold_on" },
    });
    expect(result.columns).toEqual(["tot"]);
    expectUniqueSchema(result);
    expect(Number(result.rows[0]!.tot)).toBe(90);
  });

  it("H: duplicate raw dimension requests dedupe", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["fct_rev.code", "fct_rev.code"],
      time: Q,
    });
    expect(result.columns).toEqual(["fct_rev.code", "revenue"]);
    expectUniqueSchema(result);
  });

  it("I: synonym sales + revenue dedupes to one public column", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["revenue", "sales"], time: Q });
    expect(result.columns).toEqual(["revenue"]);
    expectUniqueSchema(result);
    expect(Number(result.rows[0]!.revenue)).toBe(90);
    const swapped = await k.query({ metrics: ["sales", "revenue"], time: Q });
    expect(swapped.columns).toEqual(["revenue"]);
    const dup = await k.query({ metrics: ["revenue", "revenue"], time: Q });
    expect(dup.columns).toEqual(["revenue"]);
    expectUniqueSchema(dup);
  });

  it("synonym cannot launder a metric/dimension collision", () => {
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        code: { ...baseMaps().metrics.revenue, synonyms: ["the_code"] },
      },
      dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
    });
    expectRefuse(
      () => k.compile({ metrics: ["the_code"], dimensions: ["code"], time: Q }),
      "ambiguous_query",
      "code",
    );
  });

  it("J: duplicate dimension requests dedupe", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "segment"],
      time: Q,
    });
    expect(result.columns).toEqual(["segment", "revenue"]);
    expectUniqueSchema(result);
  });

  it("K: PR #29 period_month + selected dimension/metric/raw alias still refuses", () => {
    const k = kernel({
      metrics: { ...baseMaps().metrics, period_month: baseMaps().metrics.revenue },
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${fct_rev.code}" },
      },
    });
    expectRefuse(
      () => k.compile({ metrics: ["revenue"], dimensions: ["period_month"], time: { ...Q, grain: "month" } }),
      "ambiguous_query",
      "period_month",
    );
    expectRefuse(
      () => k.compile({ metrics: ["period_month"], time: { ...Q, grain: "month" } }),
      "ambiguous_query",
      "period_month",
    );
    expectRefuse(
      () =>
        k.compile({
          raw_metrics: [{ field: "fct_rev.amount", type: "sum", alias: "period_month" }],
          time: { ...Q, grain: "month", dimension: "fct_rev.sold_on" },
        }),
      "ambiguous_query",
      "period_month",
    );
  });

  it("cross-grain and no-grain period_month remain legal; qualified raw is distinct", async () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${fct_rev.segment}" },
      },
    });
    const noGrain = await k.query({ metrics: ["revenue"], dimensions: ["period_month"], time: Q });
    expect(noGrain.columns).toEqual(["period_month", "revenue"]);
    expectUniqueSchema(noGrain);
    const week = await k.query({
      metrics: ["revenue"],
      dimensions: ["period_month"],
      time: { ...Q, grain: "week" },
    });
    expect(week.columns).toEqual(["period_week", "period_month", "revenue"]);
    expectUniqueSchema(week);
    const raw = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["fct_rev.code"],
      time: { ...Q, grain: "month" },
    });
    expect(raw.columns).toEqual(["period_month", "fct_rev.code", "revenue"]);
    expectUniqueSchema(raw);
  });

  it("L: provider-stamped metric+dimension code collides at query time", () => {
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        code: { ...baseMaps().metrics.revenue, source: { provider: "dbt" } },
      },
      dimensions: {
        ...baseMaps().dimensions,
        code: { entity: "sale", sql: "${fct_rev.code}", source: { provider: "lookml" } },
      },
    });
    expect(k.validate().ok).toBe(true);
    expectRefuse(
      () => k.compile({ metrics: ["code"], dimensions: ["code"], time: Q }),
      "ambiguous_query",
      "code",
    );
  });

  it("M: joined dimension code + metric code refuses", () => {
    const k = kernel({
      metrics: { ...baseMaps().metrics, code: baseMaps().metrics.revenue },
      dimensions: { ...baseMaps().dimensions, code: { entity: "customer", sql: "${customers.code}" } },
    });
    expectRefuse(
      () => k.compile({ metrics: ["code"], dimensions: ["code"], time: Q }),
      "ambiguous_query",
      "code",
    );
  });

  it("N: two selected dimensions have distinct public names", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      dimensions: ["segment", "country"],
      time: Q,
    });
    expect(result.columns).toEqual(["segment", "country", "revenue"]);
    expectUniqueSchema(result);
  });

  it("ratio/derived metric named code + dimension code refuses", () => {
    const k = kernel({
      metrics: { ...baseMaps().metrics, code: baseMaps().metrics.aov },
      dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
    });
    expectRefuse(
      () => k.compile({ metrics: ["code"], dimensions: ["code"], time: Q }),
      "ambiguous_query",
      "code",
    );
  });

  it("semi-additive metric named ending_bal + dimension ending_bal refuses; legal snapshot still works", async () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        ending_bal: { entity: "snap", sql: "${snapshots.customer_id}" },
      },
    });
    expectRefuse(
      () => k.compile({ metrics: ["ending_bal"], dimensions: ["ending_bal"], time: Q }),
      "ambiguous_query",
      "ending_bal",
    );
    const ok = await kernel().query({ metrics: ["ending_bal"], time: { ...Q, grain: "month" } });
    expect(ok.columns).toEqual(["period_month", "ending_bal"]);
    expectUniqueSchema(ok);
    expect(Number(ok.rows[0]!.ending_bal)).toBe(110);
  });

  it("filter-only dimension code does not collide with metric code", async () => {
    const k = kernel(codeModel);
    for (const filters of [
      [{ field: "code", operator: "is_null" as const }],
      [{ field: "code", operator: "in" as const, value: [null] }],
    ]) {
      const result = await k.query({ metrics: ["code"], filters, time: Q });
      expect(result.columns).toEqual(["code"]);
      expectUniqueSchema(result);
      expect(result.trust).toBe("governed");
    }
    const joined = await k.query({
      metrics: ["code"],
      filters: [{ field: "country", operator: "=", value: "US" }],
      time: Q,
    });
    expect(joined.columns).toEqual(["code"]);
    expectUniqueSchema(joined);
    expectRefuse(
      () =>
        k.compile({
          metrics: ["code"],
          dimensions: ["code"],
          filters: [{ field: "code", operator: "is_null" }],
          time: Q,
        }),
      "ambiguous_query",
      "code",
    );
  });

  it("metric Code vs dimension code are distinct public names", async () => {
    const k = kernel({
      metrics: { ...baseMaps().metrics, Code: baseMaps().metrics.revenue },
      dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.segment}" } },
    });
    const result = await k.query({ metrics: ["Code"], dimensions: ["code"], time: Q });
    expect(result.columns).toEqual(["code", "Code"]);
    expectUniqueSchema(result);
  });

  it("resolve/explain/execute agree; MCP and JSON stay unique", async () => {
    const k = kernel(codeModel);
    const q = { metrics: ["code"], dimensions: ["code"], time: Q };
    expectRefuse(() => k.resolve(q), "ambiguous_query", "code");
    await expect(k.explain(q)).rejects.toBeInstanceOf(GraneError);
    await expect(k.query(q)).rejects.toBeInstanceOf(GraneError);
    const legal = await k.query({ metrics: ["code"], dimensions: ["segment"], time: Q });
    expectUniqueSchema(legal);
    const text = mcpTrustText({
      trust: legal.trust,
      columns: legal.columns,
      rows: legal.rows,
      completeness: legal.completeness,
      provenance: legal.provenance,
    });
    const payload = JSON.parse(text.slice(text.indexOf("{"))) as { columns: string[] };
    expect(payload.columns).toEqual(legal.columns);
    expect(new Set(payload.columns).size).toBe(payload.columns.length);
    const json = JSON.parse(JSON.stringify(legal)) as { columns: string[] };
    expect(json.columns).toEqual(legal.columns);
  });

  it("legal multi-field queries keep unique columns including empty and NULL groups", async () => {
    const k = kernel();
    const grouped = await k.query({
      metrics: ["revenue", "orders"],
      dimensions: ["segment", "country"],
      time: { ...Q, grain: "month" },
    });
    expectUniqueSchema(grouped);
    expect(grouped.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(grouped.columns).not.toContain(RESULT_TOTAL_COLUMN);
    const empty = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "segment", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(empty.rows).toEqual([]);
    expectUniqueSchema(empty);
    const nulled = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "segment", operator: "is_null" }],
      time: Q,
    });
    expect(nulled.rows).toHaveLength(1);
    expect(nulled.rows[0]!.country).toBeNull();
    expect(nulled.rows[0]!.revenue).toBeNull();
    expectUniqueSchema(nulled);
  });

  it("trust and completeness remain orthogonal", async () => {
    const k = kernel({}, 1);
    const mixed = await k.query({ metrics: ["trial_revenue"], dimensions: ["segment"], time: Q });
    expect(mixed.trust).toBe("mixed");
    expect(mixed.completeness.status).toBe("truncated");
    expectUniqueSchema(mixed);
    const top = await kernel().query({
      metrics: ["revenue"],
      dimensions: ["segment"],
      time: Q,
      limit: 1,
    });
    expect(top.completeness).toEqual({ status: "complete", limit: 1, source: "query" });
  });

  it("PR #28 reserved names still refused; legal nearby and qualified raw remain", () => {
    expectRefuse(
      () =>
        new GraneKernel(
          config({ type: "duckdb", path, schema: "main" }, { metrics: { __grane_row: baseMaps().metrics.revenue } }),
        ),
      "config_error",
      "__grane_row",
    );
    const k = kernel({
      metrics: { ...baseMaps().metrics, __grane: baseMaps().metrics.revenue, grane_row: baseMaps().metrics.revenue },
    });
    expect(k.model.metrics.has("__grane")).toBe(true);
  });

  it("PR #28 qualified raw fct_rev.__grane_row survives", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["fct_rev.__grane_row"],
      time: Q,
    });
    expect(result.columns).toContain("fct_rev.__grane_row");
    expect(result.trust).toBe("mixed");
    expectUniqueSchema(result);
  });

  it("all dialects compile a legal query with unique plan.columns", () => {
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
      const { compiled } = k.compile({ metrics: ["revenue"], dimensions: ["segment"], time: Q });
      expect(new Set(compiled.plan.columns).size, type).toBe(compiled.plan.columns.length);
      expect(compiled.plan.columns, type).toEqual(["segment", "revenue"]);
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

describe.skipIf(!pgOk)("public output uniqueness (PostgreSQL)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_pub_${Date.now().toString(36)}`;
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

  it("refuses metric+dimension code and executes a unique schema", async () => {
    const k = new GraneKernel(
      config(
        { type: "postgres", url: PG_URL, schema: SCHEMA },
        {
          metrics: { ...baseMaps().metrics, code: baseMaps().metrics.revenue },
          dimensions: { ...baseMaps().dimensions, code: { entity: "sale", sql: "${fct_rev.code}" } },
        },
      ),
    );
    kernels.push(k);
    expectRefuse(
      () => k.compile({ metrics: ["code"], dimensions: ["code"], time: Q }),
      "ambiguous_query",
      "code",
    );
    const result = await k.query({ metrics: ["code"], dimensions: ["segment"], time: Q });
    expect(result.columns).toEqual(["segment", "code"]);
    expect(Number(result.rows.find((r) => r.segment === "A")!.code)).toBe(40);
  });
});
