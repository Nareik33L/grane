/**
 * Untimed metric + explicit time constraint.
 *
 * A requested metric (or ratio component) with no time_dimension cannot
 * bind an analytical time range to its own semantics. Composition must not
 * change that: the same untimed metric cannot become 1200, 1500 or 3400
 * depending on which timed companions happen to be requested.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";

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

async function kernel(): Promise<GraneKernel> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-untimed-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  await conn.run(`CREATE TABLE regions (id INTEGER, name VARCHAR)`);
  await conn.run(`INSERT INTO regions VALUES (1, 'NA'), (2, 'EU')`);
  await conn.run(`CREATE TABLE customers (id INTEGER, credit NUMERIC, country VARCHAR, region_id INTEGER)`);
  await conn.run(`INSERT INTO customers VALUES (1, 400, 'US', 1), (2, 800, 'DE', 2)`);
  await conn.run(`CREATE TABLE orders (id INTEGER, customer_id INTEGER, amount NUMERIC, completed_at DATE, shipped_at DATE, status VARCHAR)`);
  await conn.run(`INSERT INTO orders VALUES
    (1, 1, 200, '2026-07-01', '2026-07-02', 'completed'),
    (2, 1, 1000, '2026-07-15', '2026-08-01', 'completed'),
    (3, 2, 300, '2026-08-01', '2026-08-02', 'completed')`);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const k = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "untimed", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: {
        customer: { table: "customers", primary_key: "id" },
        order: { table: "orders", primary_key: "id" },
      },
      metrics: {
        customers_credit_total: { entity: "customer", type: "sum", sql: "${customers.credit}" },
        open_amount: { entity: "order", type: "sum", sql: "${orders.amount}" },
        revenue: {
          entity: "order", type: "sum", sql: "${orders.amount}",
          time_dimension: "${orders.completed_at}",
          filters: { "orders.status": "completed" },
        },
        shipped_orders: {
          entity: "order", type: "sum", sql: "${orders.amount}",
          time_dimension: "${orders.shipped_at}",
          filters: { "orders.status": "completed" },
        },
        open_per_revenue: {
          entity: "order", type: "ratio",
          numerator: "open_amount",
          denominator: "revenue",
        },
        aov: { entity: "order", type: "ratio", numerator: "revenue", denominator: "shipped_orders" },
      },
      dimensions: {
        country: { entity: "customer", sql: "${customers.country}" },
        status: { entity: "order", sql: "${orders.status}" },
        region: { entity: "customer", sql: "${regions.name}" },
      },
      relationships: {
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        customers_regions: { from: "customers.region_id", to: "regions.id", type: "many_to_one" },
      },
    }),
  );
  kernels.push(k);
  return k;
}

async function refusalOf(fn: () => unknown): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a structured refusal");
}

const time = { from: "2026-07-01", to: "2026-07-31" } as const;

describe.skipIf(!available)("untimed metric + explicit time (C1–C10)", () => {
  it("C1: untimed metric alone + time refuses", async () => {
    const k = await kernel();
    const r = await refusalOf(() => k.compile({ metrics: ["customers_credit_total"], time }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/customers_credit_total/);
    expect(r.message).toMatch(/time_dimension/);
    expect(r.message).not.toMatch(/binder|Catalog Error|syntax/i);
  });

  it("C2: untimed + timed metric A is the same refusal", async () => {
    const k = await kernel();
    const r = await refusalOf(() => k.compile({ metrics: ["open_amount", "revenue"], time }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/open_amount/);
  });

  it("C3: untimed + timed metric B (different time dimension) is the same refusal", async () => {
    const k = await kernel();
    const r = await refusalOf(() => k.compile({ metrics: ["open_amount", "shipped_orders"], time }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/open_amount/);
  });

  it("C4: untimed + A + B is the same refusal", async () => {
    const k = await kernel();
    const r = await refusalOf(() =>
      k.compile({ metrics: ["open_amount", "revenue", "shipped_orders"], time }),
    );
    expect(r.status).toBe("ambiguous_query");
  });

  it("C5: reverse metric order does not change the refusal", async () => {
    const k = await kernel();
    const r = await refusalOf(() => k.compile({ metrics: ["revenue", "open_amount"], time }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/open_amount/);
  });

  it("C6: untimed metric without a time constraint keeps its existing meaning", async () => {
    const k = await kernel();
    const result = await k.query({ metrics: ["customers_credit_total"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.customers_credit_total)).toBe(1200);
  });

  it("C7: ratio involving an untimed component + time refuses", async () => {
    const k = await kernel();
    const r = await refusalOf(() => k.compile({ metrics: ["open_per_revenue"], time }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/open_amount/);
    const ok = k.compile({ metrics: ["aov"], time });
    expect(ok.compiled.trust).toBe("governed");
  });

  it("C8: grouped untimed metric + explicit time refuses", async () => {
    const k = await kernel();
    const r = await refusalOf(() =>
      k.compile({ metrics: ["customers_credit_total"], dimensions: ["country"], time }),
    );
    expect(r.status).toBe("ambiguous_query");
  });

  it("C9: joined untimed metric + explicit time refuses", async () => {
    const k = await kernel();
    const r = await refusalOf(() =>
      k.compile({ metrics: ["customers_credit_total"], dimensions: ["region"], time }),
    );
    expect(r.status).toBe("ambiguous_query");
  });

  it("C10: the refusal is structured Grane, not a raw SQL/binder failure", async () => {
    const k = await kernel();
    const r = await refusalOf(() =>
      k.query({ metrics: ["open_amount", "revenue"], time }),
    );
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).not.toMatch(/Binder Error|Catalog Error|syntax error|Failed to/i);
    expect(r.details).toEqual(expect.objectContaining({ metrics: ["open_amount"] }));
  });
});
