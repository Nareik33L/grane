/**
 * Cardinality populations: metric-contributing + relationship-reachable.
 *
 * A runtime cardinality guard protects the metrics of this query against a
 * specific relationship on a specific path. Its relevant keys are:
 *
 *   P0    base rows that can contribute to at least one requested metric
 *         (query time bounds, base-table query filters, the metric's own
 *         base-table filters / per-metric time window, snapshot selection)
 *   P(n)  rows of the n-th joined table referenced by a non-NULL FK in P(n-1)
 *   guard MAX(rows per key) over P(n)
 *
 * Every case below executes against DuckDB and asserts the analytical
 * consequence (numbers, groups, trust, refusal), not the SQL text.
 *
 * Fixture (native YAML):
 *   orders(id, customer_id, product_id, status, ordered_at, amount, channel)
 *     -> customers(id, name, manager_id)
 *         -> managers(id, name, region_id)
 *             -> regions(id, name)
 *     -> products(id, category)
 *   balances(id, customer_id, as_of, balance, kind, book) -> customers
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { CONTRIB_CTE, POP_CTE } from "../../src/compile/compiler.js";

type Row = Array<string | number | null>;
interface Data {
  orders?: Row[];
  customers?: Row[];
  managers?: Row[];
  regions?: Row[];
  products?: Row[];
  balances?: Row[];
}

const DDL: Record<keyof Data, string> = {
  orders: `CREATE TABLE orders (id INTEGER, customer_id INTEGER, product_id INTEGER, status VARCHAR, ordered_at DATE, amount DECIMAL(18,2), channel VARCHAR)`,
  customers: `CREATE TABLE customers (id INTEGER, name VARCHAR, manager_id INTEGER)`,
  managers: `CREATE TABLE managers (id INTEGER, name VARCHAR, region_id INTEGER)`,
  regions: `CREATE TABLE regions (id INTEGER, name VARCHAR)`,
  products: `CREATE TABLE products (id INTEGER, category VARCHAR)`,
  balances: `CREATE TABLE balances (id INTEGER, customer_id INTEGER, as_of DATE, balance DECIMAL(18,2), kind VARCHAR, book VARCHAR)`,
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

async function scenario(data: Data): Promise<GraneKernel> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-pop-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const table of Object.keys(DDL) as Array<keyof Data>) {
    await conn.run(DDL[table]);
    const rows = data[table] ?? [];
    if (rows.length > 0) {
      await conn.run(`INSERT INTO ${table} VALUES ${rows.map((r) => `(${r.map(literal).join(", ")})`).join(", ")}`);
    }
  }
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const kernel = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "populations", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: {
        order: { table: "orders", primary_key: "id" },
        customer: { table: "customers", primary_key: "id" },
        manager: { table: "managers", primary_key: "id" },
        region: { table: "regions", primary_key: "id" },
        product: { table: "products", primary_key: "id" },
        balance: { table: "balances", primary_key: "id" },
      },
      metrics: {
        revenue: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        order_count: { entity: "order", type: "count", time_dimension: "${orders.ordered_at}" },
        completed_revenue: {
          entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}",
          filters: { "orders.status": "complete" },
        },
        completed_count: {
          entity: "order", type: "count", time_dimension: "${orders.ordered_at}",
          filters: { "orders.status": "complete" },
        },
        pending_revenue: {
          entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}",
          filters: { "orders.status": "pending" },
        },
        completion_rate: { entity: "order", type: "ratio", numerator: "completed_revenue", denominator: "revenue" },
        completed_over_pending: { entity: "order", type: "ratio", numerator: "completed_revenue", denominator: "pending_revenue" },
        ending_balance: {
          entity: "balance", type: "sum", sql: "${balances.balance}", time_dimension: "${balances.as_of}",
          additive: "semi", semi_additive: { window: "last", group_by: ["${balances.customer_id}"] },
        },
        active_ending_balance: {
          entity: "balance", type: "sum", sql: "${balances.balance}", time_dimension: "${balances.as_of}",
          additive: "semi", semi_additive: { window: "last", group_by: ["${balances.customer_id}"] },
          filters: { "balances.kind": "active" },
        },
        global_ending_balance: {
          entity: "balance", type: "sum", sql: "${balances.balance}", time_dimension: "${balances.as_of}",
          additive: "semi", semi_additive: { window: "last", group_by: [] },
        },
      },
      dimensions: {
        channel: { entity: "order", sql: "${orders.channel}" },
        status: { entity: "order", sql: "${orders.status}" },
        account: { entity: "customer", sql: "${customers.name}" },
        manager_name: { entity: "manager", sql: "${managers.name}" },
        region_name: { entity: "region", sql: "${regions.name}" },
        category: { entity: "product", sql: "${products.category}" },
        book: { entity: "balance", sql: "${balances.book}" },
      },
      relationships: {
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        orders_products: { from: "orders.product_id", to: "products.id", type: "many_to_one" },
        customers_managers: { from: "customers.manager_id", to: "managers.id", type: "many_to_one" },
        managers_regions: { from: "managers.region_id", to: "regions.id", type: "many_to_one" },
        balances_customers: { from: "balances.customer_id", to: "customers.id", type: "many_to_one" },
      },
    }),
  );
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
const by = (rows: Record<string, unknown>[], dim: string, metric: string): Record<string, number> =>
  Object.fromEntries(rows.map((r) => [String(r[dim]), n(r[metric])]));
const total = (rows: Record<string, unknown>[], metric: string): number =>
  rows.reduce((s, r) => s + (r[metric] == null ? 0 : n(r[metric])), 0);

// ── Shared building blocks ──────────────────────────────────────────────────
// Clean chain: order 1 (cust 1, complete, Jan, web) -> Acme -> Maya -> UK
//              order 2 (cust 2, pending,  Feb, store) -> Corp -> Ravi -> US
const ORDERS: Row[] = [
  [1, 1, 10, "complete", "2026-01-10", 100, "web"],
  [2, 2, 11, "pending", "2026-02-10", 50, "store"],
];
const CUSTOMERS: Row[] = [[1, "Acme", 7], [2, "Corp", 8]];
const MANAGERS: Row[] = [[7, "Maya", 1], [8, "Ravi", 2]];
const REGIONS: Row[] = [[1, "UK"], [2, "US"]];
const PRODUCTS: Row[] = [[10, "Hardware"], [11, "Software"]];
// Ghost branch: no order reaches customer 99 -> manager 9 -> region 3.
const GHOST_CUSTOMER: Row[] = [[99, "Ghost", 9]];
const GHOST_MANAGER: Row[] = [[9, "Ghost", 3]];
const GHOST_REGION: Row[] = [[3, "Mars"]];
const dup = (row: Row, rename: string): Row => [row[0], rename, ...row.slice(2)];

// ═══════════════════════════════════════════════════════════════════════════
// 1. MULTI-HOP MATRIX (orders -> customers -> managers -> regions)
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!available)("multi-hop reachable populations", () => {
  // P0 = {order 1, order 2}; P1 = {cust 1, cust 2}; P2 = {mgr 7, mgr 8}; P3 = {UK, US}

  it("A: hop-1 participating duplicate refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup")], managers: MANAGERS, regions: REGIONS });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/customers\.id/);
    expect((r.details as { path: string[] }).path).toEqual(["orders_customers"]);
  });

  it("B: hop-1 unreachable duplicate executes", async () => {
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")],
      managers: MANAGERS, regions: REGIONS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "account", "revenue")).toEqual({ Acme: 100, Corp: 50 });
  });

  it("C: hop-2 participating duplicate refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[0]!, "MayaDup")], regions: REGIONS });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["manager_name"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/managers\.id/);
    expect((r.details as { path: string[] }).path).toEqual(["orders_customers", "customers_managers"]);
  });

  it("D: hop-2 unreachable duplicate executes (P1 excludes customer 99, so manager 9 is not in P2)", async () => {
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, ...GHOST_CUSTOMER],
      managers: [...MANAGERS, ...GHOST_MANAGER, dup(GHOST_MANAGER[0]!, "GhostDup")],
      regions: REGIONS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "manager_name", "revenue")).toEqual({ Maya: 100, Ravi: 50 });
  });

  it("E: hop-3 participating duplicate refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: [...REGIONS, dup(REGIONS[0]!, "UKDup")] });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["region_name"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/regions\.id/);
    expect((r.details as { path: string[] }).path).toEqual(["orders_customers", "customers_managers", "managers_regions"]);
  });

  it("F: hop-3 unreachable duplicate executes", async () => {
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, ...GHOST_CUSTOMER],
      managers: [...MANAGERS, ...GHOST_MANAGER],
      regions: [...REGIONS, ...GHOST_REGION, dup(GHOST_REGION[0]!, "MarsDup")],
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["region_name"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "region_name", "revenue")).toEqual({ UK: 100, US: 50 });
  });

  it("G: hop-1 and hop-2 participating duplicates refuse (hop-1 corruption cannot launder hop-2)", async () => {
    // Duplicated customer 1 rows point at different managers: one at the real
    // Maya (7), one at Ravi (8). Traversing the broken hop 1 makes both reachable,
    // but the hop-1 guard refuses on its own and hop-2 only gets stricter.
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, [1, "AcmeDup", 8]],
      managers: [...MANAGERS, dup(MANAGERS[0]!, "MayaDup")],
      regions: REGIONS,
    });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["manager_name"] }));
    expect(r.status).toBe("unsafe_query");
    const compiled = k.compile({ metrics: ["revenue"], dimensions: ["manager_name"] }).compiled;
    expect(compiled.guards.map((g) => g.table)).toEqual(["customers", "managers"]);
  });

  it("H: hop-2 and hop-3 participating duplicates refuse", async () => {
    const k = await scenario({
      orders: ORDERS, customers: CUSTOMERS,
      managers: [...MANAGERS, dup(MANAGERS[1]!, "RaviDup")],
      regions: [...REGIONS, dup(REGIONS[1]!, "USDup")],
    });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["region_name"] }));
    expect(r.status).toBe("unsafe_query");
  });

  it("I: duplicates at every hop, all unreachable, execute", async () => {
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")],
      managers: [...MANAGERS, ...GHOST_MANAGER, dup(GHOST_MANAGER[0]!, "GhostDup")],
      regions: [...REGIONS, ...GHOST_REGION, dup(GHOST_REGION[0]!, "MarsDup")],
    });
    const r = await k.query({ metrics: ["revenue", "order_count"], dimensions: ["region_name"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "region_name", "revenue")).toEqual({ UK: 100, US: 50 });
    expect(total(r.rows, "order_count")).toBe(2);
  });

  it("J: missing hop-1 target keeps the fact (NULL group)", async () => {
    const k = await scenario({ orders: [...ORDERS, [3, 3, 10, "complete", "2026-01-11", 20, "web"]], customers: CUSTOMERS, managers: MANAGERS, regions: REGIONS });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "account", "revenue")).toEqual({ Acme: 100, Corp: 50, null: 20 });
    expect(total(r.rows, "revenue")).toBe(170);
  });

  it("K: missing hop-2 target keeps the fact (NULL manager)", async () => {
    const k = await scenario({
      orders: [...ORDERS, [3, 3, 10, "complete", "2026-01-11", 20, "web"]],
      customers: [...CUSTOMERS, [3, "Solo", 42]],
      managers: MANAGERS, regions: REGIONS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(by(r.rows, "manager_name", "revenue")).toEqual({ Maya: 100, Ravi: 50, null: 20 });
  });

  it("L: missing hop-3 target keeps the fact (NULL region)", async () => {
    const k = await scenario({
      orders: [...ORDERS, [3, 3, 10, "complete", "2026-01-11", 20, "web"]],
      customers: [...CUSTOMERS, [3, "Solo", 10]],
      managers: [...MANAGERS, [10, "Lone", 77]],
      regions: REGIONS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["region_name"] });
    expect(by(r.rows, "region_name", "revenue")).toEqual({ UK: 100, US: 50, null: 20 });
  });

  it("M/N/O: NULL FK at each hop lands in the NULL group and reaches nothing", async () => {
    const k = await scenario({
      orders: [...ORDERS, [3, null, 10, "complete", "2026-01-11", 20, "web"], [4, 4, 10, "complete", "2026-01-12", 5, "web"], [5, 5, 10, "complete", "2026-01-13", 1, "web"]],
      customers: [...CUSTOMERS, [4, "NoMgr", null], [5, "HasMgr", 11], ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")],
      managers: [...MANAGERS, [11, "NoRegion", null], ...GHOST_MANAGER, dup(GHOST_MANAGER[0]!, "GhostDup")],
      regions: [...REGIONS, ...GHOST_REGION, dup(GHOST_REGION[0]!, "MarsDup")],
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["region_name"] });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "region_name", "revenue")).toEqual({ UK: 100, US: 50, null: 26 });
    expect(total(r.rows, "revenue")).toBe(176);
  });

  it("P: fact-side filter removes the branch that holds the duplicate", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[1]!, "RaviDup")], regions: REGIONS });
    const web = await k.query({ metrics: ["revenue"], dimensions: ["manager_name"], filters: [{ field: "channel", operator: "=", value: "web" }] });
    expect(web.trust).toBe("governed");
    expect(by(web.rows, "manager_name", "revenue")).toEqual({ Maya: 100 });
    const store = await refusal(() =>
      k.query({ metrics: ["revenue"], dimensions: ["manager_name"], filters: [{ field: "channel", operator: "=", value: "store" }] }),
    );
    expect(store.status).toBe("unsafe_query");
  });

  it("Q: time filter removes the branch that holds the duplicate", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: [...REGIONS, dup(REGIONS[1]!, "USDup")] });
    const jan = await k.query({ metrics: ["revenue"], dimensions: ["region_name"], time: { from: "2026-01-01", to: "2026-01-31" } });
    expect(jan.trust).toBe("governed");
    expect(by(jan.rows, "region_name", "revenue")).toEqual({ UK: 100 });
    const feb = await refusal(() =>
      k.query({ metrics: ["revenue"], dimensions: ["region_name"], time: { from: "2026-02-01", to: "2026-02-28" } }),
    );
    expect(feb.status).toBe("unsafe_query");
  });

  it("R: a joined filter on hop 1 does not shrink the population (hop-2 duplicate still refuses)", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[1]!, "RaviDup")], regions: REGIONS });
    const r = await refusal(() =>
      k.query({ metrics: ["revenue"], dimensions: ["manager_name"], filters: [{ field: "account", operator: "=", value: "Acme" }] }),
    );
    expect(r.status).toBe("unsafe_query");
    const clean = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: REGIONS });
    const ok = await clean.query({ metrics: ["revenue"], dimensions: ["manager_name"], filters: [{ field: "account", operator: "=", value: "Acme" }] });
    expect(ok.rows).toEqual([{ manager_name: "Maya", revenue: 100 }]);
  });

  it("S: a joined filter on hop 2 does not hide a hop-3 duplicate", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: [...REGIONS, dup(REGIONS[1]!, "USDup")] });
    const r = await refusal(() =>
      k.query({ metrics: ["revenue"], dimensions: ["region_name"], filters: [{ field: "manager_name", operator: "=", value: "Maya" }] }),
    );
    expect(r.status).toBe("unsafe_query");
  });

  it("T: a joined filter on hop 3 over clean data executes", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: REGIONS });
    const r = await k.query({ metrics: ["revenue"], filters: [{ field: "region_name", operator: "=", value: "UK" }] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.revenue)).toBe(100);
  });

  it("U/V/W/X: grouping by each hop and by several hops preserves the population", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: REGIONS, products: PRODUCTS });
    expect(by((await k.query({ metrics: ["revenue"], dimensions: ["account"] })).rows, "account", "revenue")).toEqual({ Acme: 100, Corp: 50 });
    expect(by((await k.query({ metrics: ["revenue"], dimensions: ["manager_name"] })).rows, "manager_name", "revenue")).toEqual({ Maya: 100, Ravi: 50 });
    expect(by((await k.query({ metrics: ["revenue"], dimensions: ["region_name"] })).rows, "region_name", "revenue")).toEqual({ UK: 100, US: 50 });
    const multi = await k.query({ metrics: ["revenue"], dimensions: ["account", "region_name", "category"] });
    expect(multi.trust).toBe("governed");
    expect(multi.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ account: "Acme", region_name: "UK", category: "Hardware", revenue: 100 }),
        expect.objectContaining({ account: "Corp", region_name: "US", category: "Software", revenue: 50 }),
      ]),
    );
    expect(total(multi.rows, "revenue")).toBe(150);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. METRIC-DEFINITION FILTERS
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!available)("metric-contributing populations", () => {
  // Customer 2 (pending order) is duplicated. It contributes to pending_revenue
  // and to unfiltered metrics, never to completed_*.
  const CUST2_DUP: Row[] = [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")];

  it("A: a row excluded by the metric filter does not poison the metric", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUST2_DUP });
    const r = await k.query({ metrics: ["completed_revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.completed_revenue)).toBe(100);
    expect(total(r.rows, "completed_revenue")).toBe(100);
    expect(k.compile({ metrics: ["completed_revenue"], dimensions: ["account"] }).compiled.guards[0]?.keySource).toBe(CONTRIB_CTE);
  });

  it("B: a contributing row that reaches the duplicate refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUST2_DUP });
    const pending = await refusal(() => k.query({ metrics: ["pending_revenue"], dimensions: ["account"] }));
    expect(pending.status).toBe("unsafe_query");
    expect((pending.details as { protects: string[] }).protects).toEqual(["pending_revenue"]);
    const unfiltered = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
    expect(unfiltered.status).toBe("unsafe_query");
    expect(k.compile({ metrics: ["revenue"], dimensions: ["account"] }).compiled.guards[0]?.keySource).toBe(POP_CTE);
  });

  it("C/D: the contributing population propagates through every hop", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[1]!, "RaviDup")], regions: REGIONS });
    const completed = await k.query({ metrics: ["completed_revenue"], dimensions: ["manager_name"] });
    expect(completed.trust).toBe("governed");
    expect(n(completed.rows.find((row) => row.manager_name === "Maya")?.completed_revenue)).toBe(100);
    const pending = await refusal(() => k.query({ metrics: ["pending_revenue"], dimensions: ["manager_name"] }));
    expect(pending.status).toBe("unsafe_query");
    const hop3 = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: [...REGIONS, dup(REGIONS[1]!, "USDup")] });
    expect((await hop3.query({ metrics: ["completed_revenue"], dimensions: ["region_name"] })).trust).toBe("governed");
    expect((await refusal(() => hop3.query({ metrics: ["pending_revenue"], dimensions: ["region_name"] }))).status).toBe("unsafe_query");
  });

  it("E/F: query-level fact filter and time bounds narrow the contributing population further", async () => {
    // Order 3: complete, Feb, store, customer 3 (duplicated).
    const k = await scenario({
      orders: [...ORDERS, [3, 3, 10, "complete", "2026-02-15", 20, "store"]],
      customers: [...CUSTOMERS, [3, "Solo", 7], [3, "SoloDup", 7]],
      managers: MANAGERS, regions: REGIONS,
    });
    expect((await refusal(() => k.query({ metrics: ["completed_revenue"], dimensions: ["account"] }))).status).toBe("unsafe_query");
    const web = await k.query({ metrics: ["completed_revenue"], dimensions: ["account"], filters: [{ field: "channel", operator: "=", value: "web" }] });
    expect(web.trust).toBe("governed");
    expect(by(web.rows, "account", "completed_revenue")).toEqual({ Acme: 100 });
    const jan = await k.query({ metrics: ["completed_revenue"], dimensions: ["account"], time: { from: "2026-01-01", to: "2026-01-31" } });
    expect(jan.trust).toBe("governed");
    expect(by(jan.rows, "account", "completed_revenue")).toEqual({ Acme: 100 });
  });

  it("H: a joined query filter does not hide a violation for a contributing row", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUST2_DUP });
    const completed = await k.query({ metrics: ["completed_revenue"], filters: [{ field: "account", operator: "=", value: "Acme" }] });
    expect(completed.trust).toBe("governed");
    expect(n(completed.rows[0]?.completed_revenue)).toBe(100);
    const pending = await refusal(() =>
      k.query({ metrics: ["pending_revenue"], filters: [{ field: "account", operator: "=", value: "Acme" }] }),
    );
    expect(pending.status).toBe("unsafe_query");
  });

  it("J: COUNT(1) with a metric filter uses the filtered population", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUST2_DUP });
    const r = await k.query({ metrics: ["completed_count"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.completed_count)).toBe(1);
    expect((await refusal(() => k.query({ metrics: ["order_count"], dimensions: ["account"] }))).status).toBe("unsafe_query");
  });

  it("K/L: ratios and multi-metric queries protect the union of component populations", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUST2_DUP });
    expect((await refusal(() => k.query({ metrics: ["completion_rate"], dimensions: ["account"] }))).status).toBe("unsafe_query");
    expect((await refusal(() => k.query({ metrics: ["completed_over_pending"], dimensions: ["account"] }))).status).toBe("unsafe_query");
    expect((await refusal(() => k.query({ metrics: ["completed_revenue", "pending_revenue"], dimensions: ["account"] }))).status).toBe("unsafe_query");
    const same = await k.query({ metrics: ["completed_revenue", "completed_count"], dimensions: ["account"] });
    expect(same.trust).toBe("governed");
    expect(n(same.rows.find((row) => row.account === "Acme")?.completed_count)).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. MULTI-METRIC POPULATIONS
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!available)("multi-metric populations", () => {
  const A = "completed_revenue"; // contributes: order 1 (customer 1)
  const B = "pending_revenue"; // contributes: order 2 (customer 2)

  it("A/I: same contributing population — duplicate outside it executes", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")] });
    const r = await k.query({ metrics: [A, "completed_count"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.completed_revenue)).toBe(100);
  });

  it("B/C: duplicate reachable only from A's population refuses A+B", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup")] });
    expect((await refusal(() => k.query({ metrics: [A, B], dimensions: ["account"] }))).status).toBe("unsafe_query");
    // B alone is safe: customer 1 contributes nothing to it.
    const bOnly = await k.query({ metrics: [B], dimensions: ["account"] });
    expect(bOnly.trust).toBe("governed");
    expect(n(bOnly.rows.find((row) => row.account === "Corp")?.pending_revenue)).toBe(50);
  });

  it("D: duplicate reachable only from B's population refuses A+B", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")] });
    expect((await refusal(() => k.query({ metrics: [A, B], dimensions: ["account"] }))).status).toBe("unsafe_query");
    expect((await k.query({ metrics: [A], dimensions: ["account"] })).trust).toBe("governed");
  });

  it("E: duplicate reachable from both refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup"), dup(CUSTOMERS[1]!, "CorpDup")] });
    expect((await refusal(() => k.query({ metrics: [A, B], dimensions: ["account"] }))).status).toBe("unsafe_query");
  });

  it("F: duplicate reachable from neither executes", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")] });
    const r = await k.query({ metrics: [A, B], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.completed_revenue)).toBe(100);
    expect(n(r.rows.find((row) => row.account === "Corp")?.pending_revenue)).toBe(50);
  });

  it("G: a filtered metric plus an unfiltered metric protects every row", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")] });
    expect((await refusal(() => k.query({ metrics: [A, "revenue"], dimensions: ["account"] }))).status).toBe("unsafe_query");
    expect(k.compile({ metrics: [A, "revenue"], dimensions: ["account"] }).compiled.plan.population.contributing).toBe(POP_CTE);
  });

  it("H: a filtered additive metric with a semi-additive metric is refused as before", async () => {
    const k = await scenario({ orders: ORDERS, customers: CUSTOMERS });
    const r = await refusal(() => k.query({ metrics: [A, "ending_balance"] }));
    expect(["invalid_query", "unsafe_query"]).toContain(r.status);
  });

  it("J/K: two relationships from one fact are guarded independently", async () => {
    const k = await scenario({
      orders: ORDERS,
      customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")],
      products: [...PRODUCTS, [12, "Ghost"], [12, "GhostDup"]],
    });
    const r = await k.query({ metrics: [A, "completed_count"], dimensions: ["account", "category"] });
    expect(r.trust).toBe("governed");
    expect(r.rows.find((row) => row.account === "Acme")).toMatchObject({ category: "Hardware", completed_revenue: 100 });
    const compiled = k.compile({ metrics: [A], dimensions: ["account", "category"] }).compiled;
    expect(compiled.guards.map((g) => [g.table, g.keySource])).toEqual([["customers", CONTRIB_CTE], ["products", CONTRIB_CTE]]);
    expect((await refusal(() => k.query({ metrics: [B], dimensions: ["account", "category"] }))).status).toBe("unsafe_query");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. RATIOS
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!available)("ratio populations", () => {
  // completed_over_pending: numerator population {order 1 → cust 1 → Maya},
  // denominator population {order 2 → cust 2 → Ravi}.
  it("A: duplicate reachable only from the numerator refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup")] });
    expect((await refusal(() => k.query({ metrics: ["completed_over_pending"], dimensions: ["account"] }))).status).toBe("unsafe_query");
  });

  it("B: duplicate reachable only from the denominator refuses", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup")] });
    expect((await refusal(() => k.query({ metrics: ["completed_over_pending"], dimensions: ["account"] }))).status).toBe("unsafe_query");
  });

  it("C: duplicate reachable from both refuses even though the ratio would cancel", async () => {
    const both: Row[] = [
      [1, 1, 10, "complete", "2026-01-10", 100, "web"],
      [2, 1, 10, "pending", "2026-01-11", 50, "web"],
    ];
    const k = await scenario({ orders: both, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup")] });
    expect((await refusal(() => k.query({ metrics: ["completed_over_pending"], dimensions: ["account"] }))).status).toBe("unsafe_query");
  });

  it("D: duplicate reachable from neither executes with the exact ratio", async () => {
    const k = await scenario({ orders: ORDERS, customers: [...CUSTOMERS, ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")] });
    const r = await k.query({ metrics: ["completed_over_pending"] , filters: [{ field: "account", operator: "!=", value: "Nobody" }] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.completed_over_pending)).toBe(2);
  });

  it("E/F: multi-hop duplicate reachable from only one component refuses", async () => {
    const numerator = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[0]!, "MayaDup")], regions: REGIONS });
    expect((await refusal(() => numerator.query({ metrics: ["completed_over_pending"], dimensions: ["manager_name"] }))).status).toBe("unsafe_query");
    const denominator = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, dup(MANAGERS[1]!, "RaviDup")], regions: REGIONS });
    expect((await refusal(() => denominator.query({ metrics: ["completed_over_pending"], dimensions: ["manager_name"] }))).status).toBe("unsafe_query");
    const clean = await scenario({ orders: ORDERS, customers: CUSTOMERS, managers: [...MANAGERS, ...GHOST_MANAGER, dup(GHOST_MANAGER[0]!, "GhostDup")], regions: REGIONS });
    const r = await clean.query({ metrics: ["completed_over_pending"], dimensions: ["manager_name"] });
    expect(r.trust).toBe("governed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. SEMI-ADDITIVE + METRIC FILTER + SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════
describe.skipIf(!available)("semi-additive populations", () => {
  // balances(id, customer_id, as_of, balance, kind, book)
  const BALANCES: Row[] = [
    [1, 1, "2026-01-31", 100, "active", "main"],
    [2, 1, "2026-02-28", 110, "active", "main"],
    [3, 2, "2026-01-31", 50, "active", "sub"],
    [4, 2, "2026-02-28", 60, "closed", "sub"],
    [5, 3, "2026-01-31", 30, "active", "main"],
  ];
  const JAN_FEB = { from: "2026-01-01", to: "2026-02-28" };
  const FEB = { from: "2026-02-01", to: "2026-02-28" };

  it("A/B: metric filter applies before the snapshot; the time range bounds the snapshot", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, [3, "Solo", 7]] });
    // Unfiltered: cust 1 → Feb 110, cust 2 → Feb 60, cust 3 → Jan 30.
    expect(n((await k.query({ metrics: ["ending_balance"], time: JAN_FEB })).rows[0]?.ending_balance)).toBe(200);
    // Filtered: cust 2's Feb row is closed, so its snapshot falls back to Jan 50.
    expect(n((await k.query({ metrics: ["active_ending_balance"], time: JAN_FEB })).rows[0]?.active_ending_balance)).toBe(190);
    // Feb only: cust 3 has no Feb row.
    expect(n((await k.query({ metrics: ["ending_balance"], time: FEB })).rows[0]?.ending_balance)).toBe(170);
  });

  it("C: duplicate reachable only from a metric-filter-excluded row executes", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup"), [3, "Solo", 7]] });
    // Feb + active: cust 2's only Feb row is closed → not selected → its duplicate is unreachable.
    const r = await k.query({ metrics: ["active_ending_balance"], dimensions: ["account"], time: FEB });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "account", "active_ending_balance")).toEqual({ Acme: 110 });
    // Unfiltered Feb: cust 2 is selected (closed 60) → refuse.
    expect((await refusal(() => k.query({ metrics: ["ending_balance"], dimensions: ["account"], time: FEB }))).status).toBe("unsafe_query");
  });

  it("D: duplicate reachable only from a snapshot-excluded row executes", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, [3, "Solo", 7], [3, "SoloDup", 7]] });
    const feb = await k.query({ metrics: ["ending_balance"], dimensions: ["account"], time: FEB });
    expect(feb.trust).toBe("governed");
    expect(by(feb.rows, "account", "ending_balance")).toEqual({ Acme: 110, Corp: 60 });
    expect((await refusal(() => k.query({ metrics: ["ending_balance"], dimensions: ["account"], time: JAN_FEB }))).status).toBe("unsafe_query");
  });

  it("E: duplicate reachable from a selected contributing row refuses", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, dup(CUSTOMERS[0]!, "AcmeDup"), [3, "Solo", 7]] });
    expect((await refusal(() => k.query({ metrics: ["active_ending_balance"], dimensions: ["account"], time: FEB }))).status).toBe("unsafe_query");
  });

  it("F/G: multi-hop duplicates follow the selected population", async () => {
    // cust 1 → Maya (7); cust 3 → Ghost (9), and cust 3 is Jan-only.
    const k = await scenario({
      balances: BALANCES,
      customers: [...CUSTOMERS, [3, "Solo", 9]],
      managers: [...MANAGERS, ...GHOST_MANAGER, dup(GHOST_MANAGER[0]!, "GhostDup")],
      regions: REGIONS,
    });
    const feb = await k.query({ metrics: ["ending_balance"], dimensions: ["manager_name"], time: FEB });
    expect(feb.trust).toBe("governed");
    expect(by(feb.rows, "manager_name", "ending_balance")).toEqual({ Maya: 110, Ravi: 60 });
    expect((await refusal(() => k.query({ metrics: ["ending_balance"], dimensions: ["manager_name"], time: JAN_FEB }))).status).toBe("unsafe_query");
    const selected = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, [3, "Solo", 7]], managers: [...MANAGERS, dup(MANAGERS[0]!, "MayaDup")], regions: REGIONS });
    expect((await refusal(() => selected.query({ metrics: ["ending_balance"], dimensions: ["manager_name"], time: FEB }))).status).toBe("unsafe_query");
  });

  it("H/I: grouped snapshot per period and an explicit empty group_by", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, [3, "Solo", 7], ...GHOST_CUSTOMER, dup(GHOST_CUSTOMER[0]!, "GhostDup")] });
    const monthly = await k.query({ metrics: ["ending_balance"], dimensions: ["account"], time: { ...JAN_FEB, grain: "month" } });
    expect(monthly.trust).toBe("governed");
    const month = (r: Record<string, unknown>) => new Date(r.period_month as string | Date).getUTCMonth();
    expect(total(monthly.rows.filter((r) => month(r) === 0), "ending_balance")).toBe(180);
    expect(total(monthly.rows.filter((r) => month(r) === 1), "ending_balance")).toBe(170);
    const global = await k.query({ metrics: ["global_ending_balance"], dimensions: ["account"], time: JAN_FEB });
    expect(global.trust).toBe("governed");
    expect(total(global.rows, "global_ending_balance")).toBe(170);
  });

  it("J: base query filter + metric filter + snapshot compose", async () => {
    const k = await scenario({ balances: BALANCES, customers: [...CUSTOMERS, dup(CUSTOMERS[1]!, "CorpDup"), [3, "Solo", 7]] });
    // book=main removes customer 2 (sub) from the population before the snapshot.
    const r = await k.query({
      metrics: ["active_ending_balance"], dimensions: ["account"], time: JAN_FEB,
      filters: [{ field: "book", operator: "=", value: "main" }],
    });
    expect(r.trust).toBe("governed");
    expect(by(r.rows, "account", "active_ending_balance")).toEqual({ Acme: 110, Solo: 30 });
    expect((await refusal(() => k.query({ metrics: ["active_ending_balance"], dimensions: ["account"], time: JAN_FEB }))).status).toBe("unsafe_query");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. GUARD PROVENANCE — every guard answers what/which/through/from
// ═══════════════════════════════════════════════════════════════════════════
describe("guard provenance", () => {
  it("names the metrics, relationship, path and key source of every guard", async () => {
    const k = await scenario({});
    const { compiled } = k.compile({ metrics: ["completed_over_pending"], dimensions: ["region_name", "category"] });
    expect(compiled.guards.map((g) => ({ table: g.table, path: g.path, keySource: g.keySource, reach: g.reach, protects: g.protects }))).toEqual([
      { table: "customers", path: ["orders_customers"], keySource: CONTRIB_CTE, reach: "__grane_reach_customers", protects: ["completed_over_pending"] },
      { table: "managers", path: ["orders_customers", "customers_managers"], keySource: "__grane_reach_customers", reach: "__grane_reach_managers", protects: ["completed_over_pending"] },
      { table: "regions", path: ["orders_customers", "customers_managers", "managers_regions"], keySource: "__grane_reach_managers", reach: "__grane_reach_regions", protects: ["completed_over_pending"] },
      { table: "products", path: ["orders_products"], keySource: CONTRIB_CTE, reach: "__grane_reach_products", protects: ["completed_over_pending"] },
    ]);
    expect(compiled.plan.population).toEqual({ analytical: POP_CTE, contributing: CONTRIB_CTE });
    // The contributing population is the union of the components' filters.
    expect(compiled.sql).toMatch(/"__grane_contrib" AS \(\n  SELECT \*\n  FROM "__grane_pop" AS "orders"\n  WHERE \("orders"\."status" = \$1\)\n\s+OR \("orders"\."status" = \$2\)/);
    expect(compiled.params.slice(0, 2)).toEqual(["complete", "pending"]);
    // No joins → no populations, plain statement.
    const plain = k.compile({ metrics: ["revenue"] }).compiled;
    expect(plain.guards).toEqual([]);
    expect(plain.plan.population).toEqual({ analytical: null, contributing: null });
    expect(plain.sql).not.toContain("__grane");
  });
});
