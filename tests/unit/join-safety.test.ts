/**
 * Join safety, cardinality and dimension identity.
 *
 * PR #17 established the join *keys*. These tests establish the join
 * *execution* contract: a governed query must not drop unmatched facts,
 * must not multiply facts when a declared one-side key is duplicated in
 * the warehouse, and must not resolve an ambiguous dimension name.
 *
 * Results are executed against DuckDB. Assertions are on the numbers and
 * the trust/refusal, not merely that the SQL contains LEFT JOIN.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mapMetricFlowGraph, type SemanticContribution } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-join-safety");
const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));

const DDL = [
  `CREATE TABLE fct_orders (
     order_id INTEGER, customer_id INTEGER, product_id INTEGER, ordered_at DATE,
     amount DECIMAL(18,2), order_segment VARCHAR, channel VARCHAR)`,
  `INSERT INTO fct_orders VALUES
     (1, 1,    10, '2026-01-01', 100, 'Enterprise', 'web'),
     (2, 2,    10, '2026-01-02',  50, 'Enterprise', 'web'),
     (3, NULL, 11, '2026-01-03',   7, 'Enterprise', 'store'),
     (4, 3,    11, '2026-01-04',  20, 'Enterprise', 'web')`,
  `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
  `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', 10), (3, 'Cog', 'SMB', NULL)`,
  `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
  `INSERT INTO dim_managers VALUES (10, 'Maya')`,
  `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
  `INSERT INTO dim_products VALUES (10, 'Hardware'), (11, 'Software')`,
  `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
  `INSERT INTO dim_tags VALUES (1, 1, 'A'), (2, 1, 'B')`,
  `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
  `INSERT INTO dim_regions VALUES (1, 'EU'), (1, 'US')`,
  `CREATE TABLE fct_mrr_snapshot (
     customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL(18,2), snapshot_segment VARCHAR)`,
  `INSERT INTO fct_mrr_snapshot VALUES
     ('cm1', 1, '2026-01-01',  90, 'Enterprise'),
     ('cm2', 1, '2026-02-01', 110, 'Enterprise'),
     ('cm3', 2, '2026-02-01',  50, 'SMB'),
     ('cm4', 3, '2026-02-01',  20, 'SMB')`,
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
  const path = join(mkdtempSync(join(tmpdir(), "grane-join-safety-")), `${name}.duckdb`);
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
      project: { name: "join-safety", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: c.entities,
      metrics: c.metrics,
      dimensions: c.dimensions,
      relationships: c.relationships,
      unsupported: c.unsupported,
    }),
  );
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

function n(value: unknown): number {
  return Number(value);
}

function population(rows: Record<string, unknown>[], metric: string): number {
  return rows.reduce((sum, row) => sum + n(row[metric] ?? 0), 0);
}

const available = await duckdbAvailable();
const UNGROUPED = 177; // 100 + 50 + 7 + 20

describe("dimension identity at import", () => {
  it("keeps a unique short name and refuses a colliding one, independent of model order", () => {
    expect(contribution.dimensions.account?.sql).toBe("${dim_customers.account}");
    expect(contribution.dimensions.channel?.sql).toBe("${fct_orders.channel}");
    expect(contribution.dimensions.customer_segment).toBeUndefined();
    expect(contribution.dimensions.order__customer_segment?.sql).toBe("${fct_orders.order_segment}");
    expect(contribution.dimensions.customer__customer_segment?.sql).toBe("${dim_customers.segment}");
    expect(contribution.dimensions.customer_month__customer_segment?.sql).toBe("${fct_mrr_snapshot.snapshot_segment}");
    const skipped = contribution.unsupported.find((u) => u.kind === "dimension" && u.name === "customer_segment");
    expect(skipped?.reason).toMatch(/declared by 3 semantic models with different columns/);
    expect(skipped?.reason).toContain('"order__customer_segment"');
    expect(skipped?.reason).toContain('"customer__customer_segment"');

    const reversed = mapMetricFlowGraph({
      ...parseDbtYamlFiles(fixture),
      models: [...parseDbtYamlFiles(fixture).models].reverse(),
    });
    expect(Object.keys(reversed.dimensions).sort()).toEqual(Object.keys(contribution.dimensions).sort());
    expect(reversed.dimensions.order__customer_segment?.sql).toBe(contribution.dimensions.order__customer_segment?.sql);
    expect(reversed.dimensions.customer__customer_segment?.sql).toBe(
      contribution.dimensions.customer__customer_segment?.sql,
    );
    expect(reversed.dimensions.customer_segment).toBeUndefined();
  });

  it("does not import a cross-model metric-definition filter", () => {
    const skipped = contribution.unsupported.find((u) => u.name === "cross_model_enterprise_revenue");
    expect(skipped?.reason).toMatch(/outside semantic model "orders"/);
    expect(contribution.metrics.enterprise_revenue).toBeDefined();
  });
});

describe.skipIf(!available)("join safety matrix", () => {
  let kernel: GraneKernel;
  beforeAll(async () => {
    kernel = kernelFor(await buildWarehouse("js", DDL), contribution);
  });
  afterAll(async () => {
    await kernel?.close();
  });

  it("A: matching dimension row preserves population", async () => {
    const grouped = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    const acme = grouped.rows.find((r) => r.account === "Acme");
    expect(n(acme?.revenue)).toBe(100);
    expect(grouped.trust).toBe("governed");
  });

  it("B/C/D: unmatched foreign keys and NULL keys stay in the population", async () => {
    const ungrouped = await kernel.query({ metrics: ["revenue"] });
    expect(n(ungrouped.rows[0]?.revenue)).toBe(UNGROUPED);
    const grouped = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(grouped.trust).toBe("governed");
    expect(grouped.provenance.generated_sql).toContain("LEFT JOIN");
    expect(grouped.provenance.generated_sql).toContain("__grane_card_dim_customers");
    const byAccount = Object.fromEntries(grouped.rows.map((r) => [String(r.account), n(r.revenue)]));
    expect(byAccount.Acme).toBe(100);
    expect(byAccount.Cog).toBe(20);
    expect(byAccount.null).toBe(57);
    expect(population(grouped.rows, "revenue")).toBe(UNGROUPED);
    expect(Object.keys(grouped.rows[0] ?? {}).some((k) => k.startsWith("__grane_card_"))).toBe(false);
  });

  it("E: duplicate UNIQUE target refuses rather than multiplying facts", async () => {
    const refused = await refusal(() => kernel.query({ metrics: ["revenue", "order_count"], dimensions: ["tag"] }));
    expect(refused.status).toBe("unsafe_query");
    expect(refused.message).toMatch(/dim_tags\.customer_id/);
    expect(refused.message).toMatch(/multiply/);
    expect(refused.message).toMatch(/will not deduplicate/);
  });

  it("F: duplicate PRIMARY target refuses rather than multiplying facts", async () => {
    const refused = await refusal(() => kernel.query({ metrics: ["revenue"], dimensions: ["region"] }));
    expect(refused.status).toBe("unsafe_query");
    expect(refused.message).toMatch(/dim_regions\.customer_id/);
  });

  it("G: multi-hop unmatched at first hop keeps the fact", async () => {
    const grouped = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(grouped.trust).toBe("governed");
    const byName = Object.fromEntries(grouped.rows.map((r) => [String(r.manager_name), n(r.revenue)]));
    expect(byName.Maya).toBe(100);
    // customer 2 unmatched, customer 3 has no manager, NULL customer_id: 50+20+7
    expect(byName.null).toBe(77);
    expect(population(grouped.rows, "revenue")).toBe(UNGROUPED);
    expect(grouped.provenance.generated_sql).toContain("LEFT JOIN");
  });

  it("H: multi-hop unmatched at second hop keeps the fact", async () => {
    const grouped = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(n(grouped.rows.find((r) => r.manager_name === "Cog" || r.account === "Cog")?.revenue ?? 0)).toBe(0);
    const cog = (await kernel.query({ metrics: ["revenue"], dimensions: ["account"] })).rows.find((r) => r.account === "Cog");
    expect(n(cog?.revenue)).toBe(20);
    const byManager = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(n(byManager.rows.find((r) => r.manager_name == null)?.revenue)).toBe(77);
  });

  it("I: equality filter on a joined dimension excludes unmatched facts", async () => {
    const r = await kernel.query({
      metrics: ["revenue"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.revenue)).toBe(100);
    expect(r.provenance.generated_sql).toMatch(/WHERE[\s\S]*"dim_customers"\."account" = /);
  });

  it("J: != filter on a joined dimension also excludes unmatched facts (NULL ≠ x)", async () => {
    const r = await kernel.query({
      metrics: ["revenue"],
      filters: [{ field: "account", operator: "!=", value: "Acme" }],
    });
    expect(n(r.rows[0]?.revenue)).toBe(20);
    const grouped = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "account", operator: "!=", value: "Acme" }],
    });
    expect(grouped.rows).toEqual([{ account: "Cog", revenue: 20 }]);
  });

  it("K: metric-definition filter on a local dimension is applied; cross-model is skipped", async () => {
    const r = await kernel.query({ metrics: ["enterprise_revenue"] });
    expect(n(r.rows[0]?.enterprise_revenue)).toBe(UNGROUPED);
    expect(contribution.metrics.cross_model_enterprise_revenue).toBeUndefined();
  });

  it("L: two joined dimensions from the same fact preserve population", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account", "category"] });
    expect(r.trust).toBe("governed");
    expect(population(r.rows, "revenue")).toBe(UNGROUPED);
    const acmeHw = r.rows.find((row) => row.account === "Acme" && row.category === "Hardware");
    expect(n(acmeHw?.revenue)).toBe(100);
  });

  it("M: two-hop joined dimension", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(n(r.rows.find((row) => row.manager_name === "Maya")?.revenue)).toBe(100);
    expect(population(r.rows, "revenue")).toBe(UNGROUPED);
  });

  it("N: ratio grouped through a relationship", async () => {
    const r = await kernel.query({ metrics: ["revenue_per_order"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.revenue_per_order)).toBe(100);
    expect(n(r.rows.find((row) => row.account === "Cog")?.revenue_per_order)).toBe(20);
    expect(n(r.rows.find((row) => row.account == null)?.revenue_per_order)).toBe(28.5);
  });

  it("O: COUNT(1) grouped through a relationship does not drop unmatched facts", async () => {
    const r = await kernel.query({ metrics: ["order_count"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.order_count)).toBe(1);
    expect(n(r.rows.find((row) => row.account === "Cog")?.order_count)).toBe(1);
    expect(n(r.rows.find((row) => row.account == null)?.order_count)).toBe(2);
    expect(population(r.rows, "order_count")).toBe(4);
  });

  it("P: distinct count grouped through a relationship", async () => {
    const r = await kernel.query({ metrics: ["distinct_customers"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.distinct_customers)).toBe(1);
    expect(n(r.rows.find((row) => row.account === "Cog")?.distinct_customers)).toBe(1);
    // Unmatched: customer 2 plus a NULL key. COUNT DISTINCT ignores NULL.
    expect(n(r.rows.find((row) => row.account == null)?.distinct_customers)).toBe(1);
  });

  it("S: compatible multiple metrics sharing a relationship", async () => {
    const r = await kernel.query({ metrics: ["revenue", "order_count"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(population(r.rows, "revenue")).toBe(UNGROUPED);
    expect(population(r.rows, "order_count")).toBe(4);
  });

  it("T: multiple metrics at different grains refuse", async () => {
    const refused = await refusal(() => kernel.query({ metrics: ["revenue", "ending_mrr"] }));
    expect(refused.status).toBe("invalid_query");
    expect(refused.message).toMatch(/same entity/);
  });
});

describe.skipIf(!available)("semi-additive + join", () => {
  let kernel: GraneKernel;
  beforeAll(async () => {
    kernel = kernelFor(await buildWarehouse("semi", DDL), contribution);
  });
  afterAll(async () => {
    await kernel?.close();
  });

  it("global last snapshot is unchanged by the join work", async () => {
    const r = await kernel.query({ metrics: ["ending_mrr"] });
    expect(n(r.rows[0]?.ending_mrr)).toBe(180);
    expect(r.trust).toBe("governed");
  });

  it("grouped snapshot still keys by the declared entity", async () => {
    const r = await kernel.query({ metrics: ["ending_mrr_by_customer"] });
    expect(n(r.rows[0]?.ending_mrr_by_customer)).toBe(180);
  });

  it("joined grouping after snapshot selection preserves unmatched snapshot rows", async () => {
    const r = await kernel.query({ metrics: ["ending_mrr"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.ending_mrr)).toBe(110);
    expect(n(r.rows.find((row) => row.account === "Cog")?.ending_mrr)).toBe(20);
    expect(n(r.rows.find((row) => row.account == null)?.ending_mrr)).toBe(50);
    expect(population(r.rows, "ending_mrr")).toBe(180);
    expect(r.provenance.generated_sql).toContain("LEFT JOIN");
    expect(r.provenance.generated_sql).toContain('"last_ending_mrr"');
  });

  it("joined query filter applies before snapshot selection", async () => {
    const r = await kernel.query({
      metrics: ["ending_mrr"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    });
    expect(n(r.rows[0]?.ending_mrr)).toBe(110);
    expect(r.provenance.generated_sql).toMatch(/last_ending_mrr[\s\S]*LEFT JOIN "dim_customers"/);
  });

  it("unmatched related dimension rows do not change the global snapshot", async () => {
    const r = await kernel.query({ metrics: ["ending_mrr"], dimensions: ["manager_name"] });
    expect(n(r.rows.find((row) => row.manager_name === "Maya")?.ending_mrr)).toBe(110);
    expect(n(r.rows.find((row) => row.manager_name == null)?.ending_mrr)).toBe(70);
    expect(population(r.rows, "ending_mrr")).toBe(180);
  });

  it("incompatible snapshot metrics still refuse", async () => {
    const refused = await refusal(() => kernel.query({ metrics: ["ending_mrr", "ending_mrr_by_customer"] }));
    expect(refused.status).toBe("unsafe_query");
  });
});

describe.skipIf(!available)("dimension collision matrix", () => {
  let kernel: GraneKernel;
  beforeAll(async () => {
    kernel = kernelFor(await buildWarehouse("dims", DDL), contribution);
  });
  afterAll(async () => {
    await kernel?.close();
  });

  it("1: unique dimension name is governed", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(r.rows.some((row) => row.account === "Acme")).toBe(true);
  });

  it("2/4/8: colliding short name refuses rather than picking a winner", async () => {
    const refused = await refusal(() => kernel.query({ metrics: ["revenue"], dimensions: ["customer_segment"] }));
    expect(refused.status).toBe("undefined_dimension");
    expect(refused.message).toMatch(/did not import it under that name/);
    expect(refused.similar).toEqual(
      expect.arrayContaining(["order__customer_segment", "customer__customer_segment", "customer_month__customer_segment"]),
    );
  });

  it("7: qualified addressing of each colliding meaning is deterministic", async () => {
    const fromOrder = await kernel.query({ metrics: ["revenue"], dimensions: ["order__customer_segment"] });
    expect(fromOrder.trust).toBe("governed");
    expect(fromOrder.rows).toEqual([{ order__customer_segment: "Enterprise", revenue: UNGROUPED }]);
    const fromCustomer = await kernel.query({ metrics: ["revenue"], dimensions: ["customer__customer_segment"] });
    expect(fromCustomer.trust).toBe("governed");
    expect(n(fromCustomer.rows.find((row) => row.customer__customer_segment === "SMB")?.revenue)).toBe(120);
    expect(n(fromCustomer.rows.find((row) => row.customer__customer_segment == null)?.revenue)).toBe(57);
    const fromSnapshot = await kernel.query({
      metrics: ["ending_mrr"],
      dimensions: ["customer_month__customer_segment"],
    });
    expect(n(fromSnapshot.rows.find((row) => row.customer_month__customer_segment === "Enterprise")?.ending_mrr)).toBe(
      110,
    );
    expect(n(fromSnapshot.rows.find((row) => row.customer_month__customer_segment === "SMB")?.ending_mrr)).toBe(70);
  });

  it("9: metric-definition filter uses the local qualified dimension, not a colliding one", async () => {
    const r = await kernel.query({ metrics: ["enterprise_revenue"], dimensions: ["order__customer_segment"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.enterprise_revenue)).toBe(UNGROUPED);
  });

  it("10/11: query-time filter and group-by of the short name refuse", async () => {
    const filtered = await refusal(() =>
      kernel.query({ metrics: ["revenue"], filters: [{ field: "customer_segment", operator: "=", value: "SMB" }] }),
    );
    expect(filtered.status).toBe("undefined_dimension");
    const grouped = await refusal(() => kernel.query({ metrics: ["revenue"], dimensions: ["customer_segment"] }));
    expect(grouped.status).toBe("undefined_dimension");
  });

  it("5: the same physical column declared twice keeps the short name", async () => {
    expect(contribution.dimensions.channel?.sql).toBe("${fct_orders.channel}");
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["channel"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.channel === "web")?.revenue)).toBe(170);
  });

  it("12: a colliding name from another provider is a duplicate, not a silent merge", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-dim-collision-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: duckdb, path: ":memory:" }
providers:
  - type: dbt
    project: ${JSON.stringify(fixture)}
dimensions:
  account:
    entity: customer
    sql: \${somewhere.else}
`,
    );
    expect(() => loadConfig(dir)).toThrow(GraneError);
    try {
      loadConfig(dir);
    } catch (err) {
      expect((err as GraneError).refusal.message).toMatch(/Duplicate dimension "account"/);
    }
  });
});
