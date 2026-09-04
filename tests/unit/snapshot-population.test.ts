/**
 * Semi-additive snapshot population: base-table query filters must constrain
 * BOTH the rows the snapshot date is chosen from AND the rows retained at that
 * date. Regression for PR #19, where the filter was applied only to snapshot
 * selection and then dropped from `__grane_pop` whenever the query traversed a
 * relationship (governed-wrong numbers, plus false refusals from rows that
 * should never have entered the cardinality population).
 *
 * Conceptual pipeline:
 *   filtered facts -> snapshot chosen from filtered facts -> filtered facts at
 *   that snapshot -> P0 (metric contribution) -> P(n) reachability -> guards
 *   -> result
 *
 * Fixture (the independent tester's reproduction, plus a manager hop):
 *   fct_mrr(row_id, customer_id, snap_date, plan, billing, mrr_val)
 *     1  c1  2024-01-01  pro    monthly  100
 *     2  c2  2024-01-01  basic  monthly   40
 *     3  c1  2024-01-02  pro    annual   120
 *     4  c2  2024-01-02  basic  monthly   50
 *     5  c1  2024-01-02  basic  monthly   30
 *     6  c2  2024-01-03  basic  monthly   55
 *   dim_customers(customer_id, tier, manager_id): c1 gold -> 1, c2 silver -> 2
 *   dim_managers(manager_id, manager_name):       1 Maya, 2 Ravi
 *
 * Every expectation is what MetricFlow returns for filter-before-snapshot
 * semantics (`non_additive_dimension` with window_choice max).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { CONTRIB_CTE, POP_CTE } from "../../src/compile/compiler.js";
import type { SemanticQueryInput } from "../../src/query/model.js";

type Row = Array<string | number | null>;
interface Data {
  fct_mrr?: Row[];
  dim_customers?: Row[];
  dim_managers?: Row[];
}

const DDL: Record<keyof Data, string> = {
  fct_mrr: `CREATE TABLE fct_mrr (row_id INTEGER, customer_id INTEGER, snap_date DATE, plan VARCHAR, billing VARCHAR, mrr_val DECIMAL(18,2))`,
  dim_customers: `CREATE TABLE dim_customers (customer_id INTEGER, tier VARCHAR, manager_id INTEGER)`,
  dim_managers: `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
};

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
const available = await duckdbAvailable();

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

function config(path: string) {
  const semi = (group_by: string[], extra: Record<string, unknown> = {}) => ({
    entity: "mrr", type: "sum", sql: "${fct_mrr.mrr_val}", time_dimension: "${fct_mrr.snap_date}",
    additive: "semi", semi_additive: { window: "last", group_by }, ...extra,
  });
  return graneConfigSchema.parse({
    project: { name: "snapshot-population", timezone: "UTC" },
    connection: { type: "duckdb", path, schema: "main" },
    entities: {
      mrr: { table: "fct_mrr", primary_key: "row_id" },
      customer: { table: "dim_customers", primary_key: "customer_id" },
      manager: { table: "dim_managers", primary_key: "manager_id" },
    },
    metrics: {
      ending_mrr: semi([]),
      ending_mrr_by_customer: semi(["${fct_mrr.customer_id}"]),
      peak_mrr: { ...semi([]), type: "max" },
      monthly_ending_mrr: semi([], { filters: { "fct_mrr.billing": "monthly" } }),
      monthly_ending_mrr_by_customer: semi(["${fct_mrr.customer_id}"], { filters: { "fct_mrr.billing": "monthly" } }),
    },
    dimensions: {
      plan: { entity: "mrr", sql: "${fct_mrr.plan}" },
      billing: { entity: "mrr", sql: "${fct_mrr.billing}" },
      tier: { entity: "customer", sql: "${dim_customers.tier}" },
      manager_name: { entity: "manager", sql: "${dim_managers.manager_name}" },
    },
    relationships: {
      mrr_customers: { from: "fct_mrr.customer_id", to: "dim_customers.customer_id", type: "many_to_one" },
      customers_managers: { from: "dim_customers.manager_id", to: "dim_managers.manager_id", type: "many_to_one" },
    },
  });
}

async function scenario(data: Data = {}): Promise<GraneKernel> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-snap-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const table of Object.keys(DDL) as Array<keyof Data>) {
    await conn.run(DDL[table]);
    const rows = data[table] ?? DEFAULT[table];
    if (rows.length > 0) {
      await conn.run(`INSERT INTO ${table} VALUES ${rows.map((r) => `(${r.map(literal).join(", ")})`).join(", ")}`);
    }
  }
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const kernel = new GraneKernel(config(path));
  kernels.push(kernel);
  return kernel;
}

async function refusal(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a refusal");
}

const n = (v: unknown): number => Number(v);
const by = (rows: Record<string, unknown>[], dim: string, metric: string): Record<string, number | null> =>
  Object.fromEntries(rows.map((r) => [String(r[dim]), r[metric] == null ? null : n(r[metric])]));

const MRR: Row[] = [
  [1, 1, "2024-01-01", "pro", "monthly", 100],
  [2, 2, "2024-01-01", "basic", "monthly", 40],
  [3, 1, "2024-01-02", "pro", "annual", 120],
  [4, 2, "2024-01-02", "basic", "monthly", 50],
  [5, 1, "2024-01-02", "basic", "monthly", 30],
  [6, 2, "2024-01-03", "basic", "monthly", 55],
];
const CUSTOMERS: Row[] = [[1, "gold", 1], [2, "silver", 2]];
const MANAGERS: Row[] = [[1, "Maya"], [2, "Ravi"]];
const DEFAULT: Record<keyof Data, Row[]> = { fct_mrr: MRR, dim_customers: CUSTOMERS, dim_managers: MANAGERS };
const dupCustomer = (id: number): Row => [id, `dup${id}`, id];
const dupManager = (id: number): Row => [id, `Dup${id}`];

type Filter = NonNullable<SemanticQueryInput["filters"]>[number];
const f = (field: string, value?: Filter["value"], operator: Filter["operator"] = "="): Filter => ({ field, operator, value });
const PRO = [f("plan", "pro")];
const BASIC = [f("plan", "basic")];

async function governed(k: GraneKernel, q: SemanticQueryInput) {
  const r = await k.query(q);
  expect(r.trust).toBe("governed");
  return r;
}

describe.skipIf(!available)("semi-additive snapshot population + base query filter", () => {
  it("A: global snapshot + base filter + joined dimension (the tester's reproduction)", async () => {
    const k = await scenario();
    // plan=pro leaves rows 1,3 → snapshot 01-02 → only row 3 at that date is pro.
    const r = await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: PRO });
    expect(by(r.rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
    // plan=basic leaves rows 2,4,5,6 → snapshot 01-03 → row 6.
    const basic = await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: BASIC });
    expect(by(basic.rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    // Unfiltered control: 01-03 → row 6.
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"] })).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
  });

  it("B: same metric and filter without a relationship traversal stays correct", async () => {
    const k = await scenario();
    expect(n((await governed(k, { metrics: ["ending_mrr"], filters: PRO })).rows[0]?.ending_mrr)).toBe(120);
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["plan"], filters: PRO })).rows, "plan", "ending_mrr")).toEqual({ pro: 120 });
    expect(n((await governed(k, { metrics: ["ending_mrr_by_customer"], filters: BASIC })).rows[0]?.ending_mrr_by_customer)).toBe(85);
  });

  it("C: grouped snapshot (window_groupings) filters before selection and at the selected rows", async () => {
    const k = await scenario();
    // c1 pro → 01-02 (row 3); c2 has no pro rows.
    expect(by((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"], filters: PRO })).rows, "tier", "ending_mrr_by_customer")).toEqual({ gold: 120 });
    // c1 basic → 01-02 but only row 5 (row 3 is pro, same key, same date); c2 basic → 01-03.
    expect(by((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"], filters: BASIC })).rows, "tier", "ending_mrr_by_customer")).toEqual({ gold: 30, silver: 55 });
    // Unfiltered control: c1 → 01-02 (120 + 30), c2 → 01-03.
    expect(by((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"] })).rows, "tier", "ending_mrr_by_customer")).toEqual({ gold: 150, silver: 55 });
  });

  it("D: every supported base predicate shape survives snapshot selection", async () => {
    const k = await scenario();
    const q = (filters: SemanticQueryInput["filters"]) => governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters });
    expect(by((await q([f("plan", "pro", "!=")])).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    expect(by((await q([f("plan", ["pro"], "in")])).rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
    expect(by((await q([f("plan", ["basic"], "not_in")])).rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
    expect(by((await q([f("plan", "ro", "contains")])).rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
    // Two base predicates: pro AND monthly → row 1 only → 01-01 → gold 100 (row 2 at 01-01 is basic).
    expect(by((await q([f("plan", "pro"), f("billing", "monthly")])).rows, "tier", "ending_mrr")).toEqual({ gold: 100 });
  });

  it("E: time bounds and base filter compose before the snapshot", async () => {
    const k = await scenario();
    const jan1 = { from: "2024-01-01", to: "2024-01-01" };
    const jan1to2 = { from: "2024-01-01", to: "2024-01-02" };
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: PRO, time: jan1 })).rows, "tier", "ending_mrr")).toEqual({ gold: 100 });
    // basic within 01-01..01-02 → snapshot 01-02 → rows 4 and 5 (row 3 is pro).
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: BASIC, time: jan1to2 })).rows, "tier", "ending_mrr")).toEqual({ gold: 30, silver: 50 });
    expect(by((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"], filters: PRO, time: jan1to2 })).rows, "tier", "ending_mrr_by_customer")).toEqual({ gold: 120 });
    // Monthly grain: each month's snapshot is chosen from filtered rows only.
    const monthly = await governed(k, { metrics: ["ending_mrr"], filters: PRO, time: { ...jan1to2, grain: "month" } });
    expect(monthly.rows.map((r) => n(r.ending_mrr))).toEqual([120]);
  });

  it("F: base filter constrains the population; joined filter keeps its result/traversal role", async () => {
    const k = await scenario();
    expect(n((await governed(k, { metrics: ["ending_mrr"], filters: [...PRO, f("tier", "gold")] })).rows[0]?.ending_mrr)).toBe(120);
    // basic AND tier=gold: snapshot from row 5 → 01-02; population is basic rows at 01-02 (4, 5); result keeps gold → 30.
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [...BASIC, f("tier", "gold")] })).rows, "tier", "ending_mrr")).toEqual({ gold: 30 });
    // The joined filter constrains P(n) of dim_customers: c2's copies are
    // silver/dup2, not gold, so they do not survive tier=gold.
    const dupSilver = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(2)] });
    expect(by((await governed(dupSilver, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [...BASIC, f("tier", "gold")] })).rows, "tier", "ending_mrr")).toEqual({ gold: 30 });
    // Inverse: both copies of c2 match the joined filter → refuse.
    const twoGold = await scenario({ dim_customers: [[1, "gold", 1], [2, "gold", 2], [2, "gold", 2]] });
    expect((await refusal(() => twoGold.query({ metrics: ["ending_mrr"], dimensions: ["tier"], filters: [...BASIC, f("tier", "gold")] }))).status).toBe("unsafe_query");
    // ...but with plan=pro the base population is row 3 only, so c2's duplicate is unreachable.
    expect(by((await governed(dupSilver, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [...PRO, f("tier", "gold")] })).rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
  });

  it("G: metric-definition filters keep their PR #19 contribution semantics", async () => {
    const k = await scenario();
    // monthly rows 1,2,4,5,6 → global snapshot 01-03 → row 6.
    const global = await governed(k, { metrics: ["monthly_ending_mrr"], dimensions: ["tier"] });
    expect(by(global.rows, "tier", "monthly_ending_mrr")).toEqual({ silver: 55 });
    // grouped: c1 monthly → 01-02 (row 5 only, row 3 is annual); c2 → 01-03.
    const grouped = await governed(k, { metrics: ["monthly_ending_mrr_by_customer"], dimensions: ["tier"] });
    expect(by(grouped.rows, "tier", "monthly_ending_mrr_by_customer")).toEqual({ gold: 30, silver: 55 });
    // Global metric: P0 = {row 6} → c1's duplicate is unreachable. Grouped metric: c1 contributes row 5 → refuse.
    const dupGold = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(1)] });
    expect(by((await governed(dupGold, { metrics: ["monthly_ending_mrr"], dimensions: ["tier"] })).rows, "tier", "monthly_ending_mrr")).toEqual({ silver: 55 });
    expect((await refusal(() => dupGold.query({ metrics: ["monthly_ending_mrr_by_customer"], dimensions: ["tier"] }))).status).toBe("unsafe_query");
  });

  it("H: query filter and metric filter compose (both before the snapshot, both at the selected rows)", async () => {
    const k = await scenario();
    // pro AND monthly → row 1 → 01-01. Row 2 (basic, monthly, 01-01) must not leak in via the metric FILTER clause.
    expect(by((await governed(k, { metrics: ["monthly_ending_mrr"], dimensions: ["tier"], filters: PRO })).rows, "tier", "monthly_ending_mrr")).toEqual({ gold: 100 });
    expect(by((await governed(k, { metrics: ["monthly_ending_mrr_by_customer"], dimensions: ["tier"], filters: PRO })).rows, "tier", "monthly_ending_mrr_by_customer")).toEqual({ gold: 100 });
    // basic AND monthly: c1 → 01-02 row 5, c2 → 01-03 row 6.
    expect(by((await governed(k, { metrics: ["monthly_ending_mrr_by_customer"], dimensions: ["tier"], filters: BASIC })).rows, "tier", "monthly_ending_mrr_by_customer")).toEqual({ gold: 30, silver: 55 });
    // Contradictory query and metric predicates → empty, not an unfiltered snapshot.
    expect((await governed(k, { metrics: ["monthly_ending_mrr"], dimensions: ["tier"], filters: [f("billing", "annual")] })).rows).toEqual([]);
  });

  it("I: a duplicate reachable from a fact that survives the base filter refuses", async () => {
    const k = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(1)] });
    for (const metric of ["ending_mrr", "ending_mrr_by_customer"]) {
      const r = await refusal(() => k.query({ metrics: [metric], dimensions: ["tier"], filters: PRO }));
      expect(r.status).toBe("unsafe_query");
      expect(r.message).toContain("mrr_customers");
    }
  });

  it("J: a duplicate reachable only from a base-filtered-out fact does not refuse", async () => {
    // Row 4 (c2, basic) shares snapshot date 01-02 with row 3 (c1, pro) but fails plan=pro.
    const k = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(2)] });
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: PRO })).rows, "tier", "ending_mrr")).toEqual({ gold: 120 });
    expect(by((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"], filters: PRO })).rows, "tier", "ending_mrr_by_customer")).toEqual({ gold: 120 });
    // Control: without the filter c2 participates and the duplicate must refuse.
    expect((await refusal(() => k.query({ metrics: ["ending_mrr"], dimensions: ["tier"] }))).status).toBe("unsafe_query");
  });

  it("K: multi-hop reachability follows the filtered snapshot population", async () => {
    // plan=pro → row 3 → c1 → Maya. Row 4 (c2 → Ravi) is at the same date but filtered out.
    const hop1 = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(1)] });
    expect((await refusal(() => hop1.query({ metrics: ["ending_mrr"], dimensions: ["manager_name"], filters: PRO }))).status).toBe("unsafe_query");
    const hop2 = await scenario({ dim_managers: [...MANAGERS, dupManager(1)] });
    expect((await refusal(() => hop2.query({ metrics: ["ending_mrr"], dimensions: ["manager_name"], filters: PRO }))).status).toBe("unsafe_query");
    const unreachable = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(2)], dim_managers: [...MANAGERS, dupManager(2)] });
    expect(by((await governed(unreachable, { metrics: ["ending_mrr"], dimensions: ["manager_name"], filters: PRO })).rows, "manager_name", "ending_mrr")).toEqual({ Maya: 120 });
    // plan=basic → row 6 → c2 → Ravi; Maya's duplicate is unreachable.
    expect(by((await governed(hop2, { metrics: ["ending_mrr"], dimensions: ["manager_name"], filters: BASIC })).rows, "manager_name", "ending_mrr")).toEqual({ Ravi: 55 });
    // Same for the grouped snapshot: c1 basic → row 5 → Maya (30), c2 → row 6 → Ravi (55).
    expect(by((await governed(unreachable, { metrics: ["ending_mrr_by_customer"], dimensions: ["manager_name"], filters: PRO })).rows, "manager_name", "ending_mrr_by_customer")).toEqual({ Maya: 120 });
    // Provenance is unchanged: P0 → customers → managers.
    const { compiled } = hop2.compile({ metrics: ["ending_mrr"], dimensions: ["manager_name"], filters: PRO });
    expect(compiled.guards.map((g) => [g.table, g.keySource, g.reach])).toEqual([
      ["dim_customers", POP_CTE, "__grane_reach_dim_customers"],
      ["dim_managers", "__grane_reach_dim_customers", "__grane_reach_dim_managers"],
    ]);
  });

  it("L: multi-metric with a shared snapshot keeps the filtered population for every metric", async () => {
    const k = await scenario();
    const pro = await governed(k, { metrics: ["ending_mrr", "peak_mrr"], dimensions: ["tier"], filters: PRO });
    expect(pro.rows).toEqual([{ tier: "gold", ending_mrr: 120, peak_mrr: 120 }]);
    const basic = await governed(k, { metrics: ["ending_mrr", "peak_mrr"], dimensions: ["tier"], filters: BASIC });
    expect(basic.rows).toEqual([{ tier: "silver", ending_mrr: 55, peak_mrr: 55 }]);
    // Different snapshot selections still refuse rather than share one population.
    expect((await refusal(() => k.query({ metrics: ["ending_mrr", "monthly_ending_mrr"], dimensions: ["tier"], filters: PRO }))).status).toBe("unsafe_query");
  });

  it("M: an empty filtered population yields no snapshot, no fabricated value and no invented violation", async () => {
    const k = await scenario({ dim_customers: [...CUSTOMERS, dupCustomer(1), dupCustomer(2)] });
    const none = [f("plan", "enterprise")];
    expect((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: none })).rows).toEqual([]);
    expect((await governed(k, { metrics: ["ending_mrr_by_customer"], dimensions: ["tier"], filters: none })).rows).toEqual([]);
    // Scalar: one row with a NULL aggregate (SUM of nothing), with and without a joined filter.
    expect((await governed(k, { metrics: ["ending_mrr"], filters: none })).rows).toEqual([{ ending_mrr: null }]);
    expect((await governed(k, { metrics: ["ending_mrr"], filters: [...none, f("tier", "gold")] })).rows).toEqual([{ ending_mrr: null }]);
  });

  it("N: NULL base values follow the same three-valued logic for selection and retention", async () => {
    // Row 7 (c1, 01-03, plan NULL) shares the unfiltered snapshot date with row 6.
    const k = await scenario({ fct_mrr: [...MRR, [7, 1, "2024-01-03", null, "monthly", 70]] });
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"] })).rows, "tier", "ending_mrr")).toEqual({ gold: 70, silver: 55 });
    // NULL != 'pro' is UNKNOWN: excluded from selection AND from the rows at 01-03.
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [f("plan", "pro", "!=")] })).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [f("plan", ["pro"], "not_in")] })).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [f("plan", undefined, "is_null")] })).rows, "tier", "ending_mrr")).toEqual({ gold: 70 });
    expect(by((await governed(k, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [f("plan", undefined, "is_not_null")] })).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    // The NULL-plan row's duplicate is unreachable once `!= 'pro'` excludes it.
    const dup = await scenario({ fct_mrr: [...MRR, [7, 1, "2024-01-03", null, "monthly", 70]], dim_customers: [...CUSTOMERS, dupCustomer(1)] });
    expect(by((await governed(dup, { metrics: ["ending_mrr"], dimensions: ["tier"], filters: [f("plan", "pro", "!=")] })).rows, "tier", "ending_mrr")).toEqual({ silver: 55 });
    expect((await refusal(() => dup.query({ metrics: ["ending_mrr"], dimensions: ["tier"] }))).status).toBe("unsafe_query");
  });

  it("SQL shape: the population reapplies the base predicate after the snapshot join; joined and metric filters stay out", async () => {
    const k = await scenario();
    const { compiled } = k.compile({ metrics: ["monthly_ending_mrr"], dimensions: ["tier"], filters: [...PRO, f("tier", "gold")] });
    const pop = compiled.sql.match(/"__grane_pop" AS \(\n([\s\S]*?)\n\)/)?.[1] ?? "";
    expect(pop).toContain(`JOIN "last_monthly_ending_mrr"`);
    expect(pop).toMatch(/WHERE "fct_mrr"\."plan" = \$\d+$/);
    expect(pop).not.toContain(`"dim_customers"."tier"`);
    expect(pop).not.toContain(`"fct_mrr"."billing"`);
    // Metric filter lives in P0 and the FILTER clause; joined filter lives in the result.
    expect(compiled.sql).toMatch(new RegExp(`"${CONTRIB_CTE}" AS \\(\\n  SELECT \\*\\n  FROM "${POP_CTE}" AS "fct_mrr"\\n  WHERE \\("fct_mrr"\\."billing" = \\$\\d+\\)`));
    expect(compiled.sql).toMatch(/"__grane_reach_dim_customers" AS \([\s\S]*AND "dim_customers"\."tier" = \$\d+/);
    expect(compiled.sql).toMatch(/"__grane_result" AS \([\s\S]*WHERE "dim_customers"\."tier" = \$\d+/);
    // Parameters bind in textual order: snapshot CTE (billing, plan, tier),
    // pop (plan), contrib (billing), reach (tier), result (billing, tier).
    expect(compiled.params).toEqual(["monthly", "pro", "gold", "pro", "monthly", "gold", "monthly", "gold"]);
  });
});
