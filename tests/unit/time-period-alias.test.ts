/**
 * Public time-grain alias `period_${grain}` must not collide with selected
 * user fields. On merged main, dimension/metric `period_month` + grain=month
 * compiled duplicate SELECT aliases; DuckDB renamed to `period_month:1`
 * while Grane declared duplicate `result.columns`. The query succeeded as
 * governed/complete.
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
import { timeGrainSchema } from "../../src/query/model.js";
import { timeAlias } from "../../src/query/resolve.js";
import { mergeContributions } from "../../src/providers/merge.js";
import { emptyContribution } from "../../src/providers/types.js";
import { mcpTrustText } from "../../src/query/trust.js";

const GRAINS = timeGrainSchema.options;
const DDL = `
  CREATE TABLE sales (
    id INTEGER,
    customer_id INTEGER,
    segment VARCHAR,
    amount DOUBLE PRECISION,
    sold_on DATE,
    period_month VARCHAR,
    "__grane_row" DOUBLE PRECISION
  );
  INSERT INTO sales VALUES
    (1, 1, 'A', 10, DATE '2026-01-15', 'USER-DIM', 1),
    (2, 2, 'B', 20, DATE '2026-01-20', 'USER-DIM', 2),
    (3, 2, NULL, NULL, DATE '2026-01-22', 'USER-DIM', 3);
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, country VARCHAR, period_month VARCHAR);
  INSERT INTO customers VALUES (1, 'US', 'JOIN-DIM'), (2, NULL, 'JOIN-DIM');
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
      sale: { table: "sales", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
      dup: { table: "dim_dup", primary_key: "customer_id" },
      snap: { table: "snapshots", primary_key: "row_id" },
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
    project: { name: "period-alias", timezone: "UTC" },
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
    const keys = Object.keys(row);
    expect(keys.sort()).toEqual([...result.columns].sort());
    for (const key of keys) expect(key.includes(":")).toBe(false);
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

describe("timeAlias contract", () => {
  it("maps every supported grain to period_${grain}", () => {
    expect(GRAINS).toEqual(["day", "week", "month", "quarter", "year"]);
    expect(GRAINS.map(timeAlias)).toEqual([
      "period_day",
      "period_week",
      "period_month",
      "period_quarter",
      "period_year",
    ]);
  });
});

describe("model load does not reserve period_${grain}", () => {
  const connection = { type: "duckdb", path: ":memory:", schema: "main" };

  it("constructs metrics and dimensions named after every period alias", () => {
    for (const grain of GRAINS) {
      const alias = timeAlias(grain);
      const k = new GraneKernel(
        config(connection, {
          metrics: { ...baseMaps().metrics, [alias]: baseMaps().metrics.revenue },
          dimensions: { ...baseMaps().dimensions, [alias]: baseMaps().dimensions.segment },
        }),
      );
      expect(k.model.metrics.has(alias)).toBe(true);
      expect(k.model.dimensions.has(alias)).toBe(true);
    }
  });
});

describe("provider imports cannot bypass query-level collision handling", () => {
  it("keeps an imported period_month definition and does not skip it", () => {
    const part = emptyContribution();
    part.metrics.period_month = {
      entity: "sale",
      type: "sum",
      sql: "${sales.amount}",
      source: { provider: "dbt", path: "models.yml" },
    };
    part.dimensions.period_month = {
      entity: "sale",
      sql: "${sales.segment}",
      source: { provider: "cube" },
    };
    const merged = mergeContributions([part]);
    expect(merged.metrics.period_month).toBeDefined();
    expect(merged.dimensions.period_month).toBeDefined();
    expect(merged.unsupported).toEqual([]);
  });
});

describe.skipIf(!duckdbOk)("period alias at execution (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = await import("@duckdb/node-api");
    path = join(mkdtempSync(join(tmpdir(), "grane-period-")), "db.duckdb");
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

  it("C1: selected metric named period_${grain} + matching grain is ambiguous_query", () => {
    for (const grain of GRAINS) {
      const alias = timeAlias(grain);
      const k = kernel({
        metrics: { ...baseMaps().metrics, [alias]: baseMaps().metrics.revenue },
      });
      expectRefuse(
        () => k.compile({ metrics: [alias], time: { ...Q, grain } }),
        "ambiguous_query",
        alias,
      );
      expectRefuse(
        () => k.compile({ metrics: [alias, "revenue"], time: { ...Q, grain } }),
        "ambiguous_query",
        alias,
      );
    }
  });

  it("C2: selected dimension named period_${grain} + matching grain is ambiguous_query", () => {
    for (const grain of GRAINS) {
      const alias = timeAlias(grain);
      const k = kernel({
        dimensions: { ...baseMaps().dimensions, [alias]: { entity: "sale", sql: "${sales.period_month}" } },
      });
      expectRefuse(
        () => k.compile({ metrics: ["revenue"], dimensions: [alias], time: { ...Q, grain } }),
        "ambiguous_query",
        alias,
      );
      expectRefuse(
        () =>
          k.compile({
            metrics: ["revenue"],
            dimensions: [alias, "segment"],
            time: { ...Q, grain },
          }),
        "ambiguous_query",
        alias,
      );
    }
  });

  it("C3: synonym resolving to a colliding canonical name still refuses; synonym-only request does not", () => {
    const kCollide = kernel({
      metrics: {
        ...baseMaps().metrics,
        period_month: { ...baseMaps().metrics.revenue, synonyms: ["pm"] },
      },
    });
    expectRefuse(
      () => kCollide.compile({ metrics: ["pm"], time: { ...Q, grain: "month" } }),
      "ambiguous_query",
      "period_month",
    );
    const kSafe = kernel({
      metrics: {
        ...baseMaps().metrics,
        revenue: { ...baseMaps().metrics.revenue, synonyms: ["period_month"] },
      },
    });
    const { compiled } = kSafe.compile({ metrics: ["period_month"], time: { ...Q, grain: "month" } });
    expect(compiled.plan.columns).toEqual(["period_month", "revenue"]);
    expect(new Set(compiled.plan.columns).size).toBe(2);
  });

  it("C4/C5: provider-stamped metric and dimension collide at query time, not model load", () => {
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        period_month: { ...baseMaps().metrics.revenue, source: { provider: "dbt", path: "models.yml" } },
      },
      dimensions: {
        ...baseMaps().dimensions,
        period_week: {
          entity: "sale",
          sql: "${sales.period_month}",
          source: { provider: "lookml" },
        },
      },
    });
    expect(k.validate().ok).toBe(true);
    expectRefuse(
      () => k.compile({ metrics: ["period_month"], time: { ...Q, grain: "month" } }),
      "ambiguous_query",
      "period_month",
    );
    expectRefuse(
      () => k.compile({ metrics: ["revenue"], dimensions: ["period_week"], time: { ...Q, grain: "week" } }),
      "ambiguous_query",
      "period_week",
    );
  });

  it("C6: raw metric alias period_month + grain=month is ambiguous_query", () => {
    const k = kernel();
    expectRefuse(
      () =>
        k.compile({
          raw_metrics: [{ field: "sales.amount", type: "sum", alias: "period_month" }],
          time: { ...Q, grain: "month", dimension: "sales.sold_on" },
        }),
      "ambiguous_query",
      "period_month",
    );
  });

  it("C7: qualified raw dimension sales.period_month does not collide and survives", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["sales.period_month"],
      time: { ...Q, grain: "month" },
    });
    expect(result.trust).toBe("mixed");
    expect(result.columns).toEqual(["period_month", "sales.period_month", "revenue"]);
    expectUniqueSchema(result);
    expect(result.rows.some((r) => r["sales.period_month"] === "USER-DIM")).toBe(true);
  });

  it("joined dimension named period_month + grain=month is refused", () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "customer", sql: "${customers.period_month}" },
      },
    });
    expectRefuse(
      () => k.compile({ metrics: ["revenue"], dimensions: ["period_month"], time: { ...Q, grain: "month" } }),
      "ambiguous_query",
      "period_month",
    );
  });

  it("filter-only period_month does not create an output collision", async () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
      },
    });
    for (const filters of [
      [{ field: "period_month", operator: "=" as const, value: "USER-DIM" }],
      [{ field: "period_month", operator: "in" as const, value: ["USER-DIM"] }],
      [{ field: "period_month", operator: "contains" as const, value: "USER" }],
    ]) {
      const result = await k.query({ metrics: ["revenue"], filters, time: { ...Q, grain: "month" } });
      expect(result.columns).toEqual(["period_month", "revenue"]);
      expectUniqueSchema(result);
      expect(result.trust).toBe("governed");
    }
    const joined = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "country", operator: "=", value: "US" }],
      time: { ...Q, grain: "month" },
    });
    expect(joined.columns).toEqual(["period_month", "revenue"]);
    expectUniqueSchema(joined);
  });

  it("selected colliding field used as a filter still refuses", () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
      },
    });
    expectRefuse(
      () =>
        k.compile({
          metrics: ["revenue"],
          dimensions: ["period_month"],
          filters: [{ field: "period_month", operator: "=", value: "USER-DIM" }],
          time: { ...Q, grain: "month" },
        }),
      "ambiguous_query",
      "period_month",
    );
  });

  it("cross-grain combinations remain valid", async () => {
    const k = kernel({
      metrics: { ...baseMaps().metrics, period_week: baseMaps().metrics.revenue },
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
      },
    });
    const dimWeek = await k.query({
      metrics: ["revenue"],
      dimensions: ["period_month"],
      time: { ...Q, grain: "week" },
    });
    expect(dimWeek.columns).toEqual(["period_week", "period_month", "revenue"]);
    expectUniqueSchema(dimWeek);
    expect(dimWeek.rows[0]!.period_month).toBe("USER-DIM");
    const metMonth = await k.query({ metrics: ["period_week"], time: { ...Q, grain: "month" } });
    expect(metMonth.columns).toEqual(["period_month", "period_week"]);
    expectUniqueSchema(metMonth);
    expect(Number(metMonth.rows[0]!.period_week)).toBe(30);
  });

  it("nearby names do not collide; period_month without grain remains usable", async () => {
    const nearby = ["period_monthly", "period_month_2", "xperiod_month", "period_Month", "PERIOD_MONTH"];
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        ...Object.fromEntries(nearby.map((name) => [name, baseMaps().metrics.revenue])),
        period_month: baseMaps().metrics.revenue,
      },
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
        ...Object.fromEntries(nearby.map((name) => [name, { entity: "sale", sql: "${sales.segment}" }])),
      },
    });
    for (const name of nearby) {
      const result = await k.query({ metrics: [name], time: { ...Q, grain: "month" } });
      expect(result.columns).toEqual(["period_month", name]);
      expectUniqueSchema(result);
    }
    const dimOnly = await k.query({ metrics: ["revenue"], dimensions: ["period_month"], time: Q });
    expect(dimOnly.columns).toEqual(["period_month", "revenue"]);
    expect(dimOnly.rows[0]!.period_month).toBe("USER-DIM");
    expectUniqueSchema(dimOnly);
    const metOnly = await k.query({ metrics: ["period_month"], time: Q });
    expect(metOnly.columns).toEqual(["period_month"]);
    expect(Number(metOnly.rows[0]!.period_month)).toBe(30);
    expectUniqueSchema(metOnly);
  });

  it("resolve, explain, and execute agree on collision; model validate stays ok", async () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
      },
    });
    expect(k.validate().ok).toBe(true);
    const q = { metrics: ["revenue"], dimensions: ["period_month"], time: { ...Q, grain: "month" as const } };
    expectRefuse(() => k.resolve(q), "ambiguous_query", "period_month");
    expectRefuse(() => k.compile(q), "ambiguous_query", "period_month");
    await expect(k.explain(q)).rejects.toBeInstanceOf(GraneError);
    await expect(k.query(q)).rejects.toBeInstanceOf(GraneError);
  });

  it("MCP payload refuses collision and legal results have unique columns", async () => {
    const k = kernel({
      dimensions: {
        ...baseMaps().dimensions,
        period_month: { entity: "sale", sql: "${sales.period_month}" },
      },
    });
    try {
      k.compile({ metrics: ["revenue"], dimensions: ["period_month"], time: { ...Q, grain: "month" } });
      throw new Error("expected refusal");
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("ambiguous_query");
    }
    const result = await k.query({ metrics: ["revenue"], dimensions: ["segment"], time: { ...Q, grain: "month" } });
    const text = mcpTrustText({
      trust: result.trust,
      columns: result.columns,
      rows: result.rows,
      completeness: result.completeness,
      provenance: result.provenance,
    });
    const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
      columns: string[];
      rows: Record<string, unknown>[];
    };
    expect(payload.columns).toEqual(result.columns);
    expect(new Set(payload.columns).size).toBe(payload.columns.length);
    expectUniqueSchema(result);
    const json = JSON.parse(JSON.stringify(result)) as { columns: string[]; rows: Record<string, unknown>[] };
    expect(json.columns).toEqual(result.columns);
    expectUniqueSchema(json);
  });

  it("legal grain queries keep unique columns and hide internals", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue", "orders"],
      dimensions: ["segment", "country"],
      time: { ...Q, grain: "month" },
    });
    expect(result.columns).toEqual(["period_month", "segment", "country", "revenue", "orders"]);
    expectUniqueSchema(result);
    expect(result.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(result.columns).not.toContain(RESULT_TOTAL_COLUMN);
    expect(result.trust).toBe("governed");
  });

  it("trust remains orthogonal: governed, mixed experimental, mixed raw", async () => {
    const k = kernel();
    const gov = await k.query({ metrics: ["revenue"], time: { ...Q, grain: "month" } });
    expect(gov.trust).toBe("governed");
    const mixed = await k.query({ metrics: ["trial_revenue"], time: { ...Q, grain: "month" } });
    expect(mixed.trust).toBe("mixed");
    expectUniqueSchema(mixed);
  });

  it("completeness: semantic top-N complete; execution cap+1 truncated", async () => {
    const grouped = { metrics: ["revenue"], dimensions: ["segment"], time: { ...Q, grain: "month" as const } };
    const uncapped = await kernel(undefined, 1000).query(grouped);
    expect(uncapped.completeness.status).toBe("complete");
    const n = uncapped.rows.length;
    const exact = await kernel(undefined, n).query(grouped);
    expect(exact.completeness.status).toBe("complete");
    expect(exact.provenance.completeness).toEqual(exact.completeness);
    if (n > 1) {
      const plus = await kernel(undefined, n - 1).query(grouped);
      expect(plus.completeness.status).toBe("truncated");
    }
    const top = await kernel().query({ ...grouped, limit: 1 });
    expect(top.completeness).toEqual({ status: "complete", limit: 1, source: "query" });
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
    expect(real.columns).not.toContain(RESULT_ROW_COLUMN);
    const empty = await k.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "segment", operator: "=", value: "NOPE" }],
      time: Q,
    });
    expect(empty.rows).toEqual([]);
  });

  it("PR #28: reserved __grane_ names still refused; legal nearby names remain", () => {
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
    expectRefuse(
      () =>
        new GraneKernel(
          config(
            { type: "duckdb", path, schema: "main" },
            { metrics: { __grane_n: baseMaps().metrics.revenue } },
          ),
        ),
      "config_error",
      "__grane_n",
    );
    expectRefuse(
      () =>
        new GraneKernel(
          config(
            { type: "duckdb", path, schema: "main" },
            { dimensions: { ...baseMaps().dimensions, __grane_card_0: baseMaps().dimensions.segment } },
          ),
        ),
      "config_error",
      "__grane_card_0",
    );
    expectRefuse(
      () =>
        new GraneKernel(
          config(
            { type: "duckdb", path, schema: "main" },
            { metrics: { __GRANE_ROW: baseMaps().metrics.revenue } },
          ),
        ),
      "config_error",
      "__GRANE_ROW",
    );
    const k = kernel({
      metrics: {
        ...baseMaps().metrics,
        __grane: baseMaps().metrics.revenue,
        grane_row: baseMaps().metrics.revenue,
        x__grane_row: baseMaps().metrics.revenue,
      },
    });
    expect(k.model.metrics.has("__grane")).toBe(true);
    expect(k.model.metrics.has("grane_row")).toBe(true);
  });

  it("PR #28: qualified raw sales.__grane_row survives", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["sales.__grane_row"],
      time: Q,
    });
    expect(result.columns).toContain("sales.__grane_row");
    expect(result.columns).not.toContain(RESULT_ROW_COLUMN);
    expect(result.trust).toBe("mixed");
  });

  it("semi-additive global last with month grain still snapshots", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["ending_bal"], time: { ...Q, grain: "month" } });
    expect(result.columns).toEqual(["period_month", "ending_bal"]);
    expectUniqueSchema(result);
    expect(Number(result.rows[0]!.ending_bal)).toBe(110);
    expect(result.trust).toBe("governed");
  });

  it("all dialects compile a legal grain query with unique plan.columns", () => {
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
      const { compiled } = k.compile({ metrics: ["revenue"], time: { ...Q, grain: "month" } });
      expect(compiled.sql, type).toMatch(/period_month/);
      expect(compiled.plan.columns, type).toEqual(["period_month", "revenue"]);
      expect(new Set(compiled.plan.columns).size, type).toBe(2);
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

describe.skipIf(!pgOk)("period alias at execution (PostgreSQL)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_period_${Date.now().toString(36)}`;
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

  it("refuses colliding grain queries and preserves period_month without grain", async () => {
    const colliding = new GraneKernel(
      config(
        { type: "postgres", url: PG_URL, schema: SCHEMA },
        {
          dimensions: {
            ...baseMaps().dimensions,
            period_month: { entity: "sale", sql: "${sales.period_month}" },
          },
        },
      ),
    );
    kernels.push(colliding);
    expectRefuse(
      () =>
        colliding.compile({
          metrics: ["revenue"],
          dimensions: ["period_month"],
          time: { ...Q, grain: "month" },
        }),
      "ambiguous_query",
      "period_month",
    );
    const result = await colliding.query({ metrics: ["revenue"], dimensions: ["period_month"], time: Q });
    expect(result.columns).toEqual(["period_month", "revenue"]);
    expect(result.rows[0]!.period_month).toBe("USER-DIM");
    expect(Number(result.rows[0]!.revenue)).toBe(30);
  });
});
