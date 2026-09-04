/**
 * Live PostgreSQL certification corpus (#36).
 *
 * Executes the same supported analytical intents against a real PostgreSQL
 * server through Grane's postgres adapter, and compares every successful
 * result to an independent SQL oracle on the physical tables. Grane SQL is
 * never the expected result.
 *
 * Runtime queries use the restricted `grane_readonly` role. Fixture load
 * uses the owner/write URL.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { stringify as stringifyYaml } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { serveHttp } from "../../src/mcp/transport.js";
import { mcpTrustText } from "../../src/query/trust.js";
import type { SemanticQueryInput } from "../../src/query/model.js";
import {
  AUG,
  AUG_PARTIAL,
  JUL_AUG_SPAN,
  PG_CERT_DDL,
  certConfig,
  civil,
  n,
  publicColumns,
  type CertKernelOpts,
} from "../fixtures/pg-cert.js";
import {
  ensureReadonlyRole,
  grantReadonlyOnSchema,
  newCertSchema,
  postgresLiveEnv,
  PG_READONLY_USER,
  type PostgresLiveEnv,
} from "../helpers/postgres-live.js";

const execFileAsync = promisify(execFile);

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}

async function refusalOf(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a Grane refusal");
}

const env = await postgresLiveEnv();
const duckOk = await duckdbAvailable();

describe.skipIf(!env)("PostgreSQL live certification (#36)", () => {
  const live = env as PostgresLiveEnv;
  const schema = newCertSchema();
  const kernels: GraneKernel[] = [];
  let writePool: pg.Pool;
  let readPool: pg.Pool;

  beforeAll(async () => {
    await ensureReadonlyRole(live.writeUrl);
    writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schema}`);
    await writePool.query(`SET search_path TO ${schema}`);
    for (const stmt of PG_CERT_DDL) await writePool.query(stmt);
    await grantReadonlyOnSchema(writePool, schema);
    readPool = new pg.Pool({ connectionString: live.readUrl });
  }, 60_000);

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (readPool) await readPool.end().catch(() => undefined);
    if (writePool) {
      await writePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    }
  });

  function kernel(opts: Partial<CertKernelOpts> = {}): GraneKernel {
    const k = new GraneKernel(
      certConfig({
        connection: { type: "postgres", url: live.readUrl, schema },
        ...opts,
      }),
    );
    kernels.push(k);
    return k;
  }

  function kernelAt(timezone: string, extra: Partial<CertKernelOpts> = {}, now?: Date): GraneKernel {
    const k = new GraneKernel(
      certConfig({
        connection: { type: "postgres", url: live.readUrl, schema },
        timezone,
        ...extra,
      }),
      now ? { now } : {},
    );
    kernels.push(k);
    return k;
  }

  async function oracleRows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
    const client = await writePool.connect();
    try {
      await client.query(`SET search_path TO ${schema}`);
      const result = await client.query<Record<string, unknown>>(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }

  it("records the live PostgreSQL environment and restricted runtime role", async () => {
    expect(live.version).toMatch(/PostgreSQL 16/);
    const who = await readPool.query<{ usr: string; can_insert: boolean }>(
      `SELECT current_user AS usr, has_table_privilege(current_user, $1, 'INSERT') AS can_insert`,
      [`${schema}.orders`],
    );
    expect(who.rows[0]!.usr).toBe(PG_READONLY_USER);
    expect(who.rows[0]!.can_insert).toBe(false);
    await expect(readPool.query(`INSERT INTO ${schema}.orders (id) VALUES (-1)`)).rejects.toThrow(
      /permission denied/i,
    );
    const counts = await oracleRows(`
      SELECT 'customers' AS t, COUNT(*)::int AS n FROM customers
      UNION ALL SELECT 'orders', COUNT(*)::int FROM orders
      UNION ALL SELECT 'snapshots', COUNT(*)::int FROM snapshots
      UNION ALL SELECT 'regions', COUNT(*)::int FROM regions
      UNION ALL SELECT 'items', COUNT(*)::int FROM items
      UNION ALL SELECT 'products_safe', COUNT(*)::int FROM products_safe
      UNION ALL SELECT 'days', COUNT(*)::int FROM days
      UNION ALL SELECT 'weeks', COUNT(*)::int FROM weeks
      UNION ALL SELECT 'types', COUNT(*)::int FROM types
    `);
    const byTable = Object.fromEntries(counts.map((r) => [r.t, r.n]));
    expect(byTable).toMatchObject({
      customers: 8,
      orders: 18,
      snapshots: 9,
      regions: 6,
      items: 3,
      products_safe: 4,
      days: 65,
      weeks: 7,
      types: 1,
    });
  });

  describe("1. simple aggregation + NULL/0", () => {
    it("SUM / AVG / MIN / MAX / COUNT(*) / COUNT(column) / COUNT DISTINCT match the oracle", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["revenue", "avg_amount", "min_amount", "max_amount", "order_rows", "amount_count", "distinct_accounts"],
        time: AUG,
      };
      const result = await k.query(q);
      expect(result.trust).toBe("governed");
      const o = (
        await oracleRows(`
        SELECT
          SUM(amount) AS revenue,
          AVG(amount) AS avg_amount,
          MIN(amount) AS min_amount,
          MAX(amount) AS max_amount,
          COUNT(*) AS order_rows,
          COUNT(amount) AS amount_count,
          COUNT(DISTINCT account_ref) AS distinct_accounts
        FROM orders
        WHERE ordered_on >= DATE '2026-08-01' AND ordered_on <= DATE '2026-08-31'
      `)
      )[0]!;
      expect(n(result.rows[0]!.revenue)).toBe(n(o.revenue));
      expect(n(result.rows[0]!.avg_amount)).toBe(n(o.avg_amount));
      expect(n(result.rows[0]!.min_amount)).toBe(n(o.min_amount));
      expect(n(result.rows[0]!.max_amount)).toBe(n(o.max_amount));
      expect(n(result.rows[0]!.order_rows)).toBe(n(o.order_rows));
      expect(n(result.rows[0]!.amount_count)).toBe(n(o.amount_count));
      expect(n(result.rows[0]!.distinct_accounts)).toBe(n(o.distinct_accounts));
      expect(n(o.amount_count)!).toBeLessThan(n(o.order_rows)!);
      expect(n(result.rows[0]!.revenue)).toBe(576);
    });
  });

  describe("2–3. dimensions, LEFT JOIN, relationship fidelity", () => {
    it("joined account uses customer_key, not the surrogate id", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
        order: [{ field: "revenue", direction: "desc" }],
      };
      const result = await k.query(q);
      expect(result.trust).toBe("governed");
      const o = await oracleRows(`
        SELECT c.name AS account, SUM(o.amount) AS revenue
        FROM orders o
        LEFT JOIN customers c ON o.account_ref = c.customer_key
        WHERE o.ordered_on BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'
          AND o.sku <> 'dupsku'
        GROUP BY c.name
        ORDER BY SUM(o.amount) DESC NULLS LAST
      `);
      expect(result.rows.map((r) => [r.account, n(r.revenue)])).toEqual(o.map((r) => [r.account, n(r.revenue)]));
      expect(result.rows.some((r) => r.account === "Acme")).toBe(true);
      const wrong = await oracleRows(`
        SELECT COUNT(*)::int AS n
        FROM orders o
        JOIN customers c ON o.account_ref = CAST(c.id AS TEXT)
        WHERE o.sku <> 'dupsku'
      `);
      expect(wrong[0]!.n).toBe(0);
    });

    it("NULL / unmatched FK land in a NULL joined-dimension group; Ghost does not appear", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      const names = result.rows.map((r) => r.account);
      expect(names).toContain(null);
      expect(names).not.toContain("Ghost");
      expect(names).not.toContain("NullKey");
      const nullRev = result.rows
        .filter((r) => r.account === null)
        .reduce((s, r) => s + (n(r.revenue) ?? 0), 0);
      expect(nullRev).toBe(10);
    });
  });

  describe("4–5. cardinality guards (#18/#19/#32)", () => {
    it("A valid many_to_one (Acme only) is governed 336", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.revenue)).toBe(336);
      expect(k.compile({ metrics: ["revenue"], dimensions: ["account"], time: AUG }).compiled.sql).not.toMatch(
        /SELECT DISTINCT/i,
      );
    });

    it("B participating DUP customer_key refuses unsafe_query", async () => {
      const k = kernel();
      const refused = await refusalOf(() => k.query({ metrics: ["revenue"], dimensions: ["account"], time: AUG }));
      expect(refused.status).toBe("unsafe_query");
      expect(refused.message).toMatch(/many_to_one|duplicat|cardinal/i);
      expect(refused.message).not.toMatch(/Binder|does not exist/i);
    });

    it("C non-participating products_safe dup (product 99) is allowed", async () => {
      const k = kernel({ products: "products_safe" });
      const result = await k.query({ metrics: ["order_weight"], time: AUG });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.order_weight)).toBe(52);
    });

    it("participating products_dup refuses; grain filter that drops the dup product allows 21", async () => {
      const bad = kernel({ products: "products_dup" });
      const refused = await refusalOf(() => bad.query({ metrics: ["order_weight"], time: AUG }));
      expect(refused.status).toBe("unsafe_query");
      // Joined account=Beta must not shrink fact-side P0 (#19). A grain-table
      // predicate that leaves only Beta's order (product 20, unique) is allowed.
      const still = await refusalOf(() =>
        bad.query({
          metrics: ["order_weight"],
          filters: [{ field: "account", operator: "=", value: "Beta" }],
          time: AUG,
        }),
      );
      expect(still.status).toBe("unsafe_query");
      const ok = kernel({ products: "products_dup" });
      const result = await ok.query({
        metrics: ["order_weight"],
        filters: [{ field: "sku", operator: "=", value: "ABC" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.order_weight)).toBe(21);
    });

    it("E Enterprise filter leaves both DUP copies and refuses; Acme-only allows", async () => {
      const k = kernel();
      const both = await refusalOf(() =>
        k.query({
          metrics: ["revenue"],
          dimensions: ["account"],
          filters: [{ field: "segment", operator: "=", value: "Enterprise" }],
          time: AUG,
        }),
      );
      expect(both.status).toBe("unsafe_query");
      const one = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: AUG,
      });
      expect(one.trust).toBe("governed");
    });

    it("F multi-hop region dup refuses; Acme-only hop-2 is East", async () => {
      const k = kernel();
      const refused = await refusalOf(() => k.query({ metrics: ["revenue"], dimensions: ["region"], time: AUG }));
      expect(refused.status).toBe("unsafe_query");
      const ok = await k.query({
        metrics: ["revenue"],
        dimensions: ["region"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: AUG,
      });
      expect(ok.trust).toBe("governed");
      expect(ok.rows[0]!.region).toBe("East");
      expect(n(ok.rows[0]!.revenue)).toBe(336);
    });

    it("G/H NULL-measure participation: SUM + joined dimension stays governed", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.revenue)).toBe(336);
    });

    it("I COUNT(*) with participating duplicate refuses", async () => {
      const k = kernel();
      const refused = await refusalOf(() => k.query({ metrics: ["order_rows"], dimensions: ["account"], time: AUG }));
      expect(refused.status).toBe("unsafe_query");
    });

    it("J multi-metric P0 union still refuses when DUP participates", async () => {
      const k = kernel();
      const refused = await refusalOf(() =>
        k.query({ metrics: ["revenue", "order_rows"], dimensions: ["account"], time: AUG }),
      );
      expect(refused.status).toBe("unsafe_query");
    });

    it("#19 query-effective: snapshot BY status WHERE Enterprise does not whole-table refuse", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["ending_mrr"],
        dimensions: ["status"],
        filters: [{ field: "segment", operator: "=", value: "Enterprise" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.ending_mrr)).toBe(1100);
      expect(result.rows[0]!.status).toBe("active");
    });
  });

  describe("6–8. DATE / timestamp_naive / timestamptz", () => {
    it("DATE 2026-08-01 is 200 under UTC and America/New_York", async () => {
      const o = (await oracleRows(`SELECT SUM(amount) AS s FROM orders WHERE ordered_on = DATE '2026-08-01'`))[0]!;
      expect(n(o.s)).toBe(200);
      for (const tz of ["UTC", "America/New_York"]) {
        const k = kernelAt(tz);
        const result = await k.query({ metrics: ["date_revenue"], time: { from: "2026-08-01", to: "2026-08-01" } });
        expect(result.trust, tz).toBe("governed");
        expect(n(result.rows[0]!.date_revenue), tz).toBe(200);
        const sql = k.compile({
          metrics: ["date_revenue"],
          time: { from: "2026-08-01", to: "2026-08-01" },
        }).compiled.sql;
        expect(sql, tz).toMatch(/::date/);
        expect(sql, tz).not.toMatch(/ordered_on"\)::timestamptz AT TIME ZONE/i);
      }
    });

    it("timestamp without time zone is a UTC wall-clock instant, then localized", async () => {
      const utc = await kernelAt("UTC").query({
        metrics: ["naive_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      const ny = await kernelAt("America/New_York").query({
        metrics: ["naive_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      expect(utc.trust).toBe("governed");
      expect(ny.trust).toBe("governed");
      expect(n(utc.rows[0]!.naive_revenue)).toBe(200);
      expect(n(ny.rows[0]!.naive_revenue)).toBe(120);
      const inspecting = kernelAt("America/New_York");
      await inspecting.loadSchema();
      const sql = inspecting.compile({
        metrics: ["naive_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      }).compiled.sql;
      expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    });

    it("timestamptz localizes the instant: UTC 200, America/New_York 120", async () => {
      const utc = await kernelAt("UTC").query({
        metrics: ["instant_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      const ny = await kernelAt("America/New_York").query({
        metrics: ["instant_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      expect(n(utc.rows[0]!.instant_revenue)).toBe(200);
      expect(n(ny.rows[0]!.instant_revenue)).toBe(120);
    });

    it("timezone does not leak across queries on one kernel or sequential kernels", async () => {
      const ny = kernelAt("America/New_York");
      const date1 = await ny.query({ metrics: ["date_revenue"], time: { from: "2026-08-01", to: "2026-08-01" } });
      const instant = await ny.query({
        metrics: ["instant_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      const date2 = await ny.query({ metrics: ["date_revenue"], time: { from: "2026-08-01", to: "2026-08-01" } });
      expect(n(date1.rows[0]!.date_revenue)).toBe(200);
      expect(n(instant.rows[0]!.instant_revenue)).toBe(120);
      expect(n(date2.rows[0]!.date_revenue)).toBe(200);
      const utc = await kernelAt("UTC").query({
        metrics: ["instant_revenue"],
        time: { from: "2026-08-01", to: "2026-08-01" },
      });
      expect(n(utc.rows[0]!.instant_revenue)).toBe(200);
    });
  });

  describe("9–10. week.starts and civil months", () => {
    it("week monday vs sunday match independent civil-week oracles", async () => {
      const byWeek = async (starts: "monday" | "sunday") => {
        const k = kernelAt("UTC", { weekStarts: starts });
        const result = await k.query({
          metrics: ["week_total"],
          time: { from: "2026-08-29", to: "2026-09-07", grain: "week" },
        });
        expect(result.trust).toBe("governed");
        return Object.fromEntries(result.rows.map((r) => [civil(r.period_week), n(r.week_total)]));
      };
      expect(await byWeek("monday")).toEqual({ "2026-08-24": 3, "2026-08-31": 60, "2026-09-07": 64 });
      expect(await byWeek("sunday")).toEqual({ "2026-08-23": 1, "2026-08-30": 30, "2026-09-06": 96 });
      const ny = kernelAt("America/New_York", { weekStarts: "monday" });
      const nyResult = await ny.query({
        metrics: ["week_total"],
        time: { from: "2026-08-29", to: "2026-09-07", grain: "week" },
      });
      expect(Object.fromEntries(nyResult.rows.map((r) => [civil(r.period_week), n(r.week_total)]))).toEqual({
        "2026-08-24": 3,
        "2026-08-31": 60,
        "2026-09-07": 64,
      });
    });

    it("1m on month-end / leap year clamps; overflow traps are not included", async () => {
      const mar = kernelAt("UTC", {}, new Date("2026-03-31T15:00:00Z"));
      const marResult = await mar.query({ metrics: ["march_x"], time: { period: "1m" } });
      expect(marResult.trust).toBe("governed");
      expect(n(marResult.rows[0]!.march_x)).toBe(3100);
      expect(mar.compile({ metrics: ["march_x"], time: { period: "1m" } }).resolved.time).toMatchObject({
        from: "2026-03-01",
        to: "2026-03-31",
      });
      const leap = kernelAt("UTC", {}, new Date("2024-03-31T15:00:00Z"));
      const leapResult = await leap.query({ metrics: ["march_x"], time: { period: "1m" } });
      expect(n(leapResult.rows[0]!.march_x)).toBe(31);
      expect(leap.compile({ metrics: ["march_x"], time: { period: "1m" } }).resolved.time).toMatchObject({
        from: "2024-03-01",
        to: "2024-03-31",
      });
    });
  });

  describe("11. MetricFlow native grain alignment (#35)", () => {
    it("partial civil August aligns to the full overlapping month", async () => {
      const k = kernel();
      const partial = await k.query({ metrics: ["ending_mrr"], time: AUG_PARTIAL });
      const full = await k.query({ metrics: ["ending_mrr"], time: AUG });
      expect(partial.trust).toBe("governed");
      expect(full.trust).toBe("governed");
      expect(n(partial.rows[0]!.ending_mrr)).toBe(1400);
      expect(n(partial.rows[0]!.ending_mrr)).toBe(n(full.rows[0]!.ending_mrr));
      expect(partial.notes.some((note) => note.includes("aligned to month grain 2026-08-01..2026-08-31"))).toBe(true);
      const o = (
        await oracleRows(`SELECT SUM(ending_mrr) AS s FROM snapshots WHERE month_start = DATE '2026-08-01'`)
      )[0]!;
      expect(n(partial.rows[0]!.ending_mrr)).toBe(n(o.s));
    });

    it("Jul 15–Aug 15 additive month-grain includes July and August", async () => {
      const k = kernel();
      const result = await k.query({ metrics: ["new_mrr"], time: JUL_AUG_SPAN });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.new_mrr)).toBe(321);
      expect(k.compile({ metrics: ["new_mrr"], time: JUL_AUG_SPAN }).resolved.time).toMatchObject({
        from: "2026-07-01",
        to: "2026-08-31",
      });
    });

    it("day-grain metric is not expanded", async () => {
      const k = kernel();
      const result = await k.query({ metrics: ["revenue"], time: AUG_PARTIAL });
      expect(result.trust).toBe("governed");
      expect(k.compile({ metrics: ["revenue"], time: AUG_PARTIAL }).resolved.time).toMatchObject(AUG_PARTIAL);
      const o = (
        await oracleRows(`
        SELECT SUM(amount) AS s FROM orders
        WHERE ordered_on BETWEEN DATE '2026-08-02' AND DATE '2026-08-31'
      `)
      )[0]!;
      expect(n(result.rows[0]!.revenue)).toBe(n(o.s));
      expect(n(result.rows[0]!.revenue)).not.toBe(200 + n(o.s)!);
    });
  });

  describe("12. semi-additive (#24/#25)", () => {
    it("global snapshot group_by [] is last August = 1400", async () => {
      const k = kernel();
      const result = await k.query({ metrics: ["ending_mrr"], time: AUG });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.ending_mrr)).toBe(1400);
    });

    it("valid explicit series is last per customer_key", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["ending_mrr_series"],
        dimensions: ["snap_key"],
        time: AUG,
        order: [{ field: "snap_key", direction: "asc" }],
      });
      expect(result.trust).toBe("governed");
      expect(result.rows.map((r) => [r.snap_key, n(r.ending_mrr_series)])).toEqual([
        ["A", 1100],
        ["B", 250],
        ["C", 40],
        ["HIST", 10],
      ]);
    });

    it("entity-PK series refuses; historical June dup is outside August; selected-snapshot customer dup refuses", async () => {
      const k = kernel();
      const entity = await refusalOf(() => k.query({ metrics: ["ending_mrr_entity"], time: AUG }));
      expect(entity.status).toBe("unsafe_query");
      const juneOk = await k.query({ metrics: ["ending_mrr_series"], time: AUG });
      expect(juneOk.trust).toBe("governed");
      await writePool.query(`INSERT INTO ${schema}.snapshots VALUES (10, 'DUP', DATE '2026-08-01', 3.00, 1.00)`);
      try {
        const refused = await refusalOf(() =>
          k.query({ metrics: ["ending_mrr"], dimensions: ["status"], time: AUG }),
        );
        expect(refused.status).toBe("unsafe_query");
      } finally {
        await writePool.query(`DELETE FROM ${schema}.snapshots WHERE id = 10`);
      }
    });
  });

  describe("13. metric filters (#31)", () => {
    it("grain-table FILTER and fan-out-free joined filter execute; refusals are Grane-owned", async () => {
      const k = kernel();
      const grain = await k.query({ metrics: ["open_revenue"], time: AUG });
      expect(grain.trust).toBe("governed");
      const o = (
        await oracleRows(`
        SELECT SUM(amount) AS s FROM orders
        WHERE ordered_on BETWEEN DATE '2026-08-01' AND DATE '2026-08-31' AND status = 'open'
      `)
      )[0]!;
      expect(n(grain.rows[0]!.open_revenue)).toBe(n(o.s));
      const joined = await k.query({
        metrics: ["uk_revenue"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      });
      expect(joined.trust).toBe("governed");
      expect(n(joined.rows[0]!.uk_revenue)).toBe(50);
      const ghost = await refusalOf(() => k.query({ metrics: ["ghost_revenue"], time: AUG }));
      expect(ghost.status).toBe("invalid_query");
      expect(ghost.message).not.toMatch(/Binder|does not exist/i);
      const fan = await refusalOf(() => k.query({ metrics: ["fanout_revenue"], time: AUG }));
      expect(fan.status).toBe("unsafe_query");
      const metricName = await refusalOf(() =>
        k.query({ metrics: ["revenue"], filters: [{ field: "revenue", operator: ">", value: 0 }], time: AUG }),
      );
      expect(metricName.status).toBe("invalid_query");
    });
  });

  describe("14. contains escaping", () => {
    it("literal substring matrix: wildcards, escape, quote, unicode, empty, injection-like", async () => {
      const k = kernel();
      const cases: Array<[string, number]> = [
        ["A_B", 10],
        ["A%B", 50],
        ["A\\B", 2],
        ["A!B", 4],
        ["A'B", 8],
        ["café", 16],
        ["x'; DROP TABLE orders;--", 64],
        ["ABC", 100],
      ];
      for (const [value, expected] of cases) {
        const result = await k.query({
          metrics: ["revenue"],
          filters: [{ field: "sku", operator: "contains", value }],
          time: AUG,
        });
        expect(result.trust, value).toBe("governed");
        expect(n(result.rows[0]!.revenue), value).toBe(expected);
        const compiled = k.compile({
          metrics: ["revenue"],
          filters: [{ field: "sku", operator: "contains", value }],
          time: AUG,
        });
        expect(compiled.compiled.params, value).toContain(value);
        expect(compiled.compiled.sql, value).toMatch(/ESCAPE '!'/);
      }
      const empty = await k.query({
        metrics: ["revenue"],
        filters: [{ field: "sku", operator: "contains", value: "" }],
        time: AUG,
      });
      expect(empty.trust).toBe("governed");
      const all = (
        await oracleRows(
          `SELECT SUM(amount) AS s FROM orders WHERE ordered_on BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'`,
        )
      )[0]!;
      expect(n(empty.rows[0]!.revenue)).toBe(n(all.s));
    });
  });

  describe("15–16. group existence (#34) and synthetic padding (#27)", () => {
    it("FILTER keeps closed-only Delta as NULL SUM / 0 COUNT; WHERE removes it", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["open_revenue", "open_rows", "open_amount_count"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      };
      const result = await k.query(q);
      expect(result.trust).toBe("governed");
      const byName = Object.fromEntries(result.rows.map((r) => [String(r.account), r]));
      expect(n(byName.Delta!.open_revenue)).toBeNull();
      expect(n(byName.Delta!.open_rows)).toBe(0);
      expect(n(byName.Delta!.open_amount_count)).toBe(0);
      expect(n(byName.Acme!.open_revenue)).toBe(336);
      const closed = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "order_status", operator: "=", value: "closed" }],
        time: AUG,
      });
      expect(closed.rows.map((r) => r.account)).toEqual(["Delta"]);
      expect(n(closed.rows[0]!.revenue)).toBe(75);
    });

    it("empty guarded result strips the wrapper row; __grane_row does not leak", async () => {
      const k = kernel();
      const empty = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "NoSuch" }],
        time: AUG,
      });
      expect(empty.trust).toBe("governed");
      expect(empty.rows).toEqual([]);
      expect(publicColumns(empty.columns)).not.toContain(RESULT_ROW_COLUMN);
      expect(empty.columns.some((c) => c.startsWith("__grane_"))).toBe(false);
      const realNull = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      });
      expect(realNull.rows.some((r) => r.account === null && n(r.revenue) === 10)).toBe(true);
    });
  });

  describe("17–18. namespace and public output collisions", () => {
    it("reserved __grane_ names refuse; hidden columns never appear", async () => {
      const k = kernel({ exploration: true });
      const reserved = await refusalOf(() =>
        k.query({
          raw_metrics: [{ field: "orders.amount", type: "sum", alias: "__grane_row" }],
        }),
      );
      expect(reserved.status).toBe("invalid_query");
      expect(reserved.message).toMatch(/__grane_/);
      const nCol = await refusalOf(() =>
        k.query({
          raw_metrics: [{ field: "orders.amount", type: "sum", alias: "__grane_n" }],
        }),
      );
      expect(nCol.status).toBe("invalid_query");
      const ok = await k.query({ metrics: ["revenue"], time: AUG });
      expect(ok.columns.some((c) => c.startsWith("__grane_"))).toBe(false);
      expect(ok.columns).not.toContain(RESULT_TOTAL_COLUMN);
    });

    it("period_month and metric+dimension code are ambiguous_query", async () => {
      const k = kernel();
      const period = await refusalOf(() =>
        k.query({ metrics: ["period_month"], time: { ...AUG, grain: "month" } }),
      );
      expect(period.status).toBe("ambiguous_query");
      const code = await refusalOf(() => k.query({ metrics: ["code"], dimensions: ["code"], time: AUG }));
      expect(code.status).toBe("ambiguous_query");
    });
  });

  describe("19. ordering (#33)", () => {
    it("revenue DESC is Beta, Delta, Cedar, Acme despite insert A,C,D,B", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "in", value: ["Acme", "Beta", "Cedar", "Delta"] }],
        time: { from: "2026-08-15", to: "2026-08-18" },
        order: [{ field: "revenue", direction: "desc" }],
      };
      const result = await k.query(q);
      expect(result.trust).toBe("governed");
      expect(result.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
        ["Beta", 100],
        ["Delta", 75],
        ["Cedar", 50],
        ["Acme", 10],
      ]);
    });

    it("top-2 DESC membership and order; outer ORDER BY after wrapper", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "in", value: ["Acme", "Beta", "Cedar", "Delta"] }],
        time: { from: "2026-08-15", to: "2026-08-18" },
        order: [{ field: "revenue", direction: "desc" }],
        limit: 2,
      };
      const result = await k.query(q);
      expect(result.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
        ["Beta", 100],
        ["Delta", 75],
      ]);
      const sql = k.compile(q).compiled.sql;
      expect(sql).toMatch(/ORDER BY "__grane_result"\."revenue" DESC$/);
    });
  });

  describe("20. completeness (#26)", () => {
    it("query.limit / default_rows / max_rows / exact cap / cap+1", async () => {
      const grouped: SemanticQueryInput = { metrics: ["revenue"], dimensions: ["sku"], time: AUG };
      const k = kernel({ defaultRows: 5, maxRows: 100 });
      const def = await k.query(grouped);
      expect(def.completeness.source).toBe("default");
      expect(def.completeness.status).toBe("truncated");
      expect(def.rows.length).toBe(5);
      expect(def.columns).not.toContain(RESULT_TOTAL_COLUMN);
      const sql = k.compile(grouped).compiled.sql;
      expect(sql).toMatch(/COUNT\(\*\) OVER\(\)/);
      const cap = kernel({ defaultRows: 1000, maxRows: 10000 });
      const top = await cap.query({ ...grouped, limit: 3 });
      expect(top.completeness.source).toBe("query");
      expect(top.completeness.status).toBe("complete");
      expect(top.rows.length).toBe(3);
      const exactN = (
        await oracleRows(
          `SELECT COUNT(DISTINCT sku)::int AS n FROM orders WHERE ordered_on BETWEEN DATE '2026-08-01' AND DATE '2026-08-31'`,
        )
      )[0]!.n as number;
      const exact = await cap.query({ ...grouped, limit: exactN });
      expect(exact.completeness.status).toBe("complete");
      expect(exact.rows.length).toBe(exactN);
      const over = await cap.query({ ...grouped, limit: exactN + 1 });
      expect(over.completeness.status).toBe("complete");
      expect(over.rows.length).toBe(exactN);
      const hard = kernel({ defaultRows: 1000, maxRows: 4 });
      const clamped = await hard.query(grouped);
      expect(clamped.completeness.source).toBe("max");
      expect(clamped.completeness.status).toBe("truncated");
      expect(clamped.rows.length).toBe(4);
    });
  });

  describe("21–22. trust and ratios", () => {
    it("governed / mixed experimental / exploratory raw-only", async () => {
      const k = kernel({ exploration: true });
      const gov = await k.query({ metrics: ["revenue"], time: AUG });
      expect(gov.trust).toBe("governed");
      const mixed = await k.query({ metrics: ["trial_revenue"], time: AUG });
      expect(mixed.trust).toBe("mixed");
      expect(n(mixed.rows[0]!.trial_revenue)).toBe(n(gov.rows[0]!.revenue));
      const raw = await k.query({
        raw_metrics: [{ field: "orders.amount", type: "sum", alias: "raw_sum" }],
        time: { ...AUG, dimension: "orders.ordered_on" },
      });
      expect(raw.trust).toBe("exploratory");
      const approvedRaw = await k.query({
        metrics: ["revenue"],
        raw_dimensions: ["orders.qty"],
        time: AUG,
      });
      expect(approvedRaw.trust).toBe("mixed");
    });

    it("ratio NULL numerator / zero denominator uses NULLIF", async () => {
      const k = kernel();
      const q: SemanticQueryInput = {
        metrics: ["open_aov"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      };
      const result = await k.query(q);
      expect(result.trust).toBe("governed");
      const delta = result.rows.find((r) => r.account === "Delta")!;
      expect(n(delta.open_aov)).toBeNull();
      const sql = k.compile(q).compiled.sql;
      expect(sql).toMatch(/NULLIF/);
      const acme = result.rows.find((r) => r.account === "Acme")!;
      expect(n(acme.open_aov)).not.toBeNull();
    });
  });

  describe("23–24. preaggregation and multi-metric", () => {
    it("legal child weight is 52; participating dup refuses", async () => {
      const ok = kernel({ products: "products_safe" });
      const result = await ok.query({ metrics: ["order_weight"], time: AUG });
      expect(result.trust).toBe("governed");
      expect(n(result.rows[0]!.order_weight)).toBe(52);
      const bad = kernel({ products: "products_dup" });
      expect((await refusalOf(() => bad.query({ metrics: ["order_weight"], time: AUG }))).status).toBe("unsafe_query");
    });

    it("two metrics with different FILTERs share grouping and #34 NULL/0", async () => {
      const k = kernel();
      const result = await k.query({
        metrics: ["revenue", "open_revenue"],
        dimensions: ["account"],
        filters: [{ field: "sku", operator: "!=", value: "dupsku" }],
        time: AUG,
      });
      expect(result.trust).toBe("governed");
      const delta = result.rows.find((r) => r.account === "Delta")!;
      expect(n(delta.revenue)).toBe(75);
      expect(n(delta.open_revenue)).toBeNull();
    });
  });

  describe("type fidelity, read-only session, recovery", () => {
    it("inspects driver types without re-parsing bigint past MAX_SAFE_INTEGER", async () => {
      const k = kernel();
      const result = await k.query({ metrics: ["type_int_sum", "type_bigint_sum", "type_numeric_sum"] });
      expect(result.trust).toBe("governed");
      const row = result.rows[0]!;
      expect(row.type_bigint_sum === "9007199254740993" || typeof row.type_bigint_sum === "bigint").toBe(true);
      if (typeof row.type_bigint_sum === "number") {
        expect.fail(`bigint was coerced to number ${row.type_bigint_sum}`);
      }
      expect(n(row.type_numeric_sum)).toBe(12.5);
      expect(n(row.type_int_sum)).toBe(1);
    });

    it("compiled SQL is SELECT-only; SET LOCAL TIME ZONE is the documented session operation", async () => {
      const k = kernel();
      const sql = k.compile({ metrics: ["revenue"], time: AUG }).compiled.sql;
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|TEMP)\b/i);
      const result = await k.query({ metrics: ["revenue"], time: AUG });
      expect(result.trust).toBe("governed");
    });

    it("cardinality refusal then a valid query recovers (no aborted transaction)", async () => {
      const k = kernel();
      await refusalOf(() => k.query({ metrics: ["revenue"], dimensions: ["account"], time: AUG }));
      const ok = await k.query({
        metrics: ["revenue"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: AUG,
      });
      expect(ok.trust).toBe("governed");
      expect(n(ok.rows[0]!.revenue)).toBe(336);
    });
  });

  describe("MCP and CLI against live PostgreSQL", () => {
    it("MCP query matches kernel for governed, guarded, refused, #35, top-N", async () => {
      const k = kernel();
      const handle = await serveHttp(k, 0);
      const client = new Client({ name: "pg-cert", version: "0.0.1" });
      try {
        const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
        await client.connect(transport);
        const parse = (result: Awaited<ReturnType<Client["callTool"]>>) => {
          const content = result.content as { type: string; text: string }[];
          const text = content[0]!.text;
          const start = text.indexOf("{");
          return JSON.parse(start >= 0 ? text.slice(start) : text) as Record<string, unknown>;
        };
        const simple = parse(
          await client.callTool({ name: "query", arguments: { query: { metrics: ["revenue"], time: AUG } } }),
        );
        const direct = await k.query({ metrics: ["revenue"], time: AUG });
        expect(simple.trust).toBe("governed");
        expect(n((simple.rows as Record<string, unknown>[])[0]!.revenue)).toBe(n(direct.rows[0]!.revenue));
        expect(
          mcpTrustText({
            trust: "governed",
            columns: [],
            rows: [],
            completeness: direct.completeness,
            provenance: direct.provenance,
          }),
        ).toMatch(/governed/i);

        const aligned = parse(
          await client.callTool({
            name: "query",
            arguments: { query: { metrics: ["ending_mrr"], time: AUG_PARTIAL } },
          }),
        );
        expect(aligned.trust).toBe("governed");
        expect(n((aligned.rows as Record<string, unknown>[])[0]!.ending_mrr)).toBe(1400);

        const top = parse(
          await client.callTool({
            name: "query",
            arguments: {
              query: {
                metrics: ["revenue"],
                dimensions: ["account"],
                filters: [{ field: "account", operator: "in", value: ["Acme", "Beta", "Cedar", "Delta"] }],
                time: { from: "2026-08-15", to: "2026-08-18" },
                order: [{ field: "revenue", direction: "desc" }],
                limit: 2,
              },
            },
          }),
        );
        expect((top.rows as Record<string, unknown>[]).map((r) => [r.account, n(r.revenue)])).toEqual([
          ["Beta", 100],
          ["Delta", 75],
        ]);

        const bad = await client.callTool({
          name: "query",
          arguments: { query: { metrics: ["revenue"], dimensions: ["account"], time: AUG } },
        });
        expect(bad.isError).toBe(true);
        expect(parse(bad).status).toBe("unsafe_query");
      } finally {
        await client.close();
        await handle.close();
      }
    });

    it("CLI validate / --sql / --json against the readonly URL", async () => {
      const dir = mkdtempSync(join(tmpdir(), "grane-pg-cert-cli-"));
      writeFileSync(
        join(dir, "grane.yml"),
        stringifyYaml({
          project: { name: "pg-cert-cli", timezone: "UTC" },
          connection: { type: "postgres", url: live.readUrl, schema },
        }),
      );
      writeFileSync(
        join(dir, "model.yml"),
        stringifyYaml({
          entities: {
            order: { table: "orders", primary_key: "id" },
            customer: { table: "customers", primary_key: "id" },
            snapshot: { table: "snapshots", primary_key: "id" },
          },
          metrics: {
            revenue: {
              entity: "order",
              type: "sum",
              sql: "${orders.amount}",
              time_dimension: "${orders.ordered_on}",
            },
            ending_mrr: {
              entity: "snapshot",
              type: "sum",
              sql: "${snapshots.ending_mrr}",
              time_dimension: "${snapshots.month_start}",
              time_granularity: "month",
              additive: "semi",
              semi_additive: { window: "last", group_by: [] },
            },
          },
          dimensions: {
            account: { entity: "customer", sql: "${customers.name}" },
          },
          relationships: {
            orders_customers: {
              from: "orders.account_ref",
              to: "customers.customer_key",
              type: "many_to_one",
            },
          },
        }),
      );
      const cli = join(process.cwd(), "src/cli/index.ts");
      const run = async (args: string[]) => {
        try {
          const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], {
            cwd: process.cwd(),
            timeout: 30000,
          });
          return { code: 0, stdout: out.stdout, stderr: out.stderr };
        } catch (err) {
          const e = err as { code?: number; stdout?: string; stderr?: string };
          return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
        }
      };
      const validated = await run(["validate"]);
      expect(validated.stderr + validated.stdout, validated.stderr + validated.stdout).not.toMatch(/ERROR/);
      expect(validated.code).toBe(0);
      const sql = await run(["query", "revenue", "--from", "2026-08-01", "--to", "2026-08-31", "--sql"]);
      expect(sql.code).toBe(0);
      expect(sql.stdout).toMatch(/SUM/i);
      const simple = await run(["query", "revenue", "--from", "2026-08-01", "--to", "2026-08-31", "--json"]);
      expect(simple.code).toBe(0);
      const payload = JSON.parse(simple.stdout) as { rows: { revenue: unknown }[]; trust: string };
      expect(payload.trust).toBe("governed");
      expect(n(payload.rows[0]!.revenue)).toBe(576);
      const aligned = await run(["query", "ending_mrr", "--from", "2026-08-02", "--to", "2026-08-31", "--json"]);
      expect(aligned.code).toBe(0);
      const alignedPayload = JSON.parse(aligned.stdout) as { rows: { ending_mrr: unknown }[]; trust: string };
      expect(alignedPayload.trust).toBe("governed");
      expect(n(alignedPayload.rows[0]!.ending_mrr)).toBe(1400);
      const topJson = await run([
        "query",
        "revenue",
        "--dimension",
        "account",
        "--filter",
        "account=Beta",
        "--from",
        "2026-08-15",
        "--to",
        "2026-08-18",
        "--json",
      ]);
      expect(topJson.code).toBe(0);
      const topPayload = JSON.parse(topJson.stdout) as { rows: { account: string; revenue: unknown }[] };
      expect(topPayload.rows[0]!.account).toBe("Beta");
      expect(n(topPayload.rows[0]!.revenue)).toBe(100);
    });
  });

  describe("all-eight-dialect compile-inspect", () => {
    it("legal guarded SQL compiles on every dialect", () => {
      const k = kernel();
      for (const type of WAREHOUSE_TYPES) {
        k.config.connection.type = type;
        if (type === "bigquery") {
          k.config.connection.project = "acme";
          k.config.connection.dataset = "analytics";
        }
        if (type === "mysql") k.config.connection.schema = "shop";
        if (type === "duckdb") k.config.connection.schema = "main";
        if (type === "databricks") {
          k.config.connection.catalog = "main";
          k.config.connection.schema = "main";
        }
        const { compiled, resolved } = k.compile({
          metrics: ["revenue"],
          dimensions: ["account"],
          filters: [{ field: "account", operator: "=", value: "Acme" }],
          time: AUG,
        });
        expect(compiled.sql, type).toMatch(/revenue/);
        expect(compiled.sql, type).not.toMatch(/SELECT DISTINCT/i);
        expect(resolved.trust, type).toBe("governed");
        const month = k.compile({ metrics: ["ending_mrr"], time: AUG_PARTIAL });
        expect(month.resolved.time?.from, type).toBe("2026-08-01");
        expect(month.resolved.time?.to, type).toBe("2026-08-31");
      }
      k.config.connection.type = "postgres";
      k.config.connection.schema = schema;
      k.config.connection.project = undefined;
      k.config.connection.dataset = undefined;
      k.config.connection.catalog = undefined;
    });
  });
});

describe.skipIf(!duckOk)("DuckDB cross-engine control for the pg-cert fixture", () => {
  type DuckDbMod = {
    DuckDBInstance: {
      create: (path: string) => Promise<{
        connect: () => Promise<{
          run: (sql: string) => Promise<unknown>;
          closeSync?: () => void;
          disconnectSync?: () => void;
        }>;
        closeSync?: () => void;
      }>;
    };
  };
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-pg-cert-duck-")), "t.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    for (const stmt of PG_CERT_DDL) await conn.run(stmt);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(timezone = "UTC"): GraneKernel {
    const k = new GraneKernel(
      certConfig({
        connection: { type: "duckdb", path, schema: "main" },
        timezone,
      }),
    );
    kernels.push(k);
    return k;
  }

  it("simple SUM, #35 partial month, DATE, top-2 order match the PostgreSQL logical oracles", async () => {
    const k = kernel();
    const sum = await k.query({ metrics: ["revenue"], time: AUG });
    expect(sum.trust).toBe("governed");
    expect(n(sum.rows[0]!.revenue)).toBe(576);
    const partial = await k.query({ metrics: ["ending_mrr"], time: AUG_PARTIAL });
    expect(n(partial.rows[0]!.ending_mrr)).toBe(1400);
    const dateNy = await kernel("America/New_York").query({
      metrics: ["date_revenue"],
      time: { from: "2026-08-01", to: "2026-08-01" },
    });
    expect(n(dateNy.rows[0]!.date_revenue)).toBe(200);
    const top = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "account", operator: "in", value: ["Acme", "Beta", "Cedar", "Delta"] }],
      time: { from: "2026-08-15", to: "2026-08-18" },
      order: [{ field: "revenue", direction: "desc" }],
      limit: 2,
    });
    expect(top.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
      ["Beta", 100],
      ["Delta", 75],
    ]);
    const dup = await refusalOf(() => k.query({ metrics: ["revenue"], dimensions: ["account"], time: AUG }));
    expect(dup.status).toBe("unsafe_query");
  });
});
