/**
 * Relationship fidelity of the dbt/MetricFlow import.
 *
 * MetricFlow joins two semantic models on an entity that both declare by
 * name; the right side must declare it as primary or unique. Semantic model
 * names, table names and key names play no part. An adversarial review found
 * Grane joining `orders.customer_id` to a model's surrogate primary key merely
 * because that model was *named* `customer` — a wrong answer with
 * trust=governed. These tests execute the compiled SQL against DuckDB with
 * hand-computed answers so every imported relationship is proven end to end,
 * and every relationship Grane refuses is proven to stay refused at query time.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mapMetricFlowGraph, type SemanticContribution } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-relationships");
const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));

const DDL = [
  `CREATE TABLE fct_orders (order_id INTEGER, customer_id VARCHAR, product_id INTEGER, warehouse_id VARCHAR,
     region_id VARCHAR, supplier_id VARCHAR, promo_code VARCHAR, coupon_code VARCHAR, ordered_at DATE,
     channel VARCHAR, amount DECIMAL(18,2))`,
  `INSERT INTO fct_orders VALUES
     (1,'c1',1,'w1','r1','s1','PROMO','save10','2026-07-01','web',  100),
     (2,'c2',2,'w1','r2','s2',NULL,   'save20','2026-07-02','store', 50),
     (3,'c1',2,'w2','r1','s1',NULL,   'save10','2026-07-03','web',   25),
     (4,'c3',1,'w2','r2','s2',NULL,   NULL,    '2026-07-04','web',   10)`,
  `CREATE TABLE dim_customers (customer_id VARCHAR, customer_name VARCHAR, segment VARCHAR, manager_id VARCHAR)`,
  `INSERT INTO dim_customers VALUES ('c1','Acme','Enterprise','m1'), ('c2','Bolt','SMB','m2'), ('c3','Cog','SMB','m1')`,
  `CREATE TABLE dim_managers (manager_id VARCHAR, manager_name VARCHAR)`,
  `INSERT INTO dim_managers VALUES ('m1','Maya'), ('m2','Noah')`,
  // Surrogate row ids deliberately collide with product ids so a join on the wrong key yields wrong names.
  `CREATE TABLE dim_product_rows (product_row_id INTEGER, product_id INTEGER, product_name VARCHAR)`,
  `INSERT INTO dim_product_rows VALUES (1, 2, 'Widget'), (2, 1, 'Gadget')`,
  `CREATE TABLE warehouse (site_id VARCHAR, site_name VARCHAR)`,
  `INSERT INTO warehouse VALUES ('w1','North'), ('w2','South')`,
  `CREATE TABLE dim_regions (region_id VARCHAR, region_name VARCHAR)`,
  `INSERT INTO dim_regions VALUES ('r1','EU'), ('r2','US')`,
  `CREATE TABLE dim_region_targets (region_id VARCHAR, region_manager VARCHAR)`,
  `INSERT INTO dim_region_targets VALUES ('r1','Rita'), ('r2','Uma')`,
  `CREATE TABLE dim_vendors (vendor_id VARCHAR, vendor_name VARCHAR)`,
  `INSERT INTO dim_vendors VALUES ('s1','VendorOne'), ('s2','VendorTwo')`,
  `CREATE TABLE dim_coupons (coupon_row_id INTEGER, code VARCHAR, coupon_kind VARCHAR)`,
  `INSERT INTO dim_coupons VALUES (1,'SAVE10','percent'), (2,'SAVE20','percent')`,
  `CREATE TABLE dim_customer_profiles (profile_id INTEGER, customer_id VARCHAR, industry VARCHAR)`,
  `INSERT INTO dim_customer_profiles VALUES (1,'c1','Manufacturing'), (2,'c2','Retail'), (3,'c3','Manufacturing')`,
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

async function buildWarehouse(name: string, ddl: string[]): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-relationships-")), `${name}.duckdb`);
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const statement of ddl) await conn.run(statement);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

function kernelFor(path: string, c: SemanticContribution): GraneKernel {
  return new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "relationships", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: c.entities,
      metrics: c.metrics,
      dimensions: c.dimensions,
      relationships: c.relationships,
      unsupported: c.unsupported,
    }),
  );
}

function relationshipReason(name: string): string | undefined {
  return contribution.unsupported.find((u) => u.kind === "relationship" && u.name === name)?.reason;
}

function relationshipsFrom(table: string) {
  return Object.values(contribution.relationships).filter((r) => r.from.startsWith(`${table}.`));
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

const available = await duckdbAvailable();
const JUL = { from: "2026-07-01", to: "2026-07-31" };

describe("dbt relationships: what is imported", () => {
  it("imports exactly the joins MetricFlow would allow, nothing inferred from names", () => {
    expect(contribution.relationships).toEqual({
      fct_orders_to_dim_customers: expect.objectContaining({
        from: "fct_orders.customer_id",
        to: "dim_customers.customer_id",
        type: "many_to_one",
      }),
      fct_orders_to_dim_product_rows: expect.objectContaining({
        from: "fct_orders.product_id",
        to: "dim_product_rows.product_id",
        type: "many_to_one",
      }),
      fct_orders_to_dim_regions: expect.objectContaining({
        from: "fct_orders.region_id",
        to: "dim_regions.region_id",
        type: "many_to_one",
      }),
      fct_orders_to_dim_region_targets: expect.objectContaining({
        from: "fct_orders.region_id",
        to: "dim_region_targets.region_id",
        type: "many_to_one",
      }),
      fct_orders_to_dim_customer_profiles: expect.objectContaining({
        from: "fct_orders.customer_id",
        to: "dim_customer_profiles.customer_id",
        type: "many_to_one",
      }),
      dim_customers_to_dim_managers: expect.objectContaining({
        from: "dim_customers.manager_id",
        to: "dim_managers.manager_id",
        type: "many_to_one",
      }),
    });
  });

  it("case 3/8: a model named after the entity joins on its declared unique entity, never its surrogate primary key", () => {
    const rel = contribution.relationships.fct_orders_to_dim_product_rows!;
    expect(rel.to).toBe("dim_product_rows.product_id");
    expect(JSON.stringify(contribution.relationships)).not.toContain("product_row_id");
  });

  it("case 4: a table named like the entity is not a join target", () => {
    expect(Object.values(contribution.relationships).some((r) => r.to.startsWith("warehouse."))).toBe(false);
    expect(relationshipReason("orders.warehouse")).toMatch(/no other semantic model declares entity "warehouse"/);
    expect(relationshipReason("orders.warehouse")).toMatch(/"sites" is only named like it, which is not a join key/);
  });

  it("case 6: a model named like the entity is not a join target; an undeclared entity is reported", () => {
    expect(Object.values(contribution.relationships).some((r) => r.to.startsWith("dim_vendors."))).toBe(false);
    expect(relationshipReason("orders.supplier")).toMatch(/"supplier" is only named like it, which is not a join key/);
    expect(relationshipReason("orders.promo")).toBe('no other semantic model declares entity "promo".');
  });

  it("case 7: a target whose entity is a SQL expression is refused with the expression named", () => {
    expect(Object.values(contribution.relationships).some((r) => r.to.startsWith("dim_coupons."))).toBe(false);
    expect(relationshipReason("orders.coupon")).toMatch(/"coupons" declares it with a SQL expression \("UPPER\(code\)"\)/);
  });

  it("one-to-one joins between primary/unique entities are recorded as unsupported, not guessed", () => {
    expect(
      Object.values(contribution.relationships).some(
        (r) => r.from.startsWith("dim_customer_profiles.") || r.to.startsWith("dim_customer_profiles.customer_id") && r.from.startsWith("dim_customers."),
      ),
    ).toBe(false);
    expect(relationshipReason("customer_profiles.customer")).toMatch(/one-to-one joins between primary\/unique entities are not imported/);
  });

  it("case 9: several foreign entities on one model each resolve independently", () => {
    expect(relationshipsFrom("fct_orders").map((r) => r.to).sort()).toEqual([
      "dim_customer_profiles.customer_id",
      "dim_customers.customer_id",
      "dim_product_rows.product_id",
      "dim_region_targets.region_id",
      "dim_regions.region_id",
    ]);
  });
});

describe.skipIf(!available)("dbt relationships: executed joins", () => {
  let kernel: GraneKernel;
  beforeAll(async () => {
    kernel = kernelFor(await buildWarehouse("orders", DDL), contribution);
  });
  afterAll(async () => {
    await kernel?.close();
  });

  it("case 1: foreign -> primary joins on the declared primary column", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["customer_name"], time: JUL });
    expect(r.trust).toBe("governed");
    expect(r.rows).toEqual([
      { customer_name: "Acme", revenue: 125 },
      { customer_name: "Bolt", revenue: 50 },
      { customer_name: "Cog", revenue: 10 },
    ]);
    expect(r.provenance.generated_sql).toContain(
      'JOIN "dim_customers" ON "fct_orders"."customer_id" = "dim_customers"."customer_id"',
    );
  });

  it("case 2/3/8/11: foreign -> unique on a namesake model joins the natural key (dimension-only target)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["product_name"], time: JUL });
    expect(r.trust).toBe("governed");
    expect(r.rows).toEqual([
      { product_name: "Gadget", revenue: 110 },
      { product_name: "Widget", revenue: 75 },
    ]);
    expect(r.provenance.generated_sql).toContain(
      'JOIN "dim_product_rows" ON "fct_orders"."product_id" = "dim_product_rows"."product_id"',
    );
    expect(r.provenance.generated_sql).not.toContain("product_row_id");
  });

  it("foreign -> unique with a surrogate primary key elsewhere on the target", async () => {
    const r = await kernel.query({ metrics: ["order_count"], dimensions: ["industry"], time: JUL });
    expect(r.trust).toBe("governed");
    expect(r.rows).toEqual([
      { industry: "Manufacturing", order_count: 3n },
      { industry: "Retail", order_count: 1n },
    ]);
    expect(r.provenance.generated_sql).toContain(
      'JOIN "dim_customer_profiles" ON "fct_orders"."customer_id" = "dim_customer_profiles"."customer_id"',
    );
    expect(r.provenance.generated_sql).not.toContain("profile_id");
  });

  it("case 4: a dimension on a table merely named like the entity is unreachable", async () => {
    const refused = await refusalAsync(() => kernel.query({ metrics: ["revenue"], dimensions: ["site_name"], time: JUL }));
    expect(refused.status).toBe("invalid_query");
    expect(refused.message).toMatch(/"site_name" \(warehouse\.site_name\) is not reachable from "fct_orders"/);
  });

  it("case 5: two models declaring the same entity are both explicit targets; neither is guessed", async () => {
    const byName = await kernel.query({ metrics: ["revenue"], dimensions: ["region_name"], time: JUL });
    expect(byName.rows).toEqual([
      { region_name: "EU", revenue: 125 },
      { region_name: "US", revenue: 60 },
    ]);
    expect(byName.provenance.generated_sql).toContain('"fct_orders"."region_id" = "dim_regions"."region_id"');
    const byManager = await kernel.query({ metrics: ["revenue"], dimensions: ["region_manager"], time: JUL });
    expect(byManager.rows).toEqual([
      { region_manager: "Rita", revenue: 125 },
      { region_manager: "Uma", revenue: 60 },
    ]);
    expect(byManager.provenance.generated_sql).toContain('"fct_orders"."region_id" = "dim_region_targets"."region_id"');
    expect(byManager.provenance.generated_sql).not.toContain('"dim_regions"');
  });

  it("case 6: dimensions on a model merely named like the entity are unreachable", async () => {
    const refused = await refusalAsync(() => kernel.query({ metrics: ["revenue"], dimensions: ["vendor_name"], time: JUL }));
    expect(refused.status).toBe("invalid_query");
    expect(refused.message).toMatch(/"vendor_name" \(dim_vendors\.vendor_name\) is not reachable from "fct_orders"/);
  });

  it("case 7: dimensions behind an expression-keyed entity are unreachable", async () => {
    const refused = await refusalAsync(() => kernel.query({ metrics: ["revenue"], dimensions: ["coupon_kind"], time: JUL }));
    expect(refused.status).toBe("invalid_query");
    expect(refused.message).toMatch(/"coupon_kind" \(dim_coupons\.coupon_kind\) is not reachable from "fct_orders"/);
  });

  it("case 10: two explicit hops across three semantic models", async () => {
    const r = await kernel.query({ metrics: ["revenue", "order_count"], dimensions: ["manager_name"], time: JUL });
    expect(r.trust).toBe("governed");
    expect(r.rows).toEqual([
      { manager_name: "Maya", revenue: 135, order_count: 3n },
      { manager_name: "Noah", revenue: 50, order_count: 1n },
    ]);
    expect(r.provenance.generated_sql).toContain('"fct_orders"."customer_id" = "dim_customers"."customer_id"');
    expect(r.provenance.generated_sql).toContain('"dim_customers"."manager_id" = "dim_managers"."manager_id"');
  });

  it("case 12: the join carries metric filters and query filters", async () => {
    const filteredMetric = await kernel.query({ metrics: ["web_revenue"], dimensions: ["customer_name"], time: JUL });
    expect(filteredMetric.rows).toEqual([
      { customer_name: "Acme", web_revenue: 125 },
      { customer_name: "Cog", web_revenue: 10 },
      { customer_name: "Bolt", web_revenue: null },
    ]);
    const eq = await kernel.query({ metrics: ["revenue"], filters: [{ field: "segment", operator: "=", value: "SMB" }], time: JUL });
    expect(eq.rows).toEqual([{ revenue: 60 }]);
    const ne = await kernel.query({ metrics: ["revenue"], filters: [{ field: "segment", operator: "!=", value: "SMB" }], time: JUL });
    expect(ne.rows).toEqual([{ revenue: 125 }]);
    expect(ne.provenance.generated_sql).toContain('"dim_customers"."segment" <> ');
  });
});

/**
 * The independent T14/T14b case, verbatim: a semantic model NAMED `customer`
 * with a surrogate primary entity `row` and a unique entity `customer`. Before
 * the fix Grane joined `orders.customer_id` to `dim_row.row_id` and answered
 * `WrongAccount, 100` with trust=governed.
 */
