import { afterAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { resolveRelativeRange } from "../../src/query/time.js";
import { GraneError } from "../../src/errors.js";

/**
 * Integration tests for the full governed workflow against the demo
 * database (`docker compose up -d postgres --wait`).
 *
 * Skipped automatically when the database is unreachable.
 */

const DB_URL =
  process.env.GRANE_TEST_DATABASE_URL ??
  "postgres://grane_readonly:grane_readonly@localhost:5433/grane_demo";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../demo/analytics");

async function databaseUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const dbUp = await databaseUp();

function loadKernel(): GraneKernel {
  const { config } = loadConfig(exampleDir);
  config.connection.url = DB_URL;
  // Pin UTC so expected values computed here match exactly.
  config.project.timezone = "UTC";
  return new GraneKernel(config);
}

describe.skipIf(!dbUp)("governed workflow (integration)", () => {
  const kernel = loadKernel();
  const raw = new pg.Pool({ connectionString: DB_URL });

  afterAll(async () => {
    await kernel.close();
    await raw.end();
  });

  const rawQuery = async (sql: string, params: unknown[] = []) => {
    const client = await raw.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await client.query(sql, params);
      await client.query("COMMIT");
      return result.rows;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };

  it("discovers the example schema", async () => {
    const schema = await kernel.introspectSchema();
    const tableNames = schema.tables.map((t) => t.name).sort();
    expect(tableNames).toEqual([
      "checkout_events",
      "customers",
      "order_items",
      "orders",
      "payments",
      "products",
      "refunds",
      "subscriptions",
      "support_tickets",
    ]);
    expect(schema.foreignKeys.length).toBeGreaterThanOrEqual(5);
  });

  it("validates the example semantic model against the live schema", async () => {
    const schema = await kernel.introspectSchema();
    const report = kernel.validate(schema);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('answers the headline question: "Revenue by country last month?" — correctly', async () => {
    const range = resolveRelativeRange("last_month", "UTC");
    const result = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: range.from, to: range.to },
    });

    expect(result.provenance.trust).toBe("governed");
    expect(result.provenance.metrics["revenue"]?.definition_version).toMatch(/^[0-9a-f]{8}$/);
    expect(result.provenance.generated_sql).toContain("SELECT");
    expect(result.rows.length).toBeGreaterThan(0);

    const expected = await rawQuery(
      `SELECT c.country, SUM(o.net_amount)::text AS revenue
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.status = 'completed'
         AND o.completed_at >= $1::timestamp
         AND o.completed_at < ($2::date + 1)::timestamp
       GROUP BY 1 ORDER BY SUM(o.net_amount) DESC`,
      [range.from, range.to],
    );
    const got = result.rows.map((r) => [r["country"], String(r["revenue"])]);
    expect(got).toEqual(expected.map((r) => [r.country, r.revenue]));
  });

  it("pre-aggregates fan-out measures correctly (payments minus fan-out corruption)", async () => {
    // payments_received sums a one_to_many child of orders. A naive join with
    // refunds (also one_to_many) would multiply rows; Grane pre-aggregates.
    const result = await kernel.query({
      metrics: ["payments_received", "refunded_amount", "revenue"],
    });
    const row = result.rows[0]!;

    const [expected] = await rawQuery(
      `SELECT
         (SELECT SUM(amount) FROM payments WHERE status = 'succeeded') AS payments_received,
         (SELECT SUM(amount) FROM refunds) AS refunded_amount,
         (SELECT SUM(net_amount) FROM orders WHERE status = 'completed') AS revenue`,
    );
    expect(String(row["payments_received"])).toBe(String(expected!.payments_received));
    expect(String(row["refunded_amount"])).toBe(String(expected!.refunded_amount));
    expect(String(row["revenue"])).toBe(String(expected!.revenue));
  });

  it("computes ratio metrics (average order value)", async () => {
    const result = await kernel.query({ metrics: ["average_order_value", "revenue", "orders"] });
    const row = result.rows[0]!;
    const aov = Number(row["average_order_value"]);
    const revenue = Number(row["revenue"]);
    const orders = Number(row["orders"]);
    expect(aov).toBeCloseTo(revenue / orders, 6);
  });

  it("supports monthly time grains with synonyms", async () => {
    const result = await kernel.query({
      metrics: ["sales"], // synonym for revenue
      time: { from: "2000-01-01", to: "2100-01-01", grain: "month" },
    });
    expect(result.notes.join(" ")).toContain('resolved to metric "revenue"');
    expect(result.columns).toContain("period_month");
    expect(result.rows.length).toBeGreaterThan(3);
  });

  it("refuses fan-out dimensions as governed queries", async () => {
    await expect(
      kernel.query({ metrics: ["revenue"], dimensions: ["product_category"] }),
    ).rejects.toSatisfy((err: unknown) => {
      return err instanceof GraneError && err.refusal.status === "unsafe_query";
    });
  });

  it("refuses undefined metrics with similar suggestions", async () => {
    await expect(kernel.query({ metrics: ["CAC"] })).rejects.toSatisfy((err: unknown) => {
      if (!(err instanceof GraneError)) return false;
      return err.refusal.status === "undefined_metric" && Array.isArray(err.refusal.similar);
    });
  });

  it("slices a governed metric by a raw warehouse column (trust: mixed)", async () => {
    const result = await kernel.query({
      metrics: ["revenue"],
      raw_dimensions: ["customers.name"],
      limit: 5,
    });
    expect(result.trust).toBe("mixed");
    expect(result.governed).toContain("revenue");
    expect(result.ungoverned).toContain("customers.name");
    expect(result.warning).toContain("customers.name");
    expect(result.columns).toContain("customers.name");
    expect(result.provenance.trust).toBe("mixed");
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows.length).toBeLessThanOrEqual(5);
  });

  it("runs an exploratory aggregation over raw warehouse columns", async () => {
    const result = await kernel.query({
      raw_metrics: [{ field: "payments.id", type: "count" }],
      raw_dimensions: ["payments.status"],
    });
    expect(result.trust).toBe("exploratory");
    expect(result.governed).toEqual([]);
    expect(result.ungoverned).toEqual(expect.arrayContaining(["payments.status", "payments.id"]));
    expect(result.columns).toContain("payments.status");
    const statuses = result.rows.map((r) => r["payments.status"]);
    expect(statuses).toEqual(expect.arrayContaining(["succeeded"]));
  });

  it("executes read-only: the connected role cannot write", async () => {
    await expect(rawQuery("DELETE FROM orders")).rejects.toThrow();
  });

  it("enforces filters and limits end to end", async () => {
    const result = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [{ field: "customer_type", operator: "=", value: "business" }],
      limit: 3,
    });
    expect(result.rows.length).toBeLessThanOrEqual(3);
    const [expected] = await rawQuery(
      `SELECT COUNT(DISTINCT c.country)::int AS countries
       FROM orders o JOIN customers c ON o.customer_id = c.id
       WHERE o.status = 'completed' AND c.customer_type = 'business'`,
    );
    expect(result.rows.length).toBe(Math.min(3, Number(expected!.countries)));
  });
});
