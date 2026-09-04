/**
 * Non-contributing groups / NULL vs 0 / group-existence contract (PR #34).
 *
 * A group exists iff the query's analytical population — base rows after
 * query time bounds and query WHERE, LEFT JOINed to selected dimensions —
 * produces that GROUP BY key. Metric-definition FILTER is not WHERE: it
 * changes contribution to that metric, not group membership.
 *
 * Consequently:
 *   SUM/AVG/MIN/MAX with zero contributing values → NULL
 *   COUNT(*) / COUNT(x) / COUNT DISTINCT with zero contributing values → 0
 *   fill_nulls_with COALESCE-s the aggregate; it does not invent or drop groups
 *   a group that contributes to one requested metric is not dropped because
 *   another requested metric is NULL
 *
 * MetricFlow 0.212 applies measure filters as source WHERE before GROUP BY,
 * so it omits groups that Grane returns as NULL/0. Contributing aggregates
 * match. That row-set difference is an explicit provider boundary, not a
 * governed-wrong number. Do not "fix" it with HAVING metric IS NOT NULL.
 *
 * Synthetic wrapper padding remains #27 (`__grane_row`). Cardinality P0
 * remains #32 (contribution for guards, not for group existence).
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { getDialect, WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { RESULT_ROW_COLUMN, RESULT_TOTAL_COLUMN } from "../../src/compile/compiler.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mcpTrustText } from "../../src/query/trust.js";

const execFileAsync = promisify(execFile);
const Q = { from: "2026-01-01", to: "2026-12-31" } as const;

const DDL = `
  CREATE TABLE sales (
    id INTEGER,
    customer_id INTEGER,
    amount DOUBLE PRECISION,
    sold_on DATE,
    status VARCHAR,
    channel VARCHAR
  );
  INSERT INTO sales VALUES
    (1, 1, 100,  DATE '2026-01-15', 'open',    'web'),
    (2, 2, 50,   DATE '2026-01-16', 'closed',  'web'),
    (3, 3, NULL, DATE '2026-01-17', 'open',    'store'),
    (4, 4, 10,   DATE '2025-06-01', 'open',    'web'),
    (5, 5, 25,   DATE '2026-01-18', 'pending', 'web'),
    (6, NULL, 5, DATE '2026-01-19', 'open',    'web'),
    (7, 99, 7,   DATE '2026-01-20', 'open',    'web');
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, account VARCHAR, country VARCHAR);
  INSERT INTO customers VALUES
    (1, 'Acme', 'US'),
    (2, 'Beta', 'UK'),
    (3, 'NullOnly', 'US'),
    (4, 'History', 'US'),
    (5, 'Delta', 'DE'),
    (6, 'NoFacts', 'US');
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-31', 10),
    (2, 2, DATE '2026-01-31', NULL),
    (3, 1, DATE '2026-06-30', 11),
    (4, 3, DATE '2025-12-31', 99);
`;

function maps() {
  return {
    entities: {
      sale: { table: "sales", primary_key: "id" },
      customer: { table: "customers", primary_key: "customer_id" },
      snap: { table: "snapshots", primary_key: "row_id" },
    },
    metrics: {
      revenue: { entity: "sale", type: "sum" as const, sql: "${sales.amount}", time_dimension: "${sales.sold_on}" },
      open_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
      },
      closed_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "closed" },
      },
      open_avg: {
        entity: "sale",
        type: "avg" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
      },
      open_min: {
        entity: "sale",
        type: "min" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
      },
      open_max: {
        entity: "sale",
        type: "max" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
      },
      open_filled: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
        fill_nulls_with: 0,
      },
      order_count: { entity: "sale", type: "count" as const, time_dimension: "${sales.sold_on}" },
      amount_count: { entity: "sale", type: "count" as const, sql: "${sales.amount}", time_dimension: "${sales.sold_on}" },
      amount_distinct: {
        entity: "sale",
        type: "count_distinct" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
      },
      open_orders: {
        entity: "sale",
        type: "count" as const,
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "open" },
      },
      aov: { entity: "sale", type: "ratio" as const, numerator: "open_revenue", denominator: "open_orders" },
      uk_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "customers.country": "UK" },
      },
      ending_bal: {
        entity: "snap",
        type: "sum" as const,
        sql: "${snapshots.balance}",
        time_dimension: "${snapshots.snapshot_date}",
        additive: "semi" as const,
        semi_additive: { window: "last" as const, group_by: [] as string[] },
      },
    },
    dimensions: {
      account: { entity: "customer", sql: "${customers.account}" },
      country: { entity: "customer", sql: "${customers.country}" },
      status: { entity: "sale", sql: "${sales.status}" },
      channel: { entity: "sale", sql: "${sales.channel}" },
    },
    relationships: {
      sales_customers: {
        from: "sales.customer_id",
        to: "customers.customer_id",
        type: "many_to_one" as const,
      },
      snap_customers: {
        from: "snapshots.customer_id",
        to: "customers.customer_id",
        type: "many_to_one" as const,
      },
    },
  };
}

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
        runAndReadAll: (sql: string) => Promise<{
          getRowObjectsJS?: () => Record<string, unknown>[];
          getRowObjects?: () => Record<string, unknown>[];
        }>;
        closeSync?: () => void;
        disconnectSync?: () => void;
      }>;
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

async function makeKernel(extra: Record<string, unknown> = {}, defaultRows = 1000) {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-g34-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) await conn.run(stmt);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const kernel = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "g34", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      limits: { default_rows: defaultRows, max_rows: 10000, timeout_ms: 30000 },
      ...maps(),
      ...extra,
    }),
  );
  kernels.push(kernel);
  return { kernel, path };
}

async function oracle(path: string, sql: string): Promise<Record<string, unknown>[]> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    const reader = await conn.runAndReadAll(sql);
    return reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? [];
  } finally {
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  }
}

const n = (v: unknown): number | null => (v == null ? null : Number(v));
const byAccount = (rows: Record<string, unknown>[], metric: string) =>
  Object.fromEntries(rows.map((r) => [String(r.account ?? "∅"), n(r[metric])]));

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

function compileKernel() {
  return new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "g34", timezone: "UTC" },
      connection: { type: "postgres", schema: "public" },
      ...maps(),
    }),
  );
}

describe("SQL shape: FILTER is not WHERE; groups come from the analytical population", () => {
  it("metric-definition status filter is not pushed into __grane_pop", () => {
    const k = compileKernel();
    const sql = k.compile({ metrics: ["open_revenue"], dimensions: ["account"], time: Q }).compiled.sql;
    const pop = sql.match(/"__grane_pop" AS \(([\s\S]*?)\n\)/)?.[1] ?? "";
    expect(pop).toMatch(/FROM "public"\."sales"/);
    expect(pop).toMatch(/"sales"\."sold_on"/);
    expect(pop).not.toMatch(/status/);
    expect(sql).toMatch(/SUM\("sales"\."amount"\) FILTER \(WHERE "sales"\."status" = \$/);
    expect(sql).toMatch(/LEFT JOIN "public"\."customers"/);
    expect(sql).toMatch(/ORDER BY "__grane_result"\."open_revenue" DESC$/);
    expect(sql).not.toMatch(/HAVING /);
  });

  it("query WHERE on a joined dimension is WHERE after the join, not a metric FILTER", () => {
    const k = compileKernel();
    const sql = k.compile({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "country", operator: "=", value: "UK" }],
      time: Q,
    }).compiled.sql;
    expect(sql).toMatch(/WHERE "customers"\."country" = \$/);
    expect(sql).not.toMatch(/FILTER \(WHERE "customers"\."country"/);
  });

  it("all dialects keep metric FILTER (or CASE) off the population WHERE", () => {
    const k = compileKernel();
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
      const sql = k.compile({ metrics: ["open_revenue"], dimensions: ["account"], time: Q, limit: 2 }).compiled.sql;
      const d = getDialect(type);
      const outer = `ORDER BY ${d.ident("__grane_result")}.${d.ident("open_revenue")} DESC`;
      expect(sql, type).toMatch(/__grane_result/);
      expect(sql, type).toMatch(new RegExp(`${outer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      expect(sql, type).not.toMatch(/HAVING /);
      if (d.supportsFilterClause) {
        expect(sql, type).toMatch(/FILTER \(WHERE/);
      } else {
        expect(sql, type).toMatch(/SUM\(CASE WHEN/);
      }
    }
  });
});

describe.skipIf(!available)("group existence vs aggregate value (DuckDB)", () => {
  it("open_revenue BY account keeps non-contributing groups as NULL; time-out and no-fact groups are absent", async () => {
    const { kernel: k, path } = await makeKernel();
    const r = await k.query({ metrics: ["open_revenue"], dimensions: ["account"], time: Q });
    expect(r.trust).toBe("governed");
    expect(byAccount(r.rows, "open_revenue")).toEqual({
      Acme: 100,
      Beta: null,
      NullOnly: null,
      Delta: null,
      "∅": 12,
    });
    expect(r.rows.some((row) => row.account === "History")).toBe(false);
    expect(r.rows.some((row) => row.account === "NoFacts")).toBe(false);
    for (const row of r.rows) {
      expect(row).not.toHaveProperty(RESULT_TOTAL_COLUMN);
      expect(row).not.toHaveProperty(RESULT_ROW_COLUMN);
    }

    const filterOracle = await oracle(
      path,
      `SELECT c.account, SUM(s.amount) FILTER (WHERE s.status = 'open') AS open_revenue
       FROM sales s LEFT JOIN customers c ON s.customer_id = c.customer_id
       WHERE s.sold_on >= DATE '2026-01-01' AND s.sold_on < DATE '2027-01-01'
       GROUP BY 1 ORDER BY 1`,
    );
    expect(byAccount(filterOracle, "open_revenue")).toEqual(byAccount(r.rows, "open_revenue"));

    // MetricFlow-style: WHERE status='open' before GROUP BY omits Beta/Delta.
    const mfStyle = await oracle(
      path,
      `SELECT c.account, SUM(s.amount) AS open_revenue
       FROM sales s LEFT JOIN customers c ON s.customer_id = c.customer_id
       WHERE s.sold_on >= DATE '2026-01-01' AND s.sold_on < DATE '2027-01-01'
         AND s.status = 'open'
       GROUP BY 1 ORDER BY 1`,
    );
    expect(mfStyle.map((row) => String(row.account ?? "∅")).sort()).toEqual(["Acme", "NullOnly", "∅"]);
    expect(n(mfStyle.find((row) => row.account === "Acme")?.open_revenue)).toBe(100);
  });

  it("NULL measure groups survive; COUNT is 0 where SUM is NULL; fill_nulls fills without dropping", async () => {
    const { kernel: k } = await makeKernel();
    const sums = await k.query({ metrics: ["revenue"], dimensions: ["account"], time: Q });
    expect(n(sums.rows.find((r) => r.account === "NullOnly")?.revenue)).toBeNull();
    const counts = await k.query({
      metrics: ["order_count", "amount_count", "amount_distinct", "open_orders"],
      dimensions: ["account"],
      time: Q,
    });
    const nullOnly = counts.rows.find((r) => r.account === "NullOnly")!;
    expect(n(nullOnly.order_count)).toBe(1);
    expect(n(nullOnly.amount_count)).toBe(0);
    expect(n(nullOnly.amount_distinct)).toBe(0);
    expect(n(nullOnly.open_orders)).toBe(1);
    const beta = counts.rows.find((r) => r.account === "Beta")!;
    expect(n(beta.open_orders)).toBe(0);
    const avgs = await k.query({
      metrics: ["open_avg", "open_min", "open_max"],
      dimensions: ["account"],
      time: Q,
    });
    expect(n(avgs.rows.find((r) => r.account === "Acme")?.open_avg)).toBe(100);
    expect(n(avgs.rows.find((r) => r.account === "Beta")?.open_avg)).toBeNull();
    expect(n(avgs.rows.find((r) => r.account === "Beta")?.open_min)).toBeNull();
    expect(n(avgs.rows.find((r) => r.account === "Beta")?.open_max)).toBeNull();
    const filled = await k.query({ metrics: ["open_filled"], dimensions: ["account"], time: Q });
    expect(n(filled.rows.find((r) => r.account === "Acme")?.open_filled)).toBe(100);
    expect(n(filled.rows.find((r) => r.account === "Beta")?.open_filled)).toBe(0);
    expect(new Set(filled.rows.map((r) => r.account))).toEqual(new Set(["Acme", "Beta", "Delta", "NullOnly", null]));
  });

  it("multi-metric keeps a group that contributes to only one requested metric", async () => {
    const { kernel: k } = await makeKernel();
    const r = await k.query({
      metrics: ["open_revenue", "closed_revenue"],
      dimensions: ["account"],
      time: Q,
    });
    const acme = r.rows.find((row) => row.account === "Acme")!;
    const beta = r.rows.find((row) => row.account === "Beta")!;
    const delta = r.rows.find((row) => row.account === "Delta")!;
    expect(n(acme.open_revenue)).toBe(100);
    expect(n(acme.closed_revenue)).toBeNull();
    expect(n(beta.open_revenue)).toBeNull();
    expect(n(beta.closed_revenue)).toBe(50);
    expect(n(delta.open_revenue)).toBeNull();
    expect(n(delta.closed_revenue)).toBeNull();
    const ratio = await k.query({ metrics: ["aov"], dimensions: ["account"], time: Q });
    expect(n(ratio.rows.find((row) => row.account === "Acme")?.aov)).toBe(100);
    expect(n(ratio.rows.find((row) => row.account === "Beta")?.aov)).toBeNull();
  });

  it("query WHERE removes the group; metric FILTER leaves it with NULL", async () => {
    const { kernel: k } = await makeKernel();
    const whereUk = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "country", operator: "=", value: "UK" }],
      time: Q,
    });
    expect(whereUk.rows.map((r) => r.account)).toEqual(["Beta"]);
    expect(n(whereUk.rows[0]?.revenue)).toBe(50);
    const filterUk = await k.query({ metrics: ["uk_revenue"], dimensions: ["account"], time: Q });
    expect(n(filterUk.rows.find((r) => r.account === "Beta")?.uk_revenue)).toBe(50);
    expect(n(filterUk.rows.find((r) => r.account === "Acme")?.uk_revenue)).toBeNull();
    expect(filterUk.rows.length).toBeGreaterThan(1);
  });

  it("LEFT JOIN unmatched / NULL FK groups survive; snapshot omits historical-only groups", async () => {
    const { kernel: k } = await makeKernel();
    const r = await k.query({ metrics: ["open_revenue"], dimensions: ["account"], time: Q });
    expect(n(r.rows.find((row) => row.account == null)?.open_revenue)).toBe(12);
    const snap = await k.query({
      metrics: ["ending_bal"],
      dimensions: ["account"],
      time: { from: "2026-01-01", to: "2026-01-31" },
    });
    expect(snap.trust).toBe("governed");
    expect(byAccount(snap.rows, "ending_bal")).toEqual({ Acme: 10, Beta: null });
    expect(snap.rows.some((row) => row.account === "NullOnly")).toBe(false);
  });

  it("ordering, top-N, and execution cap apply to the analytical group set including NULL groups", async () => {
    const { kernel: k } = await makeKernel();
    const sql = k.compile({
      metrics: ["open_revenue"],
      dimensions: ["account"],
      order: [{ field: "open_revenue", direction: "desc" }],
      limit: 2,
      time: Q,
    }).compiled.sql;
    expect(sql).toMatch(/ORDER BY "open_revenue" DESC\n {2}LIMIT 2\n\)/);
    expect(sql).toMatch(/ORDER BY "__grane_result"\."open_revenue" DESC$/);
    const top = await k.query({
      metrics: ["open_revenue"],
      dimensions: ["account"],
      order: [{ field: "open_revenue", direction: "desc" }],
      limit: 2,
      time: Q,
    });
    expect(top.completeness).toEqual({ status: "complete", limit: 2, source: "query" });
    expect(n(top.rows[0]?.open_revenue)).toBe(100);
    expect(top.rows[0]?.account).toBe("Acme");
    expect(top.rows).toHaveLength(2);
    const { kernel: capped } = await makeKernel({}, 2);
    const truncated = await capped.query({ metrics: ["open_revenue"], dimensions: ["account"], time: Q });
    expect(truncated.completeness).toEqual({ status: "truncated", limit: 2, source: "default" });
    expect(truncated.rows).toHaveLength(2);
    expect(n(truncated.rows[0]?.open_revenue)).toBe(100);
  });

  it("#32 still refuses participating duplicates and keeps filter-only NULL-measure legal", async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    const path = join(mkdtempSync(join(tmpdir(), "grane-g34-dup-")), "w.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`CREATE TABLE sales (id INTEGER, customer_id INTEGER, amount DOUBLE PRECISION, sold_on DATE)`);
    await conn.run(`INSERT INTO sales VALUES (1, 1, 100, DATE '2026-01-15'), (2, 2, NULL, DATE '2026-01-16')`);
    await conn.run(`CREATE TABLE customers (customer_id INTEGER, account VARCHAR)`);
    await conn.run(`INSERT INTO customers VALUES (1, 'Acme'), (2, 'NullA'), (2, 'NullB')`);
    conn.closeSync?.();
    instance.closeSync?.();
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "g34-dup", timezone: "UTC" },
        connection: { type: "duckdb", path, schema: "main" },
        entities: {
          sale: { table: "sales", primary_key: "id" },
          customer: { table: "customers", primary_key: "customer_id" },
        },
        metrics: {
          revenue: { entity: "sale", type: "sum", sql: "${sales.amount}", time_dimension: "${sales.sold_on}" },
          order_count: { entity: "sale", type: "count", time_dimension: "${sales.sold_on}" },
        },
        dimensions: { account: { entity: "customer", sql: "${customers.account}" } },
        relationships: {
          sales_customers: { from: "sales.customer_id", to: "customers.customer_id", type: "many_to_one" },
        },
      }),
    );
    kernels.push(k);
    expect((await refusalAsync(() => k.query({ metrics: ["revenue"], dimensions: ["account"], time: Q }))).status).toBe(
      "unsafe_query",
    );
    expect((await refusalAsync(() => k.query({ metrics: ["order_count"], dimensions: ["account"], time: Q }))).status).toBe(
      "unsafe_query",
    );
    const legal = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
      time: Q,
    });
    expect(legal.trust).toBe("governed");
    expect(n(legal.rows[0]?.revenue)).toBe(100);
  });

  it("MCP/CLI preserve FILTER semantics and kernel row membership", async () => {
    const { kernel: k, path } = await makeKernel();
    const query = { metrics: ["open_revenue"], dimensions: ["account"], time: Q };
    const explained = await k.explain(query);
    expect(explained.generated_sql).toMatch(/FILTER \(WHERE "sales"\."status"/);
    expect(explained.generated_sql).toMatch(/ORDER BY "__grane_result"\."open_revenue" DESC$/);
    const ran = await k.query(query);
    expect(explained.trust).toBe(ran.trust);
    expect(ran.trust).toBe("governed");
    expect(byAccount(ran.rows, "open_revenue").Beta).toBeNull();
    const text = mcpTrustText({
      trust: ran.trust,
      columns: ran.columns,
      rows: ran.rows,
      completeness: ran.completeness,
      provenance: ran.provenance,
    });
    expect(text).toMatch(/governed/i);

    const dir = mkdtempSync(join(tmpdir(), "grane-g34-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:\n  name: cli-g34\n  timezone: UTC\nconnection:\n  type: duckdb\n  path: ${JSON.stringify(path)}\n  schema: main\n`,
    );
    writeFileSync(
      join(dir, "model.yml"),
      `entities:
  sale:
    table: sales
    primary_key: id
  customer:
    table: customers
    primary_key: customer_id
metrics:
  open_revenue:
    entity: sale
    type: sum
    sql: "\${sales.amount}"
    time_dimension: "\${sales.sold_on}"
    filters:
      sales.status: open
dimensions:
  account:
    entity: customer
    sql: "\${customers.account}"
relationships:
  sales_customers:
    from: sales.customer_id
    to: customers.customer_id
    type: many_to_one
`,
    );
    mkdirSync(join(dir, "unused"), { recursive: true });
    const cli = join(process.cwd(), "src/cli/index.ts");
    const run = async (args: string[]) => {
      try {
        const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], { cwd: process.cwd(), timeout: 30000 });
        return { code: 0, stdout: out.stdout };
      } catch (err) {
        const e = err as { code?: number; stdout?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "" };
      }
    };
    const sql = await run(["query", "open_revenue", "--dimension", "account", "--from", "2026-01-01", "--to", "2026-12-31", "--sql"]);
    expect(sql.code).toBe(0);
    expect(sql.stdout).toMatch(/FILTER \(WHERE "sales"\."status"/);
    expect(sql.stdout).not.toMatch(/HAVING /);
    const json = await run(["query", "open_revenue", "--dimension", "account", "--from", "2026-01-01", "--to", "2026-12-31", "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as { rows: { account: string | null; open_revenue: number | null }[]; trust: string };
    expect(payload.trust).toBe("governed");
    expect(payload.rows.some((row) => row.account === "Beta" && row.open_revenue == null)).toBe(true);
  });
});

const PG_URL = process.env.GRANE_PG_WRITE_URL ?? "postgres://grane:grane@127.0.0.1:5432/grane_demo";

async function postgresUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
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

describe.skipIf(!(await postgresUp()))("group existence (PostgreSQL)", () => {
  it("FILTER keeps the closed-only group as NULL", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL });
    const schema = `g34_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    try {
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(`CREATE TABLE sales (id INTEGER, customer_id INTEGER, amount DOUBLE PRECISION, sold_on DATE, status TEXT)`);
      await pool.query(
        `INSERT INTO sales VALUES (1,1,100,DATE '2026-01-15','open'), (2,2,50,DATE '2026-01-16','closed')`,
      );
      await pool.query(`CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, account TEXT)`);
      await pool.query(`INSERT INTO customers VALUES (1,'Acme'), (2,'Beta')`);
      const k = new GraneKernel(
        graneConfigSchema.parse({
          project: { name: "g34-pg", timezone: "UTC" },
          connection: { type: "postgres", url: PG_URL, schema },
          entities: {
            sale: { table: "sales", primary_key: "id" },
            customer: { table: "customers", primary_key: "customer_id" },
          },
          metrics: {
            open_revenue: {
              entity: "sale",
              type: "sum",
              sql: "${sales.amount}",
              time_dimension: "${sales.sold_on}",
              filters: { "sales.status": "open" },
            },
          },
          dimensions: { account: { entity: "customer", sql: "${customers.account}" } },
          relationships: {
            sales_customers: { from: "sales.customer_id", to: "customers.customer_id", type: "many_to_one" },
          },
        }),
      );
      try {
        const r = await k.query({ metrics: ["open_revenue"], dimensions: ["account"], time: Q });
        expect(r.trust).toBe("governed");
        expect(byAccount(r.rows, "open_revenue")).toEqual({ Acme: 100, Beta: null });
        expect(k.compile({ metrics: ["open_revenue"], dimensions: ["account"], time: Q }).compiled.sql).toMatch(
          /FILTER \(WHERE "sales"\."status"/,
        );
      } finally {
        await k.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
});
