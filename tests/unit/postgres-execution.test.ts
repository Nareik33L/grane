/**
 * PostgreSQL execution of the DATE timezone and pre-aggregation cardinality
 * invariants (A15 / B16). Skipped when no writable Postgres is reachable.
 *
 *   GRANE_PG_WRITE_URL  default postgres://grane:grane@localhost:5433/grane_demo
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";

const URL =
  process.env.GRANE_PG_WRITE_URL ??
  "postgres://grane:grane@localhost:5433/grane_demo";

async function postgresUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: URL, connectionTimeoutMillis: 2000 });
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

const available = await postgresUp();
const SCHEMA = `grane_fix_${Date.now().toString(36)}`;
const kernels: GraneKernel[] = [];
let pool: pg.Pool | null = null;

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

async function setup(): Promise<void> {
  pool = new pg.Pool({ connectionString: URL });
  await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  await pool.query(`SET search_path TO ${SCHEMA}`);
  await pool.query(`
    CREATE TABLE t (id INTEGER, d DATE, x NUMERIC);
    INSERT INTO t VALUES (1, '2026-08-01', 80), (2, '2026-08-01', 120);
    CREATE TABLE orders (id INTEGER, amount NUMERIC, ordered_at DATE);
    INSERT INTO orders VALUES (1, 10, '2026-08-01');
    CREATE TABLE order_items (id INTEGER, order_id INTEGER, product_id INTEGER);
    INSERT INTO order_items VALUES (1, 1, 10), (2, 1, 20);
    CREATE TABLE products (product_id INTEGER, weight_kg NUMERIC);
    INSERT INTO products VALUES (10, 10), (10, 10), (20, 21);
    CREATE TABLE products_safe (product_id INTEGER, weight_kg NUMERIC);
    INSERT INTO products_safe VALUES (10, 10), (20, 21), (99, 8), (99, 8);
  `);
}

function kernel(timezone: string, productsTable = "products"): GraneKernel {
  const k = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "pg-fix", timezone },
      connection: { type: "postgres", url: URL, schema: SCHEMA },
      entities: {
        fact: { table: "t", primary_key: "id" },
        order: { table: "orders", primary_key: "id" },
      },
      metrics: {
        total_x: { entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}" },
        order_weight: { entity: "order", type: "sum", sql: `\${${productsTable}.weight_kg}`, time_dimension: "${orders.ordered_at}" },
      },
      relationships: {
        items_orders: { from: "order_items.order_id", to: "orders.id", type: "many_to_one" },
        items_products: { from: "order_items.product_id", to: `${productsTable}.product_id`, type: "many_to_one" },
      },
    }),
  );
  kernels.push(k);
  return k;
}

describe.skipIf(!available)("A15 / B16 PostgreSQL execution", () => {
  beforeAll(async () => {
    await setup();
  });

  it("A15: DATE one-day filter is 200 in UTC and America/New_York", async () => {
    for (const tz of ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]) {
      const k = kernel(tz);
      const result = await k.query({
        metrics: ["total_x"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      expect(result.trust, tz).toBe("governed");
      expect(Number(result.rows[0]!.total_x), tz).toBe(200);
      const sql = k.compile({
        metrics: ["total_x"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      }).compiled.sql;
      expect(sql, tz).not.toMatch(/AT TIME ZONE/);
      expect(sql, tz).toMatch(/::date/);
    }
  });

  it("B16: participating pre-aggregation duplicate refuses; unreachable duplicate is 31", async () => {
    try {
      await kernel("UTC", "products").query({ metrics: ["order_weight"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
    }
    const ok = await kernel("UTC", "products_safe").query({ metrics: ["order_weight"] });
    expect(ok.trust).toBe("governed");
    expect(Number(ok.rows[0]!.order_weight)).toBe(31);
  });
});
