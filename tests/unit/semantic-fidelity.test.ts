/**
 * Semantic fidelity of the dbt/MetricFlow import.
 *
 * These tests execute the SQL Grane compiles against a small DuckDB
 * warehouse whose answers are worked out by hand, so they prove semantics —
 * not just parser output. The fixture mirrors the shapes that broke in the
 * Oakwell interoperability test: `expr: 1` counts, `!=` filters, a snapshot
 * table with a surrogate primary key and `non_additive_dimension`,
 * cross-grain ratios, and metrics Grane must refuse rather than approximate.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graneConfigSchema, type GraneConfig } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mapMetricFlowGraph } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";
import { translateMfFilter } from "../../src/providers/dbt/filters.js";
import type { MfSemanticModel } from "../../src/providers/dbt/graph.js";
import type { SemanticQueryInput } from "../../src/query/model.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-saas");
const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));

const DDL = [
  `CREATE TABLE dim_customers (customer_id VARCHAR, segment VARCHAR, country_code VARCHAR, customer_status VARCHAR, signup_date DATE)`,
  `INSERT INTO dim_customers VALUES
     ('c1','Enterprise','DE','active','2026-01-01'), ('c2','SMB','US','churned','2026-01-02'),
     ('c3','Enterprise','US','active','2026-02-01'), ('c4','SMB','DE','active','2026-03-01'),
     ('c5','SMB','UK','trial','2026-04-01')`,
  `CREATE TABLE fct_events (customer_id VARCHAR, event_at DATE)`,
  `CREATE TABLE fct_mrr_snapshot (
     customer_month_id VARCHAR, customer_id VARCHAR, month_start DATE, reported_at DATE,
     segment VARCHAR, country_code VARCHAR, ending_mrr DECIMAL(18,2), is_active INTEGER, new_mrr DECIMAL(18,2))`,
  `INSERT INTO fct_mrr_snapshot VALUES
     ('cm1','c1','2026-06-01','2026-06-30','Enterprise','DE', 90,1, 90),
     ('cm2','c1','2026-07-01','2026-07-31','Enterprise','DE',110,1,  0),
     ('cm3','c1','2026-08-01','2026-08-31','Enterprise','DE',120,1,  0),
     ('cm4','c2','2026-06-01','2026-06-30','SMB','US', 50,1, 50),
     ('cm5','c2','2026-07-01','2026-07-31','SMB','US', 60,1,  0),
     ('cm6','c2','2026-08-01','2026-08-31','SMB','US',  0,0,  0),
     ('cm7','c3','2026-07-01','2026-07-31','Enterprise','US',200,1,200),
     ('cm8','c4','2026-08-01','2026-08-31','SMB','DE', 30,1, 30)`,
  `CREATE TABLE fct_invoices (
     invoice_id INTEGER, customer_id VARCHAR, invoice_date DATE, invoice_status VARCHAR,
     total_amount DECIMAL(18,2), paid_amount DECIMAL(18,2), country_code VARCHAR)`,
  `INSERT INTO fct_invoices VALUES
     (1,'c1','2026-07-05','paid',100,100,'DE'), (2,'c1','2026-07-20','void',999,0,'DE'),
     (3,'c2','2026-07-10','open',50,0,'US'),    (4,'c3','2026-07-15','paid',200,200,'US'),
     (5,'c4','2026-08-02','paid',30,30,'DE'),   (6,'c2','2026-08-15','uncollectible',40,0,'US'),
     (7,'c1','2026-07-25',NULL,10,0,'DE')`,
  `CREATE TABLE fct_tickets (ticket_id INTEGER, customer_id VARCHAR, opened_at DATE, category VARCHAR)`,
  `INSERT INTO fct_tickets VALUES (1,'c1','2026-07-01','bug'), (2,'c1','2026-07-02','how_to'), (3,'c2','2026-08-01','bug')`,
  `CREATE TABLE fct_balances (balance_id INTEGER, account_id INTEGER, snapshot_date DATE, balance DECIMAL(18,2))`,
  `INSERT INTO fct_balances VALUES (1,1,'2024-03-01',1000), (2,1,'2024-03-15',900), (3,2,'2024-03-15',400), (4,3,'2024-03-02',700)`,
  `CREATE TABLE fct_monthly_balances (row_id INTEGER, snapshot_date DATE, recorded_at TIMESTAMP, balance DECIMAL(18,2))`,
  `INSERT INTO fct_monthly_balances VALUES
     (1,'2024-03-01','2024-03-01 09:00:00',100), (2,'2024-03-15','2024-03-15 09:00:00',90),
     (3,'2024-04-02','2024-04-02 09:00:00',80),  (4,'2024-04-20','2024-04-20 09:00:00',70)`,
];

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string) => Promise<{
      connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync?: () => void; disconnectSync?: () => void }>;
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

async function buildWarehouse(): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-fidelity-")), "saas.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const statement of DDL) await conn.run(statement);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

function kernelFor(path: string, extra: Partial<GraneConfig> = {}): GraneKernel {
  return new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "saas-fidelity", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: contribution.entities,
      metrics: contribution.metrics,
      dimensions: contribution.dimensions,
      relationships: contribution.relationships,
      unsupported: contribution.unsupported,
      ...extra,
    }),
  );
}

const available = await duckdbAvailable();
const JUL = { from: "2026-07-01", to: "2026-07-31" };
const JUN_AUG = { from: "2026-06-01", to: "2026-08-31" };
const AUG = { from: "2026-08-01", to: "2026-08-31" };

function reasonFor(name: string): string | undefined {
  return contribution.unsupported.find((u) => u.kind === "metric" && u.name === name)?.reason;
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a refusal");
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("dbt import: what is and is not imported", () => {
  it("never assumes an 'id' primary key or imports a model without one", () => {
    for (const entity of Object.values(contribution.entities)) {
      expect(entity.primary_key).not.toBe("id");
    }
    expect(contribution.entities.events).toBeUndefined();
    expect(contribution.metrics.events).toBeUndefined();
    expect(reasonFor("events")).toMatch(/no primary entity backed by a column/);
    expect(Object.keys(contribution.relationships).some((k) => k.includes("fct_events"))).toBe(false);
  });

  it("keeps join targets on declared entities only", () => {
    expect(contribution.relationships.fct_mrr_snapshot_to_dim_customers).toEqual(
      expect.objectContaining({ from: "fct_mrr_snapshot.customer_id", to: "dim_customers.customer_id" }),
    );
    expect(contribution.relationships.fct_balances_to_dim_customers).toBeUndefined();
  });

  it("fill_nulls_with is carried (integers only) and join_to_timespine is flagged, never dropped", () => {
    expect(contribution.metrics.revenue_filled?.fill_nulls_with).toBe(0);
    expect(contribution.metrics.revenue_filled_minus_one?.fill_nulls_with).toBe(-1);
    expect(contribution.metrics.ending_mrr?.fill_nulls_with).toBe(0);
    expect(contribution.metrics.revenue?.fill_nulls_with).toBeUndefined();
    expect(contribution.metrics.invoice_count_dense).toEqual(
      expect.objectContaining({ fill_nulls_with: 0, join_to_timespine: true }),
    );
    expect(contribution.metrics.invoice_count?.join_to_timespine).toBeUndefined();
    // Legacy spec: the measure input's setting applies; a metric-level one next to a measure input is ignored upstream.
    expect(contribution.metrics.balance_rows_filled?.fill_nulls_with).toBe(0);
    expect(contribution.metrics.balance_rows_unfilled?.fill_nulls_with).toBeUndefined();
    expect(reasonFor("revenue_bad_fill")).toMatch(/fill_nulls_with 0.5 is not an integer/);
    expect(reasonFor("paid_share_filled")).toMatch(/only defined for simple metrics/);
  });

  it("records every deliberate skip with a reason and imports nothing ambiguous", () => {
    const skipped = Object.fromEntries(
      contribution.unsupported.filter((u) => u.kind === "metric").map((u) => [u.name, u.reason]),
    );
    expect(skipped.mrr_unknown_window).toMatch(/window "avg" is not min or max/);
    expect(skipped.mrr_unknown_group).toMatch(/group_by "account" is not an entity/);
    expect(skipped.mrr_other_as_of).toMatch(/differs from agg_time_dimension/);
    expect(skipped.snapshot_rows_last).toMatch(/agg "count" is not compiled/);
    expect(skipped.hourly_balance).toMatch(/time granularity "hour"/);
    expect(skipped.large_invoice_amount).toMatch(/cannot translate MetricFlow filter/);
    expect(skipped.paid_or_open_amount).toMatch(/"or" is not supported/);
    expect(skipped.enterprise_billed_amount).toMatch(/outside semantic model "invoices"/);
    expect(skipped.null_status_amount).toMatch(/quoted string, number, or true\/false/);
    expect(skipped.recent_amount).toMatch(/cannot translate MetricFlow filter/);
    expect(skipped.literal_sum).toMatch(/only agg: count over a literal/);
    expect(skipped.median_invoice).toMatch(/aggregation "median" is not compiled/);
    expect(skipped.tickets_per_active_customer).toMatch(/cross-grain ratios are not compiled/);
    expect(skipped.enterprise_mrr_share).toMatch(/different snapshot rows/);
    expect(skipped.mrr_per_new_mrr).toMatch(/semi-additive component with an additive one/);
    expect(skipped.enterprise_arpu).toMatch(/filter on a ratio metric/);
    expect(skipped.paid_share).toMatch(/carries a filter/);
    expect(skipped.arr).toMatch(/derived expr is not a simple metric \/ metric ratio/);
    expect(skipped.mrr_mom_change).toMatch(/offset_window "1 month"/);
    expect(skipped.trailing_tickets).toMatch(/"cumulative" is not compiled/);
    expect(skipped.trial_conversion).toMatch(/"conversion" is not compiled/);
    for (const name of Object.keys(skipped)) {
      expect(contribution.metrics[name]).toBeUndefined();
    }
    for (const reason of Object.values(skipped)) {
      expect(reason).not.toMatch(/undefined|\[object/);
    }
  });

  it("imports the supported subset", () => {
    const imported = Object.keys(contribution.metrics).sort();
    expect(imported).toEqual(
      [
        "account_balance",
        "active_customers",
        "arpu",
        "balance_rows",
        "balance_rows_filled",
        "balance_rows_unfilled",
        "billed_amount",
        "billed_amount_ne",
        "ending_mrr",
        "ending_mrr_by_customer",
        "enterprise_ending_mrr",
        "filled_revenue_per_invoice",
        "invoice_count",
        "invoice_count_dense",
        "monthly_balance",
        "new_mrr",
        "opening_mrr",
        "paid_invoices",
        "paying_signups",
        "revenue",
        "revenue_filled",
        "revenue_filled_minus_one",
        "revenue_per_invoice",
        "signups",
        "simple_derived_ratio",
        "status_count",
        "support_tickets",
        "total_balance_first_day",
        "void_amount",
      ].sort(),
    );
  });

  it("records SQL-expression dimensions as unsupported instead of compiling or dropping them", () => {
    expect(contribution.dimensions.is_large).toBeUndefined();
    expect(contribution.dimensions.customer_is_large).toBeUndefined();
    const skipped = contribution.unsupported.find((u) => u.kind === "dimension" && u.name === "customer__is_large");
    expect(skipped?.reason).toMatch(/SQL expression/);
    expect(skipped?.path).toBe("models/customers.yml");
  });

  it("exposes a dimension name declared by several models only under its qualified identities", () => {
    // `country` is declared by customers, the MRR snapshot and invoices with
    // different columns: no short alias, one qualified name per meaning.
    expect(contribution.dimensions.country).toBeUndefined();
    expect(contribution.dimensions.customer__country?.entity).toBe("customer");
    expect(contribution.dimensions.customer__country?.sql).toBe("${dim_customers.country_code}");
    expect(contribution.dimensions.customer_month__country?.sql).toBe("${fct_mrr_snapshot.country_code}");
    expect(contribution.dimensions.customer_month__country?.description).toContain("fct_mrr_snapshot.country_code");
    expect(contribution.dimensions.invoice__country?.sql).toBe("${fct_invoices.country_code}");
    const skipped = contribution.unsupported.find((u) => u.kind === "dimension" && u.name === "country");
    expect(skipped?.reason).toMatch(/declared by 3 semantic models with different columns/);
    expect(skipped?.reason).toContain('"customer__country"');
    expect(skipped?.reason).toContain('"invoice__country"');
    // A name declared once keeps its short form.
    expect(contribution.dimensions.customer_status?.sql).toBe("${dim_customers.customer_status}");
  });
});

describe("A. counts", () => {
  it("represents expr: 1 as a row count (COUNT(1)), never as a column named after the metric", () => {
    expect(contribution.metrics.invoice_count).toEqual(
      expect.objectContaining({ type: "count", sql: undefined, entity: "invoice" }),
    );
    expect(contribution.metrics.balance_rows?.sql).toBeUndefined();
    expect(contribution.metrics.status_count?.sql).toBe("${fct_invoices.invoice_status}");
  });

  it("compiles COUNT(1) and COUNT(column) differently", () => {
    const kernel = kernelFor(":memory:");
    expect(kernel.compile({ metrics: ["invoice_count"] }).compiled.sql).toMatch(/COUNT\(1\) AS "invoice_count"/);
    expect(kernel.compile({ metrics: ["status_count"] }).compiled.sql).toMatch(
      /COUNT\("fct_invoices"\."invoice_status"\) AS "status_count"/,
    );
    expect(kernel.compile({ metrics: ["paid_invoices"] }).compiled.sql).toMatch(/COUNT\(1\) FILTER \(WHERE/);
  });
});

describe("B. filter translation", () => {
  const model: MfSemanticModel = {
    name: "invoices",
    table: "fct_invoices",
    primaryEntity: "invoice",
    entities: [{ name: "invoice", type: "primary", expr: "invoice_id" }],
    dimensions: [
      { name: "invoice_status", type: "categorical", expr: "invoice_status", column: "invoice_status" },
      { name: "amount_band", type: "categorical", expr: "amount_band", column: "amount_band" },
      { name: "is_large", type: "categorical", expr: "total_amount > 100", column: null },
    ],
    measures: [],
    metrics: [],
    sourcePath: "x.yml",
  };

  it("keeps =, != and <> as themselves", () => {
    expect(translateMfFilter("{{ Dimension('invoice__invoice_status') }} = 'void'", model)).toEqual({
      filters: [{ field: "fct_invoices.invoice_status", operator: "=", value: "void" }],
    });
    expect(translateMfFilter("{{ Dimension('invoice__invoice_status') }} != 'void'", model)).toEqual({
      filters: [{ field: "fct_invoices.invoice_status", operator: "!=", value: "void" }],
    });
    expect(translateMfFilter("{{ Dimension('invoice__invoice_status') }} <> 'void'", model)).toEqual({
      filters: [{ field: "fct_invoices.invoice_status", operator: "!=", value: "void" }],
    });
    expect(
      translateMfFilter(
        "{{ Dimension('invoice__invoice_status') }} = 'paid' AND {{ Dimension('invoice__amount_band') }} != 'small'",
        model,
      ),
    ).toEqual({
      filters: [
        { field: "fct_invoices.invoice_status", operator: "=", value: "paid" },
        { field: "fct_invoices.amount_band", operator: "!=", value: "small" },
      ],
    });
  });

  it("types literals and unescapes quotes", () => {
    expect(translateMfFilter("{{ Dimension('invoice__amount_band') }} = 100", model)).toEqual({
      filters: [{ field: "fct_invoices.amount_band", operator: "=", value: 100 }],
    });
    expect(translateMfFilter("{{ Dimension('invoice__amount_band') }} = true", model)).toEqual({
      filters: [{ field: "fct_invoices.amount_band", operator: "=", value: true }],
    });
    expect(translateMfFilter("{{ Dimension('invoice__amount_band') }} = 'O''Brien'", model)).toEqual({
      filters: [{ field: "fct_invoices.amount_band", operator: "=", value: "O'Brien" }],
    });
  });

  it("errors on everything it cannot express instead of picking another predicate", () => {
    const cases = [
      "{{ Dimension('invoice__invoice_status') }} > 'open'",
      "{{ Dimension('invoice__invoice_status') }} >= 'open'",
      "{{ Dimension('invoice__invoice_status') }} in ('paid', 'open')",
      "{{ Dimension('invoice__invoice_status') }} is not null",
      "{{ Dimension('invoice__invoice_status') }} = null",
      "{{ Dimension('invoice__invoice_status') }} = other_column",
      "{{ Dimension('invoice__invoice_status') }} = 'a' or {{ Dimension('invoice__invoice_status') }} = 'b'",
      "not {{ Dimension('invoice__invoice_status') }} = 'a'",
      "{{ TimeDimension('invoice__invoice_date', 'day') }} = '2026-01-01'",
      "{{ Entity('customer') }} = 'c1'",
      "{{ Dimension('customer__segment') }} = 'Enterprise'",
      "{{ Dimension('invoice__missing') }} = 'x'",
      "{{ Dimension('invoice__is_large') }} = 'yes'",
      "lower({{ Dimension('invoice__invoice_status') }}) = 'paid'",
    ];
    for (const filter of cases) {
      const result = translateMfFilter(filter, model);
      expect(result, filter).toHaveProperty("error");
    }
  });

  it("compiles != as <> with the value bound as a parameter", () => {
    const kernel = kernelFor(":memory:");
    const { compiled } = kernel.compile({ metrics: ["billed_amount"], time: JUL });
    expect(compiled.sql).toMatch(/"fct_invoices"\."invoice_status" <> \$\d/);
    expect(compiled.sql).not.toMatch(/"invoice_status" = /);
    expect(compiled.params).toContain("void");
  });
});

describe("D. cross-grain ratios cannot execute through any path", () => {
  it("are skipped on import and refused by name with the reason", () => {
    const kernel = kernelFor(":memory:");
    const refused = refusal(() => kernel.compile({ metrics: ["tickets_per_active_customer"] }));
    expect(refused.status).toBe("undefined_metric");
    expect(refused.message).toMatch(/dbt project but Grane did not import it/);
    expect(refused.message).toMatch(/cross-grain/);
    expect((refused.details as { unsupported: { provider: string } }).unsupported.provider).toBe("dbt");
  });

  it("are refused by the compiler even when defined natively", () => {
    const kernel = kernelFor(":memory:", {
      metrics: {
        ...contribution.metrics,
        native_cross_grain: {
          entity: "ticket",
          type: "ratio",
          numerator: "support_tickets",
          denominator: "signups",
          status: "approved",
          synonyms: [],
        },
      },
    });
    const refused = refusal(() => kernel.compile({ metrics: ["native_cross_grain"] }));
    expect(refused.status).toBe("unsafe_query");
    expect(refused.message).toMatch(/mixes grains/);
    expect(kernel.validate().issues.some((i) => i.code === "grain_mismatch")).toBe(true);
  });
});

describe("E. unsupported discovery", () => {
  const kernel = kernelFor(":memory:");

  it("lists skipped upstream definitions in the catalog with reasons", () => {
    const catalog = kernel.governedCatalog();
    const arr = catalog.unsupported.find((u) => u.name === "arr");
    expect(arr).toEqual(
      expect.objectContaining({ kind: "metric", source: expect.objectContaining({ provider: "dbt" }) }),
    );
    expect(arr?.reason).toMatch(/derived expr/);
    expect(catalog.metrics.some((m) => m.name === "arr")).toBe(false);
    expect(kernel.governedCatalog("arr").unsupported.map((u) => u.name)).toContain("arr");
  });

  it("refuses deterministically and distinguishes 'not imported' from 'does not exist'", () => {
    const skipped = refusal(() => kernel.compile({ metrics: ["ARR"] }));
    expect(skipped.status).toBe("undefined_metric");
    expect(skipped.message).toMatch(/defined in the dbt project but Grane did not import it/);
    expect(skipped.message).toMatch(/Do not approximate/);
    expect(skipped.details).toEqual({
      unsupported: expect.objectContaining({ provider: "dbt", reason: expect.stringMatching(/derived/) }),
    });
    const unknown = refusal(() => kernel.compile({ metrics: ["gross_margin"] }));
    expect(unknown.status).toBe("undefined_metric");
    expect(unknown.details).toBeUndefined();
    expect(unknown.message).not.toMatch(/dbt project/);
  });
});

describe.skipIf(!available)("executed semantics (DuckDB)", () => {
  let kernel: GraneKernel;
  let path: string;

  beforeAll(async () => {
    path = await buildWarehouse();
    kernel = kernelFor(path);
  });
  afterAll(async () => {
    await kernel?.close();
  });

  const value = async (input: SemanticQueryInput, column: string): Promise<number> => {
    const result = await kernel.query(input);
    expect(result.trust).toBe("governed");
    expect(result.rows).toHaveLength(1);
    return Number(result.rows[0]![column]);
  };

  describe("A. counts", () => {
    it("COUNT(1) counts rows, COUNT(column) counts non-nulls", async () => {
      expect(await value({ metrics: ["invoice_count"], time: JUL }, "invoice_count")).toBe(5);
      expect(await value({ metrics: ["status_count"], time: JUL }, "status_count")).toBe(4);
      expect(await value({ metrics: ["paid_invoices"], time: JUL }, "paid_invoices")).toBe(2);
      expect(await value({ metrics: ["signups"] }, "signups")).toBe(5);
      expect(await value({ metrics: ["support_tickets"], time: JUL }, "support_tickets")).toBe(2);
      expect(await value({ metrics: ["balance_rows"] }, "balance_rows")).toBe(4);
    });

    it("row counts group and pre-aggregate", async () => {
      const grouped = await kernel.query({ metrics: ["invoice_count"], dimensions: ["invoice__country"], time: JUL });
      expect(grouped.rows.map((r) => [r.invoice__country, Number(r.invoice_count)])).toEqual([
        ["DE", 3],
        ["US", 2],
      ]);
    });
  });

  describe("B. filters", () => {
    it("!= and <> exclude, = includes; the two never coincide", async () => {
      expect(await value({ metrics: ["billed_amount"], time: JUL }, "billed_amount")).toBe(350);
      expect(await value({ metrics: ["billed_amount_ne"], time: JUL }, "billed_amount_ne")).toBe(350);
      expect(await value({ metrics: ["void_amount"], time: JUL }, "void_amount")).toBe(999);
      expect(await value({ metrics: ["revenue"], time: JUL }, "revenue")).toBe(300);
      expect(await value({ metrics: ["paying_signups"] }, "paying_signups")).toBe(4);
    });
  });

  describe("C. semi-additive", () => {
    it("one snapshot date for the whole set when group_by is omitted (MetricFlow default)", async () => {
      expect(contribution.metrics.ending_mrr).toEqual(
        expect.objectContaining({ additive: "semi", semi_additive: { window: "last", group_by: [], granularity: "month" } }),
      );
      // Not 660 (summed), not 350 (per customer): the August snapshot.
      expect(await value({ metrics: ["ending_mrr"], time: JUN_AUG }, "ending_mrr")).toBe(150);
      expect(await value({ metrics: ["ending_mrr"] }, "ending_mrr")).toBe(150);
    });

    it("the snapshot is chosen inside the requested window, not looked back past it", async () => {
      expect(await value({ metrics: ["ending_mrr"], time: JUL }, "ending_mrr")).toBe(370);
      expect(await value({ metrics: ["ending_mrr"], time: { from: "2026-06-01", to: "2026-06-30" } }, "ending_mrr")).toBe(140);
    });

    it("month grain gives one snapshot per month", async () => {
      const result = await kernel.query({ metrics: ["ending_mrr"], time: { ...JUN_AUG, grain: "month" } });
      expect(result.rows.map((r) => Number(r.ending_mrr))).toEqual([140, 370, 150]);
    });

    it("grouping by a dimension does not change the snapshot date", async () => {
      const result = await kernel.query({
        metrics: ["ending_mrr"],
        dimensions: ["customer_month__customer_segment"],
        time: JUN_AUG,
      });
      expect(result.rows.map((r) => [r.customer_month__customer_segment, Number(r.ending_mrr)])).toEqual([
        ["Enterprise", 120],
        ["SMB", 30],
      ]);
    });

    it("query filters apply before the snapshot is chosen", async () => {
      // US rows at the latest US month (August): c2 churned to 0. c3's July 200 is not the latest.
      expect(
        await value(
          { metrics: ["ending_mrr"], filters: [{ field: "customer_month__country", operator: "=", value: "US" }], time: JUN_AUG },
          "ending_mrr",
        ),
      ).toBe(0);
    });

    it("metric filters apply before the snapshot is chosen and to the aggregate", async () => {
      expect(await value({ metrics: ["enterprise_ending_mrr"], time: JUN_AUG }, "enterprise_ending_mrr")).toBe(120);
      const { compiled } = kernel.compile({ metrics: ["enterprise_ending_mrr"], time: JUN_AUG });
      expect(compiled.sql).toMatch(/SUM\("fct_mrr_snapshot"\."ending_mrr"\) FILTER \(WHERE "fct_mrr_snapshot"\."segment" = \$\d\)/);
    });

    it("explicit group_by keeps one snapshot per entity, still inside the window", async () => {
      expect(contribution.metrics.ending_mrr_by_customer?.semi_additive).toEqual({
        window: "last",
        group_by: ["${fct_mrr_snapshot.customer_id}"],
        granularity: "month",
      });
      expect(await value({ metrics: ["ending_mrr_by_customer"], time: JUN_AUG }, "ending_mrr_by_customer")).toBe(350);
      expect(await value({ metrics: ["ending_mrr_by_customer"], time: AUG }, "ending_mrr_by_customer")).toBe(150);
      expect(
        await value(
          {
            metrics: ["ending_mrr_by_customer"],
            filters: [{ field: "customer_month__country", operator: "=", value: "US" }],
            time: JUN_AUG,
          },
          "ending_mrr_by_customer",
        ),
      ).toBe(200);
    });

    it("window_agg: min takes the first snapshot", async () => {
      expect(await value({ metrics: ["opening_mrr"], time: JUN_AUG }, "opening_mrr")).toBe(140);
      expect(await value({ metrics: ["opening_mrr"], time: { from: "2026-07-01", to: "2026-08-31" } }, "opening_mrr")).toBe(370);
    });

    it("compares snapshot dates at the declared granularity, keeping every row in the last period", async () => {
      expect(contribution.metrics.monthly_balance?.semi_additive).toEqual({ window: "last", group_by: [], granularity: "month" });
      expect(contribution.metrics.ending_mrr?.semi_additive?.granularity).toBe("month");
      expect(contribution.metrics.account_balance?.semi_additive?.granularity).toBe("day");
      // April has two rows (80 + 70); last-day-only would give 70.
      expect(await value({ metrics: ["monthly_balance"] }, "monthly_balance")).toBe(150);
      const byMonth = await kernel.query({
        metrics: ["monthly_balance"],
        time: { from: "2024-03-01", to: "2024-04-30", grain: "month" },
      });
      expect(byMonth.rows.map((r) => Number(r.monthly_balance))).toEqual([190, 150]);
      expect(byMonth.provenance.generated_sql).toMatch(/MAX\(date_trunc\('month', "fct_monthly_balances"\."snapshot_date"\)\)/);
      // A grain finer than the snapshot granularity would split one snapshot across buckets.
      const refused = await refusalAsync(() =>
        kernel.query({ metrics: ["monthly_balance"], time: { from: "2024-03-01", to: "2024-04-30", grain: "day" } }),
      );
      expect(refused.status).toBe("unsafe_query");
      expect(refused.message).toMatch(/month granularity/);
    });

    it("refuses a time.dimension other than the metric's own instead of ignoring it", async () => {
      const refused = await refusalAsync(() =>
        kernel.query({ metrics: ["ending_mrr"], time: { ...JUN_AUG, dimension: "reported_at" } }),
      );
      expect(refused.status).toBe("unsafe_query");
      expect(refused.message).toMatch(/own time dimension/);
    });

    it("legacy window_groupings / window_choice map the same way", async () => {
      expect(contribution.metrics.account_balance?.semi_additive).toEqual({
        window: "last",
        group_by: ["${fct_balances.account_id}"],
        granularity: "day",
      });
      expect(await value({ metrics: ["account_balance"] }, "account_balance")).toBe(2000);
      expect(await value({ metrics: ["total_balance_first_day"] }, "total_balance_first_day")).toBe(1000);
    });

    it("a ratio of two metrics with the same snapshot selection executes", async () => {
      expect(await value({ metrics: ["active_customers"], time: AUG }, "active_customers")).toBe(2);
      expect(await value({ metrics: ["arpu"], time: AUG }, "arpu")).toBe(75);
    });

    it("refuses to combine a semi-additive metric with anything that selects rows differently", async () => {
      const mixed = await refusalAsync(() => kernel.query({ metrics: ["ending_mrr", "new_mrr"], time: AUG }));
      expect(mixed.status).toBe("unsafe_query");
      expect(mixed.message).toMatch(/Query them separately/);
      const differentFilters = await refusalAsync(() =>
        kernel.query({ metrics: ["ending_mrr", "enterprise_ending_mrr"], time: AUG }),
      );
      expect(differentFilters.status).toBe("unsafe_query");
      const sameSelection = await kernel.query({ metrics: ["ending_mrr", "active_customers"], time: AUG });
      expect(Number(sameSelection.rows[0]!.ending_mrr)).toBe(150);
      expect(Number(sameSelection.rows[0]!.active_customers)).toBe(2);
    });
  });

  describe("D/E. refusals are refusals at execution time too", () => {
    it("skipped upstream metrics refuse with the reason", async () => {
      const refused = await refusalAsync(() => kernel.query({ metrics: ["tickets_per_active_customer"], time: JUL }));
      expect(refused.status).toBe("undefined_metric");
      expect(refused.message).toMatch(/cross-grain ratios are not compiled/);
    });

    it("simple derived ratios of imported components execute", async () => {
      expect(await value({ metrics: ["revenue_per_invoice"], time: JUL }, "revenue_per_invoice")).toBe(60);
      expect(await value({ metrics: ["simple_derived_ratio"], time: JUL }, "simple_derived_ratio")).toBe(60);
    });
  });

  describe("F. fill_nulls_with (COALESCE over the aggregate, as MetricFlow compiles it)", () => {
    const EMPTY = { from: "2025-01-01", to: "2025-01-31" };

    it("SUM with rows is unchanged; SUM over no rows becomes the declared literal, not null", async () => {
      expect(await value({ metrics: ["revenue_filled"], time: JUL }, "revenue_filled")).toBe(300);
      const filled = await kernel.query({ metrics: ["revenue_filled"], time: EMPTY });
      expect(filled.rows).toEqual([{ revenue_filled: 0 }]);
      expect(filled.trust).toBe("governed");
      expect(filled.provenance.generated_sql).toMatch(/COALESCE\(SUM\("fct_invoices"\."paid_amount"\), 0\)/);
      expect(await value({ metrics: ["revenue_filled_minus_one"], time: EMPTY }, "revenue_filled_minus_one")).toBe(-1);
    });

    it("a metric without fill_nulls_with still reports SQL's null over no rows", async () => {
      const plain = await kernel.query({ metrics: ["revenue"], time: EMPTY });
      expect(plain.rows).toEqual([{ revenue: null }]);
      expect(plain.provenance.generated_sql).not.toMatch(/COALESCE/);
    });

    it("the semi-additive ending_mrr (fill_nulls_with: 0) is 0, not null, for a window with no snapshots", async () => {
      const r = await kernel.query({ metrics: ["ending_mrr"], time: EMPTY });
      expect(r.rows).toEqual([{ ending_mrr: 0 }]);
      expect(r.trust).toBe("governed");
    });

    it("COUNT over no rows is 0 with or without a fill; a join_to_timespine metric refuses per-period breakdowns", async () => {
      expect(await value({ metrics: ["invoice_count_dense"], time: EMPTY }, "invoice_count_dense")).toBe(0);
      expect(await value({ metrics: ["invoice_count_dense"], time: JUL }, "invoice_count_dense")).toBe(5);
      const byCountry = await kernel.query({ metrics: ["invoice_count_dense"], dimensions: ["invoice__country"], time: JUL });
      expect(byCountry.rows).toEqual([
        { invoice__country: "DE", invoice_count_dense: 3n },
        { invoice__country: "US", invoice_count_dense: 2n },
      ]);
      const refused = await refusalAsync(() =>
        kernel.query({ metrics: ["invoice_count_dense"], time: { ...JUN_AUG, grain: "month" } }),
      );
      expect(refused.status).toBe("unsafe_query");
      expect(refused.message).toMatch(/join_to_timespine.*does not generate empty periods/);
      // The same breakdown of a metric without join_to_timespine is exact and allowed (sparse is what MetricFlow returns too).
      const sparse = await kernel.query({ metrics: ["invoice_count"], time: { ...JUN_AUG, grain: "month" } });
      expect(sparse.rows.map((row) => row.invoice_count)).toEqual([5n, 2n]);
    });

    it("ratio components keep their own fill; the ratio itself follows NULLIF on the denominator", async () => {
      expect(await value({ metrics: ["filled_revenue_per_invoice"], time: JUL }, "filled_revenue_per_invoice")).toBe(60);
      const r = await kernel.query({ metrics: ["filled_revenue_per_invoice"], time: EMPTY });
      expect(r.rows).toEqual([{ filled_revenue_per_invoice: null }]);
      expect(r.provenance.generated_sql).toMatch(/COALESCE\(SUM\("fct_invoices"\."paid_amount"\), 0\)/);
    });
  });
});

describe.skipIf(!available)("native semi_additive configuration", () => {
  let kernel: GraneKernel;
  let path: string;

  beforeAll(async () => {
    path = await buildWarehouse();
    kernel = new GraneKernel(
      graneConfigSchema.parse({
        connection: { type: "duckdb", path, schema: "main" },
        entities: {
          balance_row: { table: "fct_balances", primary_key: "balance_id" },
          account_snapshot: { table: "fct_balances", primary_key: "account_id" },
        },
        metrics: {
          per_row_default: {
            entity: "balance_row",
            type: "sum",
            sql: "${fct_balances.balance}",
            time_dimension: "${fct_balances.snapshot_date}",
            additive: "semi",
          },
          per_account_default: {
            entity: "account_snapshot",
            type: "sum",
            sql: "${fct_balances.balance}",
            time_dimension: "${fct_balances.snapshot_date}",
            additive: "semi",
          },
          per_account_explicit: {
            entity: "balance_row",
            type: "sum",
            sql: "${fct_balances.balance}",
            time_dimension: "${fct_balances.snapshot_date}",
            additive: "semi",
            semi_additive: { group_by: ["${fct_balances.account_id}"] },
          },
          latest_day_total: {
            entity: "balance_row",
            type: "sum",
            sql: "${fct_balances.balance}",
            time_dimension: "${fct_balances.snapshot_date}",
            additive: "semi",
            semi_additive: { group_by: [] },
          },
        },
      }),
    );
  });
  afterAll(async () => {
    await kernel?.close();
  });

  it("group_by defaults to the entity primary key; explicit lists and [] behave as declared", async () => {
    const one = async (name: string) => Number((await kernel.query({ metrics: [name] })).rows[0]![name]);
    // A surrogate row key makes "one snapshot per key" mean every row: the declared semantics, visibly.
    expect(await one("per_row_default")).toBe(3000);
    expect(await one("per_account_default")).toBe(2000);
    expect(await one("per_account_explicit")).toBe(2000);
    expect(await one("latest_day_total")).toBe(1300);
  });

  it("rejects semi_additive without additive: semi and group_by off the entity table", () => {
    expect(() =>
      graneConfigSchema.parse({
        entities: { b: { table: "fct_balances", primary_key: "balance_id" } },
        metrics: {
          bad: { entity: "b", type: "sum", sql: "${fct_balances.balance}", semi_additive: { group_by: [] } },
        },
      }),
    ).toThrow(/only meaningful with additive: semi/);
    const model = new GraneKernel(
      graneConfigSchema.parse({
        entities: { b: { table: "fct_balances", primary_key: "balance_id" } },
        metrics: {
          bad: {
            entity: "b",
            type: "sum",
            sql: "${fct_balances.balance}",
            time_dimension: "${fct_balances.snapshot_date}",
            additive: "semi",
            semi_additive: { group_by: ["${other_table.account_id}"] },
          },
        },
      }),
    );
    expect(model.validate().issues.some((i) => i.code === "filter_out_of_scope")).toBe(true);
    expect(refusal(() => model.compile({ metrics: ["bad"] })).status).toBe("unsafe_query");
  });
});
