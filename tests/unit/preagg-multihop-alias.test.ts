/**
 * Unique multi-hop pre-aggregation must emit reach/cardinality CTEs whose
 * aliases match the hop currently in scope. Parent (post-#37) compiled a
 * 3-hop path as `FROM reach_hop_mid AS hop_sku` and DuckDB failed with
 * `Referenced table "hop_sku" not found`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { graneConfigSchema, type GraneConfig } from "../../src/config/schema.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { dualFanoutConfig, uniqueFanoutConfig } from "../helpers/path-null-fixtures.js";
import { nullFilterConfig } from "../helpers/path-null-fixtures.js";
import {
  ensureReadonlyRole,
  grantReadonlyOnSchema,
  newCertSchema,
  postgresLiveEnv,
} from "../helpers/postgres-live.js";

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
const duckOk = await duckdbAvailable();
const pgEnv = await postgresLiveEnv();

const HOP_DDL = [
  `CREATE TABLE orders (id INTEGER PRIMARY KEY, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
  `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7), (2, 'hold', DATE '2026-08-02', 8)`,
  `CREATE TABLE regions (rid INTEGER PRIMARY KEY, name VARCHAR)`,
  `INSERT INTO regions VALUES (7, 'west'), (8, 'east')`,
  `CREATE TABLE notes (note_id INTEGER PRIMARY KEY, order_id INTEGER, body VARCHAR)`,
  `INSERT INTO notes VALUES (1, 1, 'unrelated_child')`,
  `CREATE TABLE hop_mid (mid_pk INTEGER PRIMARY KEY, order_ref INTEGER, mid_qty DOUBLE PRECISION)`,
  `INSERT INTO hop_mid VALUES (1, 1, 4), (2, 1, 2.5)`,
  `CREATE TABLE hop_sku (sku_row INTEGER PRIMARY KEY, mid_fk INTEGER, sku_ref INTEGER)`,
  `INSERT INTO hop_sku VALUES (1, 1, 10), (2, 1, 20)`,
  `CREATE TABLE skus (sku_pk INTEGER PRIMARY KEY, grams DOUBLE PRECISION)`,
  `INSERT INTO skus VALUES (10, 1.5), (20, 5.0)`,
  `CREATE TABLE lines (line_id INTEGER PRIMARY KEY, order_fk INTEGER, weight_fk INTEGER)`,
  `INSERT INTO lines VALUES (1, 1, 10), (2, 1, 20)`,
  `CREATE TABLE weights (weight_pk INTEGER PRIMARY KEY, grams DOUBLE PRECISION)`,
  `INSERT INTO weights VALUES (10, 1.5), (20, 5.0)`,
  `CREATE TABLE hop_a (a_id INTEGER PRIMARY KEY, order_fk INTEGER)`,
  `INSERT INTO hop_a VALUES (1, 1)`,
  `CREATE TABLE hop_b (b_id INTEGER PRIMARY KEY, a_fk INTEGER)`,
  `INSERT INTO hop_b VALUES (1, 1)`,
  `CREATE TABLE hop_c (c_id INTEGER PRIMARY KEY, b_fk INTEGER, fact_fk INTEGER)`,
  `INSERT INTO hop_c VALUES (1, 1, 7)`,
  `CREATE TABLE facts (fact_id INTEGER PRIMARY KEY, grams DOUBLE PRECISION)`,
  `INSERT INTO facts VALUES (7, 6.5)`,
  `CREATE TABLE extras (extra_id INTEGER PRIMARY KEY, note VARCHAR)`,
  `INSERT INTO extras VALUES (1, 'unrelated')`,
];

const NULL_DDL = [
  `CREATE TABLE facts_n (id INTEGER PRIMARY KEY, status VARCHAR, amount DOUBLE PRECISION, label VARCHAR)`,
  `INSERT INTO facts_n VALUES (1, 'ok', 10, 'abc'), (2, NULL, 11, NULL), (3, 'bad', 100, 'x%y'), (4, 'ok', NULL, 'z')`,
];

function hopConfig(connection: Record<string, unknown>, relOrder: "forward" | "reversed" = "forward"): GraneConfig {
  const rels = {
    mid_to_orders: { from: "hop_mid.order_ref", to: "orders.id", type: "many_to_one" as const },
    sku_to_mid: { from: "hop_sku.mid_fk", to: "hop_mid.mid_pk", type: "many_to_one" as const },
    sku_to_skus: { from: "hop_sku.sku_ref", to: "skus.sku_pk", type: "many_to_one" as const },
    notes_to_orders: { from: "notes.order_id", to: "orders.id", type: "many_to_one" as const },
    orders_to_regions: { from: "orders.region_id", to: "regions.rid", type: "many_to_one" as const },
    lines_to_orders: { from: "lines.order_fk", to: "orders.id", type: "many_to_one" as const },
    lines_to_weights: { from: "lines.weight_fk", to: "weights.weight_pk", type: "many_to_one" as const },
    a_to_orders: { from: "hop_a.order_fk", to: "orders.id", type: "many_to_one" as const },
    b_to_a: { from: "hop_b.a_fk", to: "hop_a.a_id", type: "many_to_one" as const },
    c_to_b: { from: "hop_c.b_fk", to: "hop_b.b_id", type: "many_to_one" as const },
    c_to_facts: { from: "hop_c.fact_fk", to: "facts.fact_id", type: "many_to_one" as const },
  };
  const relationships = relOrder === "forward" ? rels : Object.fromEntries(Object.entries(rels).reverse());
  return graneConfigSchema.parse({
    project: { name: "multihop", timezone: "UTC" },
    connection,
    entities: { order: { table: "orders", primary_key: "id" } },
    metrics: {
      mid_qty: { entity: "order", type: "sum", sql: "${hop_mid.mid_qty}" },
      line_grams: { entity: "order", type: "sum", sql: "${weights.grams}" },
      sku_grams: { entity: "order", type: "sum", sql: "${skus.grams}", time_dimension: "${orders.ordered_at}" },
      four_grams: { entity: "order", type: "sum", sql: "${facts.grams}" },
      order_count: { entity: "order", type: "count", sql: "${orders.id}" },
      grams_per_order: { entity: "order", type: "ratio", numerator: "sku_grams", denominator: "order_count" },
      open_sku_grams: {
        entity: "order",
        type: "sum",
        sql: "${skus.grams}",
        filters: { "orders.status": "open" },
      },
    },
    dimensions: {
      status: { entity: "order", sql: "${orders.status}" },
      region: { entity: "order", sql: "${regions.name}" },
    },
    relationships,
  });
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a Grane refusal");
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a Grane refusal");
}

function expectReachAliasesAligned(sql: string) {
  expect(sql).not.toMatch(/__grane_reach_pre_\w+_hop_mid" AS "hop_sku"/);
  expect(sql).not.toMatch(/Referenced table/);
  const aliased = [...sql.matchAll(/FROM "__grane_reach_pre_[^"]+" AS "([^"]+)"/g)].map((m) => m[1]);
  for (const alias of aliased) {
    expect(sql).toMatch(new RegExp(`FROM "__grane_reach_pre_[^"]*${alias}" AS "${alias}"`));
  }
}

async function loadDuck(ddl: string[]): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-multihop-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const stmt of ddl) await conn.run(stmt);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

describe.skipIf(!duckOk)("unique multi-hop preaggregation aliases (DuckDB)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;
  let dualPath: string;

  beforeAll(async () => {
    path = await loadDuck(HOP_DDL);
    dualPath = await loadDuck([
      `CREATE TABLE orders (id INTEGER PRIMARY KEY)`,
      `INSERT INTO orders VALUES (1)`,
      `CREATE TABLE items (order_id INTEGER, product_id INTEGER)`,
      `INSERT INTO items VALUES (1, 10)`,
      `CREATE TABLE shipments (order_id INTEGER, product_id INTEGER)`,
      `INSERT INTO shipments VALUES (1, 20)`,
      `CREATE TABLE products (id INTEGER PRIMARY KEY, weight DOUBLE PRECISION)`,
      `INSERT INTO products VALUES (10, 2.5), (20, 99)`,
      `CREATE TABLE shipping_costs (shipment_order_id INTEGER, cost DOUBLE PRECISION)`,
      `INSERT INTO shipping_costs VALUES (1, 7.5)`,
    ]);
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(relOrder: "forward" | "reversed" = "forward"): GraneKernel {
    const k = new GraneKernel(hopConfig({ type: "duckdb", path, schema: "main" }, relOrder));
    kernels.push(k);
    return k;
  }

  async function expectGoverned(k: GraneKernel, metric: string, value: number, extra: Record<string, unknown> = {}) {
    const input = { metrics: [metric], ...extra };
    const { compiled } = k.compile(input as never);
    expectReachAliasesAligned(compiled.sql);
    const result = await k.query(input as never);
    expect(result.trust).toBe("governed");
    expect(result.completeness.status).toBe("complete");
    expect(Number(result.rows[0]![metric])).toBe(value);
    expect(result.provenance.generated_sql).not.toMatch(/Referenced table|Binder Error/i);
    return { compiled, result };
  }

  it("1-hop unique fan-out is governed", async () => {
    await expectGoverned(kernel(), "mid_qty", 6.5);
  });

  it("2-hop unique preagg is governed 6.5", async () => {
    const { compiled } = await expectGoverned(kernel(), "line_grams", 6.5);
    expect(compiled.sql).toMatch(/__grane_reach_pre_line_grams_lines" AS "lines"/);
  });

  it("3-hop parent reproducer is governed 6.5 and no longer aliases hop_mid as hop_sku", async () => {
    const { compiled, result } = await expectGoverned(kernel(), "sku_grams", 6.5);
    expect(compiled.sql).toContain(`FROM "__grane_reach_pre_sku_grams_hop_mid" AS "hop_mid"`);
    expect(compiled.sql).toContain(`FROM "__grane_reach_pre_sku_grams_hop_sku" AS "hop_sku"`);
    expect(compiled.sql).not.toContain(`FROM "__grane_reach_pre_sku_grams_hop_mid" AS "hop_sku"`);
    expect(compiled.guards.filter((g) => g.scope === "preagg").map((g) => g.table)).toEqual(["skus"]);
    expect(compiled.guards.find((g) => g.scope === "preagg")!.keySource).toBe("__grane_reach_pre_sku_grams_hop_sku");
  });

  it("4-hop unique path is governed 6.5", async () => {
    const { compiled } = await expectGoverned(kernel(), "four_grams", 6.5);
    expect(compiled.sql).toMatch(/hop_a|hop_b|hop_c/);
    expect(compiled.sql).toContain(`AS "hop_a"`);
    expect(compiled.sql).toContain(`AS "hop_b"`);
    expect(compiled.sql).toContain(`AS "hop_c"`);
  });

  it("YAML declaration order does not change the unique 3-hop result", async () => {
    await expectGoverned(kernel("reversed"), "sku_grams", 6.5);
  });

  it("unmatched intermediate row and NULL FK do not drop the matched sibling", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER PRIMARY KEY, status VARCHAR, ordered_at DATE)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01')`,
      `CREATE TABLE hop_mid (mid_pk INTEGER PRIMARY KEY, order_ref INTEGER, mid_qty DOUBLE PRECISION)`,
      `INSERT INTO hop_mid VALUES (1, 1, 1)`,
      `CREATE TABLE hop_sku (sku_row INTEGER PRIMARY KEY, mid_fk INTEGER, sku_ref INTEGER)`,
      `INSERT INTO hop_sku VALUES (1, 1, 10), (2, 1, NULL), (3, 1, 99)`,
      `CREATE TABLE skus (sku_pk INTEGER PRIMARY KEY, grams DOUBLE PRECISION)`,
      `INSERT INTO skus VALUES (10, 6.5)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    const { compiled } = await expectGoverned(k, "sku_grams", 6.5);
    expect(compiled.sql).toContain("LEFT JOIN");
    expect(compiled.sql).not.toMatch(/^\s+JOIN "hop_sku"/m);
  });

  it("participating duplicate on the first many_to_one hop refuses", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7)`,
      `CREATE TABLE lines (line_id INTEGER, order_fk INTEGER, weight_fk INTEGER)`,
      `INSERT INTO lines VALUES (1, 1, 10)`,
      `CREATE TABLE weights (weight_pk INTEGER, grams DOUBLE PRECISION)`,
      `INSERT INTO weights VALUES (10, 1.5), (10, 5.0)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    const r = await refusalAsync(() => k.query({ metrics: ["line_grams"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/weights/);
  });

  it("participating duplicate on the final many_to_one hop refuses", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7)`,
      `CREATE TABLE hop_mid (mid_pk INTEGER, order_ref INTEGER, mid_qty DOUBLE PRECISION)`,
      `INSERT INTO hop_mid VALUES (1, 1, 1)`,
      `CREATE TABLE hop_sku (sku_row INTEGER, mid_fk INTEGER, sku_ref INTEGER)`,
      `INSERT INTO hop_sku VALUES (1, 1, 10)`,
      `CREATE TABLE skus (sku_pk INTEGER, grams DOUBLE PRECISION)`,
      `INSERT INTO skus VALUES (10, 1.5), (10, 5.0)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    const r = await refusalAsync(() => k.query({ metrics: ["sku_grams"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/skus/);
  });

  it("unreachable sku duplicate does not refuse", async () => {
    const db = await loadDuck([
      ...HOP_DDL.filter((s) => !s.includes("skus")),
      `CREATE TABLE skus (sku_pk INTEGER, grams DOUBLE PRECISION)`,
      `INSERT INTO skus VALUES (10, 1.5), (20, 5.0), (99, 8), (99, 8)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    await expectGoverned(k, "sku_grams", 6.5);
  });

  it("participating duplicate on a middle many_to_one hop refuses", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7)`,
      `CREATE TABLE hop_a (a_id INTEGER, order_fk INTEGER, b_ref INTEGER)`,
      `INSERT INTO hop_a VALUES (1, 1, 2)`,
      `CREATE TABLE hop_b (b_id INTEGER, c_ref INTEGER)`,
      `INSERT INTO hop_b VALUES (2, 3)`,
      `CREATE TABLE hop_c (c_id INTEGER, fact_fk INTEGER)`,
      `INSERT INTO hop_c VALUES (3, 7), (3, 7)`,
      `CREATE TABLE facts (fact_id INTEGER, grams DOUBLE PRECISION)`,
      `INSERT INTO facts VALUES (7, 6.5)`,
    ]);
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "mid-dup", timezone: "UTC" },
        connection: { type: "duckdb", path: db, schema: "main" },
        entities: { order: { table: "orders", primary_key: "id" } },
        metrics: { four_grams: { entity: "order", type: "sum", sql: "${facts.grams}" } },
        relationships: {
          a_to_orders: { from: "hop_a.order_fk", to: "orders.id", type: "many_to_one" },
          a_to_b: { from: "hop_a.b_ref", to: "hop_b.b_id", type: "many_to_one" },
          b_to_c: { from: "hop_b.c_ref", to: "hop_c.c_id", type: "many_to_one" },
          c_to_facts: { from: "hop_c.fact_fk", to: "facts.fact_id", type: "many_to_one" },
        },
      }),
    );
    kernels.push(k);
    const r = await refusalAsync(() => k.query({ metrics: ["four_grams"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/hop_c/);
  });

  it("participating duplicate on a 4-hop final many_to_one hop refuses", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7)`,
      `CREATE TABLE hop_a (a_id INTEGER, order_fk INTEGER)`,
      `INSERT INTO hop_a VALUES (1, 1)`,
      `CREATE TABLE hop_b (b_id INTEGER, a_fk INTEGER)`,
      `INSERT INTO hop_b VALUES (1, 1)`,
      `CREATE TABLE hop_c (c_id INTEGER, b_fk INTEGER, fact_fk INTEGER)`,
      `INSERT INTO hop_c VALUES (1, 1, 7)`,
      `CREATE TABLE facts (fact_id INTEGER, grams DOUBLE PRECISION)`,
      `INSERT INTO facts VALUES (7, 6.5), (7, 99)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    const r = await refusalAsync(() => k.query({ metrics: ["four_grams"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/facts/);
  });

  it("NULL measure is skipped by SUM and does not drop the sibling", async () => {
    const db = await loadDuck([
      `CREATE TABLE orders (id INTEGER PRIMARY KEY, status VARCHAR, ordered_at DATE, region_id INTEGER)`,
      `INSERT INTO orders VALUES (1, 'open', DATE '2026-08-01', 7)`,
      `CREATE TABLE hop_mid (mid_pk INTEGER PRIMARY KEY, order_ref INTEGER, mid_qty DOUBLE PRECISION)`,
      `INSERT INTO hop_mid VALUES (1, 1, 1)`,
      `CREATE TABLE hop_sku (sku_row INTEGER PRIMARY KEY, mid_fk INTEGER, sku_ref INTEGER)`,
      `INSERT INTO hop_sku VALUES (1, 1, 10), (2, 1, 20)`,
      `CREATE TABLE skus (sku_pk INTEGER PRIMARY KEY, grams DOUBLE PRECISION)`,
      `INSERT INTO skus VALUES (10, NULL), (20, 6.5)`,
    ]);
    const k = new GraneKernel(hopConfig({ type: "duckdb", path: db, schema: "main" }));
    kernels.push(k);
    await expectGoverned(k, "sku_grams", 6.5);
  });

  it("base filter, time filter, metric-definition filter, and joined filter keep valid aliases", async () => {
    const k = kernel();
    await expectGoverned(k, "sku_grams", 6.5, { filters: [{ field: "status", operator: "=", value: "open" }] });
    await expectGoverned(k, "sku_grams", 6.5, { time: { from: "2026-08-01", to: "2026-08-31" } });
    await expectGoverned(k, "open_sku_grams", 6.5);
    await expectGoverned(k, "sku_grams", 6.5, { filters: [{ field: "region", operator: "=", value: "west" }] });
    const grouped = await k.query({ metrics: ["sku_grams"], dimensions: ["region"] });
    expect(grouped.trust).toBe("governed");
    const west = grouped.rows.find((row) => row.region === "west");
    expect(Number(west!.sku_grams)).toBe(6.5);
  });

  it("multi-metric and ratio with the 3-hop component succeed", async () => {
    const k = kernel();
    const both = await k.query({ metrics: ["sku_grams", "order_count"] });
    expect(both.trust).toBe("governed");
    expect(Number(both.rows[0]!.sku_grams)).toBe(6.5);
    expect(Number(both.rows[0]!.order_count)).toBe(2);
    expectReachAliasesAligned(k.compile({ metrics: ["sku_grams", "order_count"] }).compiled.sql);
    const ratio = await k.query({ metrics: ["grams_per_order"] });
    expect(ratio.trust).toBe("governed");
    expect(Number(ratio.rows[0]!.grams_per_order)).toBe(3.25);
  });

  it("all-eight-dialect compile inspect of the 3-hop and 4-hop paths", () => {
    const k = kernel();
    for (const type of WAREHOUSE_TYPES) {
      k.config.connection.type = type;
      if (type === "bigquery") {
        k.config.connection.project = "acme";
        k.config.connection.dataset = "analytics";
        k.config.connection.schema = undefined;
      } else if (type === "mysql") {
        k.config.connection.schema = "shop";
      } else if (type === "databricks") {
        k.config.connection.catalog = "main";
        k.config.connection.schema = "analytics";
      } else if (type === "duckdb") {
        k.config.connection.schema = "main";
      } else {
        k.config.connection.schema = "public";
      }
      for (const metric of ["sku_grams", "four_grams", "line_grams"] as const) {
        const { compiled } = k.compile({ metrics: [metric] });
        expectReachAliasesAligned(compiled.sql);
        expect(compiled.sql, `${type} ${metric}`).not.toMatch(/hop_mid" AS "hop_sku"/);
      }
    }
  });

  it("#37 dual fan-out still refuses in both YAML orders", () => {
    const a = new GraneKernel(dualFanoutConfig("items-first", { type: "duckdb", path: dualPath, schema: "main" }));
    const b = new GraneKernel(dualFanoutConfig("shipments-first", { type: "duckdb", path: dualPath, schema: "main" }));
    kernels.push(a, b);
    expect(refusal(() => a.resolve({ metrics: ["product_weight"] })).status).toBe("ambiguous_query");
    expect(refusal(() => b.resolve({ metrics: ["product_weight"] })).status).toBe("ambiguous_query");
    expect(refusal(() => a.resolve({ metrics: ["order_count", "product_weight"] })).status).toBe("ambiguous_query");
    expect(refusal(() => a.resolve({ metrics: ["weight_per_order"] })).status).toBe("ambiguous_query");
  });

  it("#37 unique fan-out control remains governed 7.5", async () => {
    const k = new GraneKernel(uniqueFanoutConfig({ type: "duckdb", path: dualPath, schema: "main" }));
    kernels.push(k);
    const result = await k.query({ metrics: ["shipping_cost"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.shipping_cost)).toBe(7.5);
  });
});

describe.skipIf(!pgEnv)("unique multi-hop preaggregation (PostgreSQL live)", () => {
  const live = pgEnv!;
  const schema = newCertSchema();
  const kernels: GraneKernel[] = [];
  let writePool: pg.Pool;

  beforeAll(async () => {
    await ensureReadonlyRole(live.writeUrl);
    writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schema}`);
    await writePool.query(`SET search_path TO ${schema}`);
    for (const stmt of HOP_DDL) await writePool.query(stmt.replaceAll("VARCHAR", "TEXT"));
    await grantReadonlyOnSchema(writePool, schema);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (writePool) {
      await writePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    }
  });

  function kernel(relOrder: "forward" | "reversed" = "forward"): GraneKernel {
    const k = new GraneKernel(hopConfig({ type: "postgres", url: live.readUrl, schema }, relOrder));
    kernels.push(k);
    return k;
  }

  it("1/2/3/4-hop matrix matches the independent SQL oracle", async () => {
    const k = kernel();
    const kRev = kernel("reversed");
    const cases = [
      ["mid_qty", 6.5],
      ["line_grams", 6.5],
      ["sku_grams", 6.5],
      ["four_grams", 6.5],
    ] as const;
    for (const [metric, value] of cases) {
      const result = await k.query({ metrics: [metric] });
      expect(result.trust, metric).toBe("governed");
      expect(result.completeness.status, metric).toBe("complete");
      expect(Number(result.rows[0]![metric]), metric).toBe(value);
      expectReachAliasesAligned(k.compile({ metrics: [metric] }).compiled.sql);
    }
    expect(Number((await kRev.query({ metrics: ["sku_grams"] })).rows[0]!.sku_grams)).toBe(6.5);
    const oracle = await writePool.query(
      `SELECT SUM(s.grams) AS v
       FROM ${schema}.orders o
       JOIN ${schema}.hop_mid m ON m.order_ref = o.id
       JOIN ${schema}.hop_sku k ON k.mid_fk = m.mid_pk
       JOIN ${schema}.skus s ON s.sku_pk = k.sku_ref
       WHERE o.id = 1`,
    );
    expect(Number(oracle.rows[0]!.v)).toBe(6.5);
  });

  it("joined region filter and YAML reverse order stay governed 6.5", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["sku_grams"],
      filters: [{ field: "region", operator: "=", value: "west" }],
    });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.sku_grams)).toBe(6.5);
  });
});

describe.skipIf(!pgEnv)("#37 NULL filter regression (PostgreSQL live)", () => {
  const live = pgEnv!;
  const schema = newCertSchema();
  const kernels: GraneKernel[] = [];
  let writePool: pg.Pool;

  beforeAll(async () => {
    await ensureReadonlyRole(live.writeUrl);
    writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schema}`);
    await writePool.query(`SET search_path TO ${schema}`);
    for (const stmt of NULL_DDL.map((s) => s.replaceAll("VARCHAR", "TEXT").replaceAll("facts_n", "facts"))) {
      await writePool.query(stmt);
    }
    await grantReadonlyOnSchema(writePool, schema);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (writePool) {
      await writePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    }
  });

  it("JSON null comparisons refuse; is_null / is_not_null remain correct", async () => {
    const k = new GraneKernel(nullFilterConfig({ type: "postgres", url: live.readUrl, schema }));
    kernels.push(k);
    for (const filters of [
      [{ field: "status", operator: "=", value: null }],
      [{ field: "status", operator: "in", value: ["ok", null] }],
      [{ field: "status", operator: "not_in", value: ["bad", null] }],
      [{ field: "label", operator: "contains", value: null }],
    ]) {
      expect(refusal(() => k.resolve({ metrics: ["total"], filters: filters as never })).status).toBe("invalid_query");
    }
    const isNull = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_null" }] });
    expect(isNull.trust).toBe("governed");
    expect(Number(isNull.rows[0]!.total)).toBe(11);
    const isNot = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_not_null" }] });
    expect(Number(isNot.rows[0]!.total)).toBe(110);
  });
});

describe.skipIf(!duckOk)("#37 NULL filter regression stays on the semantic boundary", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    path = await loadDuck(NULL_DDL.map((s) => s.replaceAll("facts_n", "facts")));
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  it("JSON null comparisons refuse; is_null / is_not_null remain correct", async () => {
    const k = new GraneKernel(nullFilterConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    for (const filters of [
      [{ field: "status", operator: "=", value: null }],
      [{ field: "status", operator: "in", value: ["ok", null] }],
      [{ field: "status", operator: "not_in", value: ["bad", null] }],
      [{ field: "label", operator: "contains", value: null }],
    ]) {
      expect(refusal(() => k.resolve({ metrics: ["total"], filters: filters as never })).status).toBe("invalid_query");
    }
    const isNull = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_null" }] });
    expect(isNull.trust).toBe("governed");
    expect(Number(isNull.rows[0]!.total)).toBe(11);
    const isNot = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_not_null" }] });
    expect(Number(isNot.rows[0]!.total)).toBe(110);
  });
});