describe.skipIf(!available)("T14: join target guessed from semantic model name", () => {
  const T14_YAML = `
version: 2
semantic_models:
  - name: orders
    model: ref('fct_orders')
    defaults:
      agg_time_dimension: ordered_at
    entities:
      - name: order
        type: primary
        expr: order_id
      - name: customer
        type: foreign
        expr: customer_id
    dimensions:
      - name: ordered_at
        type: time
        expr: ordered_at
        type_params:
          time_granularity: day
    measures:
      - name: revenue
        agg: sum
        expr: amount
        create_metric: true
  - name: customer
    model: ref('dim_row')
    entities:
      - name: row
        type: primary
        expr: row_id
      - name: customer
        type: unique
        expr: customer_id
    dimensions:
      - name: account_name
        type: categorical
        expr: account_name
`;
  const T14_DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL(18,2))`,
    `INSERT INTO fct_orders VALUES (1, 7, '2026-01-01', 100)`,
    `CREATE TABLE dim_row (row_id INTEGER, customer_id INTEGER, account_name VARCHAR)`,
    `INSERT INTO dim_row VALUES (7, 99, 'WrongAccount'), (42, 7, 'Acme')`,
  ];

  it("joins on the unique entity `customer`, not the primary key of the model named `customer`", async () => {
    const project = mkdtempSync(join(tmpdir(), "grane-t14-"));
    mkdirSync(join(project, "models"));
    writeFileSync(join(project, "dbt_project.yml"), "name: t14\nversion: '1.0.0'\nprofile: t14\nmodel-paths: ['models']\n");
    writeFileSync(join(project, "models", "schema.yml"), T14_YAML);
    const c = mapMetricFlowGraph(parseDbtYamlFiles(project));
    expect(c.relationships).toEqual({
      fct_orders_to_dim_row: expect.objectContaining({
        from: "fct_orders.customer_id",
        to: "dim_row.customer_id",
        type: "many_to_one",
      }),
    });

    const kernel = kernelFor(await buildWarehouse("t14", T14_DDL), c);
    try {
      const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account_name"] });
      expect(r.trust).toBe("governed");
      expect(r.rows).toEqual([{ account_name: "Acme", revenue: 100 }]);
      expect(r.provenance.generated_sql).toContain('JOIN "dim_row" ON "fct_orders"."customer_id" = "dim_row"."customer_id"');
      expect(r.provenance.generated_sql).not.toContain("row_id");
    } finally {
      await kernel.close();
    }
  });
});
