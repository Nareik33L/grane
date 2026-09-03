/**
 * Cardinality guards inside pre-aggregation CTEs.
 *
 * orders --1:N--> order_items --N:1--> products [--N:1--> categories]
 *
 * A declared many_to_one hop taken while collapsing the child grain is still
 * a participating relationship. Duplicates that contributing rows reach must
 * refuse; unreachable duplicates must not.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { GUARD_PREFIX } from "../../src/compile/compiler.js";

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

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

type Rows = Record<string, Array<Array<string | number | null>>>;

function lit(v: string | number | null): string {
  if (v === null) return "NULL";
  if (typeof v === "number") return String(v);
  return `'${v.replace(/'/g, "''")}'`;
}

async function scenario(data: Rows): Promise<GraneKernel> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-preagg-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  const ddl: Record<string, string> = {
    orders: `CREATE TABLE orders (id INTEGER, customer_id INTEGER, amount NUMERIC, ordered_at DATE, status VARCHAR)`,
    order_items: `CREATE TABLE order_items (id INTEGER, order_id INTEGER, product_id INTEGER, sku VARCHAR)`,
    products: `CREATE TABLE products (product_id INTEGER, weight_kg NUMERIC, category_id INTEGER)`,
    categories: `CREATE TABLE categories (id INTEGER, name VARCHAR, score NUMERIC)`,
    customers: `CREATE TABLE customers (id INTEGER, country VARCHAR)`,
  };
  for (const [table, create] of Object.entries(ddl)) {
    await conn.run(create);
    const rows = data[table] ?? [];
    if (rows.length > 0) {
      await conn.run(`INSERT INTO ${table} VALUES ${rows.map((r) => `(${r.map(lit).join(", ")})`).join(", ")}`);
    }
  }
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const k = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "preagg", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: {
        order: { table: "orders", primary_key: "id" },
        item: { table: "order_items", primary_key: "id" },
        product: { table: "products", primary_key: "product_id" },
        category: { table: "categories", primary_key: "id" },
        customer: { table: "customers", primary_key: "id" },
      },
      metrics: {
        order_weight: { entity: "order", type: "sum", sql: "${products.weight_kg}", time_dimension: "${orders.ordered_at}" },
        sku_a_weight: {
          entity: "order", type: "sum", sql: "${products.weight_kg}", time_dimension: "${orders.ordered_at}",
          filters: { "order_items.sku": "A" },
        },
        category_score: { entity: "order", type: "sum", sql: "${categories.score}", time_dimension: "${orders.ordered_at}" },
        revenue: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        orders: { entity: "order", type: "count", time_dimension: "${orders.ordered_at}" },
        weight_per_order: { entity: "order", type: "ratio", numerator: "order_weight", denominator: "orders" },
        weight_over_weight: { entity: "order", type: "ratio", numerator: "order_weight", denominator: "order_weight" },
      },
      dimensions: {
        country: { entity: "customer", sql: "${customers.country}" },
        status: { entity: "order", sql: "${orders.status}" },
      },
      relationships: {
        items_orders: { from: "order_items.order_id", to: "orders.id", type: "many_to_one" },
        items_products: { from: "order_items.product_id", to: "products.product_id", type: "many_to_one" },
        products_categories: { from: "products.category_id", to: "categories.id", type: "many_to_one" },
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    }),
  );
  kernels.push(k);
  return k;
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

const SAFE: Rows = {
  orders: [
    [1, 1, 10, "2026-08-01", "open"],
    [2, 2, 20, "2026-07-01", "open"],
  ],
  order_items: [
    [1, 1, 10, "A"],
    [2, 1, 20, "B"],
    [3, 2, 20, "A"],
  ],
  products: [
    [10, 10, 1],
    [20, 21, 1],
  ],
  categories: [[1, "heavy", 5]],
  customers: [
    [1, "US"],
    [2, "DE"],
  ],
};

describe.skipIf(!available)("pre-aggregation relationship cardinality (B1–B15)", () => {
  it("B1: participating duplicate at the pre-aggregation hop refuses (not 41)", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [10, 10, 1],
        [20, 21, 1],
      ],
    });
    const compiled = k.compile({ metrics: ["order_weight"] }).compiled;
    expect(compiled.sql).toContain("LEFT JOIN");
    expect(compiled.sql).toMatch(/__grane_card_pre_order_weight_products/);
    expect(compiled.guards.some((g) => g.scope === "preagg" && g.table === "products")).toBe(true);
    expect(compiled.guards.find((g) => g.scope === "preagg")!.path).toEqual(["items_orders", "items_products"]);
    const r = await refusal(() => k.query({ metrics: ["order_weight"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/items_products|products\.product_id/);
    expect(r.message).not.toMatch(/41|deduplicat|DISTINCT/i);
  });

  it("B2: unreachable product duplicate does not poison the query (31)", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [20, 21, 1],
        [99, 8, 1],
        [99, 8, 1],
      ],
    });
    const result = await k.query({ metrics: ["order_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(31);
  });

  it("B3: NULL foreign key does not drop the sibling item", async () => {
    const k = await scenario({
      orders: [[1, 1, 10, "2026-08-01", "open"]],
      order_items: [
        [1, 1, 10, "A"],
        [2, 1, null, "B"],
      ],
      products: [[10, 10, 1]],
      categories: [[1, "heavy", 5]],
      customers: [[1, "US"]],
    });
    const sql = k.compile({ metrics: ["order_weight"] }).compiled.sql;
    expect(sql).toContain(`LEFT JOIN "products"`);
    expect(sql).not.toMatch(/^\s+JOIN "products"/m);
    const result = await k.query({ metrics: ["order_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(10);
  });

  it("B4: unmatched foreign key keeps the matched sibling", async () => {
    const k = await scenario({
      orders: [[1, 1, 10, "2026-08-01", "open"]],
      order_items: [
        [1, 1, 10, "A"],
        [2, 1, 88, "B"],
      ],
      products: [[10, 10, 1]],
      categories: [[1, "heavy", 5]],
      customers: [[1, "US"]],
    });
    const result = await k.query({ metrics: ["order_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(10);
  });

  it("B5: participating duplicate at hop 2 refuses", async () => {
    const k = await scenario({
      ...SAFE,
      categories: [
        [1, "heavy", 5],
        [1, "heavy-dup", 5],
      ],
    });
    const compiled = k.compile({ metrics: ["category_score"] }).compiled;
    expect(compiled.guards.filter((g) => g.scope === "preagg").map((g) => g.table)).toEqual([
      "products",
      "categories",
    ]);
    const r = await refusal(() => k.query({ metrics: ["category_score"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/categories/);
  });

  it("B6: unreachable hop-2 duplicate does not refuse", async () => {
    const k = await scenario({
      ...SAFE,
      categories: [
        [1, "heavy", 5],
        [9, "ghost", 1],
        [9, "ghost-dup", 1],
      ],
    });
    const result = await k.query({ metrics: ["category_score"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.category_score)).toBe(15);
  });

  it("B7: metric filter that excludes the duplicate-reaching item is governed", async () => {
    const k = await scenario({
      orders: [[1, 1, 10, "2026-08-01", "open"]],
      order_items: [
        [1, 1, 10, "A"],
        [2, 1, 20, "B"],
      ],
      products: [
        [10, 10, 1],
        [20, 21, 1],
        [20, 21, 1],
      ],
      categories: [[1, "heavy", 5]],
      customers: [[1, "US"]],
    });
    const compiled = k.compile({ metrics: ["sku_a_weight"] }).compiled;
    expect(compiled.guards.some((g) => g.scope === "preagg")).toBe(true);
    const result = await k.query({ metrics: ["sku_a_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.sku_a_weight)).toBe(10);
  });

  it("B8: base query filter that excludes the duplicate-reaching order is governed", async () => {
    const k2 = await scenario({
      orders: [
        [1, 1, 10, "2026-08-01", "keep"],
        [2, 2, 20, "2026-07-01", "drop"],
      ],
      order_items: [
        [1, 1, 10, "A"],
        [2, 2, 20, "B"],
      ],
      products: [
        [10, 10, 1],
        [20, 21, 1],
        [20, 21, 1],
      ],
      categories: [[1, "heavy", 5]],
      customers: [
        [1, "US"],
        [2, "DE"],
      ],
    });
    const result = await k2.query({
      metrics: ["order_weight"],
      filters: [{ field: "status", operator: "=", value: "keep" }],
    });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(10);
  });

  it("B9: time filter that excludes the duplicate-reaching order is governed", async () => {
    const k = await scenario({
      orders: [
        [1, 1, 10, "2026-08-01", "open"],
        [2, 2, 20, "2026-07-01", "open"],
      ],
      order_items: [
        [1, 1, 10, "A"],
        [2, 2, 20, "B"],
      ],
      products: [
        [10, 10, 1],
        [20, 21, 1],
        [20, 21, 1],
      ],
      categories: [[1, "heavy", 5]],
      customers: [
        [1, "US"],
        [2, "DE"],
      ],
    });
    const result = await k.query({
      metrics: ["order_weight"],
      time: { from: "2026-08-01", to: "2026-08-31" },
    });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(10);
  });

  it("B10: two metrics, only one traverses pre-aggregation — still refuses", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [10, 10, 1],
        [20, 21, 1],
      ],
    });
    const compiled = k.compile({ metrics: ["revenue", "order_weight"] }).compiled;
    expect(compiled.guards.some((g) => g.scope === "preagg" && g.protects.includes("order_weight"))).toBe(true);
    const r = await refusal(() => k.query({ metrics: ["revenue", "order_weight"] }));
    expect(r.status).toBe("unsafe_query");
  });

  it("B11: ratio component that traverses pre-aggregation refuses", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [10, 10, 1],
        [20, 21, 1],
      ],
    });
    const r = await refusal(() => k.query({ metrics: ["weight_per_order"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/order_weight|weight_per_order|products/);
  });

  it("B12: top-level join and pre-aggregation traversal in the same query", async () => {
    const k = await scenario(SAFE);
    const compiled = k.compile({ metrics: ["order_weight"], dimensions: ["country"] }).compiled;
    expect(compiled.guards.some((g) => g.scope === "join" && g.table === "customers")).toBe(true);
    expect(compiled.guards.some((g) => g.scope === "preagg" && g.table === "products")).toBe(true);
    const result = await k.query({ metrics: ["order_weight"], dimensions: ["country"] });
    expect(result.trust).toBe("governed");
    const by = Object.fromEntries(result.rows.map((r) => [String(r.country), Number(r.order_weight)]));
    expect(by).toEqual({ US: 31, DE: 21 });
  });

  it("B13: a duplicate that would numerically cancel in a ratio still refuses", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [10, 10, 1],
        [20, 21, 1],
      ],
    });
    const r = await refusal(() => k.query({ metrics: ["weight_over_weight"] }));
    expect(r.status).toBe("unsafe_query");
  });

  it("B14: empty contributing population is governed-safe", async () => {
    const k = await scenario({
      ...SAFE,
      products: [
        [10, 10, 1],
        [10, 10, 1],
        [20, 21, 1],
      ],
    });
    const result = await k.query({
      metrics: ["order_weight"],
      time: { from: "2020-01-01", to: "2020-01-31" },
    });
    expect(result.trust).toBe("governed");
    const value = result.rows[0]?.order_weight;
    expect(value === null || Number(value) === 0).toBe(true);
  });

  it("B15: generated SQL uses LEFT JOIN and a pre-agg guard column the executor reads", async () => {
    const k = await scenario(SAFE);
    const compiled = k.compile({ metrics: ["order_weight"] }).compiled;
    expect(compiled.sql).toContain(`LEFT JOIN "products"`);
    expect(compiled.sql).toContain(`${GUARD_PREFIX}pre_order_weight_products`);
    expect(compiled.plan.preAggregations[0]?.metric).toBe("order_weight");
    const result = await k.query({ metrics: ["order_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.order_weight)).toBe(31);
  });
});
