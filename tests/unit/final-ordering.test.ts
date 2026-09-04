/**
 * Final ORDER BY portability (PR #33).
 *
 * Parent SQL (merged main): when joins emit the cardinality wrapper,
 * ORDER BY + LIMIT lived only inside `__grane_result`. The outer
 * `__grane_card LEFT JOIN __grane_result ON TRUE` had no ORDER BY.
 * SQL does not promise CTE order survives that join.
 *
 * Fix: keep inner ORDER BY + LIMIT (semantic top-N / cap membership) and
 * repeat the same public-output keys on the outermost SELECT, qualified as
 * `__grane_result.<field>`.
 *
 * Default order is unchanged: time.grain → period_${grain} ASC; otherwise
 * first selected metric DESC when the query is grouped. NULLS FIRST/LAST
 * is not part of the query API.
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
    (1, 1, 10,  DATE '2026-01-15', 'complete', 'web'),
    (2, 3, 50,  DATE '2026-02-10', 'complete', 'store'),
    (3, 2, 100, DATE '2026-03-05', 'complete', 'web'),
    (4, 4, 75,  DATE '2026-04-20', 'pending',  'web'),
    (5, 5, 80,  DATE '2026-05-01', 'complete', 'store');
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, account VARCHAR, country VARCHAR);
  INSERT INTO customers VALUES
    (1, 'Acme', 'US'),
    (2, 'Beta', 'UK'),
    (3, 'Cedar', 'US'),
    (4, 'Delta', 'UK'),
    (5, 'Echo', 'US');
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-31', 10),
    (2, 2, DATE '2026-01-31', 100),
    (3, 3, DATE '2026-01-31', 50),
    (4, 1, DATE '2026-06-30', 11),
    (5, 2, DATE '2026-06-30', 90);
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
      orders: { entity: "sale", type: "count" as const, time_dimension: "${sales.sold_on}" },
      aov: { entity: "sale", type: "ratio" as const, numerator: "revenue", denominator: "orders" },
      completed_revenue: {
        entity: "sale",
        type: "sum" as const,
        sql: "${sales.amount}",
        time_dimension: "${sales.sold_on}",
        filters: { "sales.status": "complete" },
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
      channel: { entity: "sale", sql: "${sales.channel}" },
      status: { entity: "sale", sql: "${sales.status}" },
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

async function makeKernel(extra: Record<string, unknown> = {}, defaultRows = 1000): Promise<{ kernel: GraneKernel; path: string }> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-ord-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const stmt of DDL.split(";").map((s) => s.trim()).filter(Boolean)) await conn.run(stmt);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const kernel = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "ordering", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      limits: { default_rows: defaultRows, max_rows: 10000, timeout_ms: 30000 },
      ...maps(),
      ...extra,
    }),
  );
  kernels.push(kernel);
  return { kernel, path };
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

const n = (v: unknown): number => Number(v);

function orderPairs(sql: string): string[] {
  return [...sql.matchAll(/ORDER BY[^\n]+/g)].map((m) => m[0]);
}

describe("SQL shape: inner membership ORDER BY + outer presentation ORDER BY", () => {
  it("unguarded queries order at the final SELECT only", () => {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "ordering", timezone: "UTC" },
        connection: { type: "postgres", schema: "public" },
        ...maps(),
      }),
    );
    const { compiled } = k.compile({
      metrics: ["revenue"],
      dimensions: ["channel"],
      order: [{ field: "revenue", direction: "desc" }],
      time: Q,
    });
    expect(compiled.sql).not.toMatch(/__grane_result/);
    expect(orderPairs(compiled.sql)).toEqual(['ORDER BY "revenue" DESC']);
    expect(compiled.sql).toMatch(/ORDER BY "revenue" DESC\nLIMIT /);
    const scalar = k.compile({ metrics: ["revenue"], time: Q }).compiled.sql;
    expect(scalar).not.toMatch(/ORDER BY/);
    expect(scalar).toMatch(/^SELECT /);
  });

  it("guarded queries keep inner ORDER BY+LIMIT and repeat ORDER BY on the outer SELECT", () => {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "ordering", timezone: "UTC" },
        connection: { type: "postgres", schema: "public" },
        ...maps(),
      }),
    );
    const { compiled } = k.compile({
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "revenue", direction: "desc" }],
      limit: 2,
      time: Q,
    });
    expect(compiled.sql).toMatch(
      /COUNT\(\*\) OVER\(\) AS "__grane_n"[\s\S]*ORDER BY "revenue" DESC\n {2}LIMIT 2\n\)/,
    );
    expect(compiled.sql).toMatch(/"__grane_result" AS \([\s\S]*ORDER BY "revenue" DESC\n {2}LIMIT 2\n\)/);
    expect(compiled.sql).toMatch(/LEFT JOIN "__grane_result" ON TRUE\nORDER BY "__grane_result"\."revenue" DESC$/);
    expect(compiled.sql).not.toMatch(/NULLS FIRST|NULLS LAST/i);
    expect(compiled.sql).not.toMatch(/ORDER BY "__grane_n"|ORDER BY "__grane_row"|ORDER BY "__grane_card_/);
    expect(compiled.sql).not.toMatch(/LEFT JOIN "__grane_result" ON TRUE\nORDER BY[\s\S]*LIMIT/);
    const orders = orderPairs(compiled.sql);
    expect(orders).toHaveLength(2);
    expect(orders[0]).toContain('"revenue" DESC');
    expect(orders[1]).toContain('"__grane_result"."revenue" DESC');
  });

  it("default grouped order is first metric DESC; time grain defaults to period ASC", () => {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "ordering", timezone: "UTC" },
        connection: { type: "postgres", schema: "public" },
        ...maps(),
      }),
    );
    const grouped = k.compile({ metrics: ["revenue"], dimensions: ["account"], time: Q }).compiled.sql;
    expect(grouped).toMatch(/ORDER BY "revenue" DESC/);
    expect(grouped).toMatch(/ORDER BY "__grane_result"\."revenue" DESC$/);
    const timed = k.compile({
      metrics: ["revenue"],
      dimensions: ["account"],
      time: { ...Q, grain: "month" },
    }).compiled.sql;
    expect(timed).toMatch(/ORDER BY "period_month" ASC/);
    expect(timed).toMatch(/ORDER BY "__grane_result"\."period_month" ASC$/);
    for (const grain of ["day", "week", "month", "quarter", "year"] as const) {
      const sql = k.compile({
        metrics: ["revenue"],
        dimensions: ["account"],
        time: { ...Q, grain },
      }).compiled.sql;
      expect(sql, grain).toMatch(new RegExp(`ORDER BY "period_${grain}" ASC`));
      expect(sql, grain).toMatch(new RegExp(`ORDER BY "__grane_result"\\."period_${grain}" ASC$`));
      expect(sql, grain).not.toMatch(/ambiguous/i);
    }
  });

  it("all dialects emit a legal outer ORDER BY on a guarded query", () => {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "ordering", timezone: "UTC" },
        connection: { type: "postgres", schema: "public" },
        ...maps(),
      }),
    );
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
      const { compiled } = k.compile({
        metrics: ["revenue"],
        dimensions: ["account"],
        order: [{ field: "revenue", direction: "desc" }],
        limit: 2,
        time: Q,
      });
      const d = getDialect(type);
      const inner = `ORDER BY ${d.ident("revenue")} DESC`;
      const outer = `ORDER BY ${d.ident("__grane_result")}.${d.ident("revenue")} DESC`;
      expect(compiled.sql, type).toMatch(/__grane_result/);
      expect(orderPairs(compiled.sql), type).toEqual([inner, outer]);
      expect(compiled.sql, type).toMatch(new RegExp(`${inner}\\n {2}LIMIT 2\\n\\)`));
      expect(compiled.sql, type).toMatch(new RegExp(`ON TRUE\\n${outer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      expect(compiled.sql, type).not.toMatch(/SELECT DISTINCT/i);
      expect(compiled.sql, type).not.toMatch(/NULLS FIRST|NULLS LAST/i);
    }
  });
});

describe.skipIf(!available)("row membership and promised order (DuckDB)", () => {
  it("metric DESC/ASC and semantic top-2 pick the right members in the right order", async () => {
    const { kernel: k, path } = await makeKernel();
    const desc = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "revenue", direction: "desc" }],
      time: Q,
    });
    expect(desc.trust).toBe("governed");
    expect(desc.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
      ["Beta", 100],
      ["Echo", 80],
      ["Delta", 75],
      ["Cedar", 50],
      ["Acme", 10],
    ]);
    const top2 = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "revenue", direction: "desc" }],
      limit: 2,
      time: Q,
    });
    expect(top2.completeness).toEqual({ status: "complete", limit: 2, source: "query" });
    expect(top2.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
      ["Beta", 100],
      ["Echo", 80],
    ]);
    // Independent membership/order oracle — not Grane SQL. Physical insert
    // order was Acme, Cedar, Beta, Delta, Echo; metric DESC top-2 is Beta, Echo.
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    try {
      const reader = await conn.runAndReadAll(`
        SELECT c.account, SUM(s.amount) AS revenue
        FROM sales s
        JOIN customers c ON s.customer_id = c.customer_id
        WHERE s.sold_on >= DATE '2026-01-01' AND s.sold_on < DATE '2027-01-01'
        GROUP BY c.account
        ORDER BY revenue DESC
        LIMIT 2
      `);
      const rows = reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? [];
      expect(rows.map((r) => [r.account, n(r.revenue)])).toEqual([
        ["Beta", 100],
        ["Echo", 80],
      ]);
    } finally {
      conn.closeSync?.();
      conn.disconnectSync?.();
      instance.closeSync?.();
    }
    const bottom2 = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "revenue", direction: "asc" }],
      limit: 2,
      time: Q,
    });
    expect(bottom2.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
      ["Acme", 10],
      ["Cedar", 50],
    ]);
  });

  it("dimension, time, multi-key, ratio, and joined-filter order apply to final groups", async () => {
    const { kernel: k } = await makeKernel();
    const byName = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "account", direction: "asc" }],
      time: Q,
    });
    expect(byName.rows.map((r) => r.account)).toEqual(["Acme", "Beta", "Cedar", "Delta", "Echo"]);
    const multi = await k.query({
      metrics: ["revenue"],
      dimensions: ["account", "country"],
      order: [
        { field: "country", direction: "asc" },
        { field: "revenue", direction: "desc" },
      ],
      time: Q,
    });
    expect(multi.rows.map((r) => r.account)).toEqual(["Beta", "Delta", "Echo", "Cedar", "Acme"]);
    const timed = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      time: { ...Q, grain: "month" },
    });
    expect(timed.columns[0]).toBe("period_month");
    expect(timed.rows.map((r) => r.account)).toEqual(["Acme", "Cedar", "Beta", "Delta", "Echo"]);
    const monthTimes = timed.rows.map((r) => new Date(r.period_month as string | Date).getTime());
    expect(monthTimes).toEqual([...monthTimes].sort((a, b) => a - b));
    const ratio = await k.query({
      metrics: ["aov"],
      dimensions: ["account"],
      order: [{ field: "aov", direction: "desc" }],
      time: Q,
    });
    expect(n(ratio.rows[0]?.aov)).toBe(100);
    expect(ratio.rows[0]?.account).toBe("Beta");
    const filtered = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "country", operator: "=", value: "US" }],
      order: [{ field: "revenue", direction: "desc" }],
      time: Q,
    });
    expect(filtered.rows.map((r) => r.account)).toEqual(["Echo", "Cedar", "Acme"]);
    const metricFilter = await k.query({
      metrics: ["completed_revenue"],
      dimensions: ["account"],
      order: [{ field: "completed_revenue", direction: "desc" }],
      time: Q,
    });
    // Metric-definition FILTER does not drop non-contributing groups (#34).
    // Delta is pending-only so completed_revenue is NULL; warehouse NULL
    // placement is not a Grane contract. Ordering is by the filtered metric
    // (not unfiltered amount 75, which would sit between Echo and Cedar).
    expect(metricFilter.rows.map((r) => [r.account, r.completed_revenue == null ? null : n(r.completed_revenue)])).toEqual([
      ["Beta", 100],
      ["Echo", 80],
      ["Cedar", 50],
      ["Acme", 10],
      ["Delta", null],
    ]);
  });

  it("execution cap truncates after the promised default metric DESC order", async () => {
    const { kernel: k } = await makeKernel({}, 2);
    const capped = await k.query({ metrics: ["revenue"], dimensions: ["account"], time: Q });
    expect(capped.completeness).toEqual({ status: "truncated", limit: 2, source: "default" });
    expect(capped.rows.map((r) => [r.account, n(r.revenue)])).toEqual([
      ["Beta", 100],
      ["Echo", 80],
    ]);
    for (const row of capped.rows) {
      expect(row).not.toHaveProperty(RESULT_TOTAL_COLUMN);
      expect(row).not.toHaveProperty(RESULT_ROW_COLUMN);
    }
  });

  it("semi-additive order happens after snapshot selection", async () => {
    const { kernel: k } = await makeKernel();
    const r = await k.query({
      metrics: ["ending_bal"],
      dimensions: ["account"],
      order: [{ field: "ending_bal", direction: "desc" }],
      time: { from: "2026-01-01", to: "2026-06-30" },
    });
    expect(r.trust).toBe("governed");
    expect(r.rows.map((row) => [row.account, n(row.ending_bal)])).toEqual([
      ["Beta", 90],
      ["Acme", 11],
    ]);
  });

  it("raw/mixed order does not change trust; #32 duplicate still refuses; #30/#29 stay closed", async () => {
    const { kernel: k } = await makeKernel({ exploration: { enabled: true, schemas: ["main"] } });
    const mixed = await k.query({
      metrics: ["revenue"],
      raw_dimensions: ["sales.channel"],
      order: [{ field: "revenue", direction: "desc" }],
      time: Q,
    });
    expect(mixed.trust).toBe("mixed");
    expect(n(mixed.rows[0]?.revenue)).toBeGreaterThan(n(mixed.rows[1]?.revenue));
    const colliding = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "ordering", timezone: "UTC" },
        connection: { type: "duckdb", path: ":memory:", schema: "main" },
        ...maps(),
        metrics: {
          ...maps().metrics,
          account: maps().metrics.revenue,
        },
      }),
    );
    kernels.push(colliding);
    expect(refusal(() => colliding.resolve({ metrics: ["account"], dimensions: ["account"], time: Q })).status).toBe(
      "ambiguous_query",
    );
    expect(refusal(() => k.resolve({ metrics: ["revenue"], order: [{ field: "account", direction: "asc" }], time: Q })).status).toBe(
      "invalid_query",
    );
  });

  it("#32: participating duplicate still refuses; filter-only NULL-measure case stays legal", async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    const path = join(mkdtempSync(join(tmpdir(), "grane-ord-dup-")), "w.duckdb");
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
        project: { name: "ord-dup", timezone: "UTC" },
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

  it("MCP text and kernel rows agree; completeness/trust unchanged by ordering", async () => {
    const { kernel: k } = await makeKernel();
    const query = {
      metrics: ["revenue"],
      dimensions: ["account"],
      order: [{ field: "revenue", direction: "desc" as const }],
      limit: 2,
      time: Q,
    };
    const explained = await k.explain(query);
    expect(explained.generated_sql).toMatch(/ORDER BY "__grane_result"\."revenue" DESC$/);
    const ran = await k.query(query);
    expect(explained.trust).toBe(ran.trust);
    expect(ran.trust).toBe("governed");
    expect(ran.completeness.source).toBe("query");
    const text = mcpTrustText({
      trust: ran.trust,
      columns: ran.columns,
      rows: ran.rows,
      completeness: ran.completeness,
      provenance: ran.provenance,
    });
    expect(text).toMatch(/governed/i);
    expect(JSON.stringify(ran.rows)).toContain("Beta");
  });

  it("CLI --sql shows outer ORDER BY; --json preserves kernel row order", async () => {
    const { path } = await makeKernel();
    const dir = mkdtempSync(join(tmpdir(), "grane-ord-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:\n  name: cli-ord\n  timezone: UTC\nconnection:\n  type: duckdb\n  path: ${JSON.stringify(path)}\n  schema: main\n`,
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
  revenue:
    entity: sale
    type: sum
    sql: "\${sales.amount}"
    time_dimension: "\${sales.sold_on}"
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
    const sql = await run(["query", "revenue", "--dimension", "account", "--from", "2026-01-01", "--to", "2026-12-31", "--sql"]);
    expect(sql.code).toBe(0);
    expect(sql.stdout).toMatch(/ORDER BY "__grane_result"\."revenue" DESC/);
    const json = await run(["query", "revenue", "--dimension", "account", "--from", "2026-01-01", "--to", "2026-12-31", "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as { rows: { account: string; revenue: number }[]; trust: string };
    expect(payload.trust).toBe("governed");
    expect(payload.rows[0]!.account).toBe("Beta");
    expect(n(payload.rows[0]!.revenue)).toBe(100);
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

describe.skipIf(!(await postgresUp()))("final ordering (PostgreSQL)", () => {
  it("top-2 DESC membership and order match the independent oracle", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL });
    const schema = `ord_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    try {
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(`CREATE TABLE sales (id INTEGER, customer_id INTEGER, amount DOUBLE PRECISION, sold_on DATE)`);
      await pool.query(
        `INSERT INTO sales VALUES (1,1,10,DATE '2026-01-15'), (2,3,50,DATE '2026-02-10'), (3,2,100,DATE '2026-03-05'), (4,4,75,DATE '2026-04-20')`,
      );
      await pool.query(`CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, account TEXT)`);
      await pool.query(`INSERT INTO customers VALUES (1,'Acme'), (2,'Beta'), (3,'Cedar'), (4,'Delta')`);
      const k = new GraneKernel(
        graneConfigSchema.parse({
          project: { name: "ord-pg", timezone: "UTC" },
          connection: { type: "postgres", url: PG_URL, schema },
          entities: {
            sale: { table: "sales", primary_key: "id" },
            customer: { table: "customers", primary_key: "customer_id" },
          },
          metrics: {
            revenue: { entity: "sale", type: "sum", sql: "${sales.amount}", time_dimension: "${sales.sold_on}" },
          },
          dimensions: { account: { entity: "customer", sql: "${customers.account}" } },
          relationships: {
            sales_customers: { from: "sales.customer_id", to: "customers.customer_id", type: "many_to_one" },
          },
        }),
      );
      try {
        const r = await k.query({
          metrics: ["revenue"],
          dimensions: ["account"],
          order: [{ field: "revenue", direction: "desc" }],
          limit: 2,
          time: Q,
        });
        expect(r.trust).toBe("governed");
        expect(r.rows.map((row) => [row.account, n(row.revenue)])).toEqual([
          ["Beta", 100],
          ["Delta", 75],
        ]);
        const sql = k.compile({
          metrics: ["revenue"],
          dimensions: ["account"],
          order: [{ field: "revenue", direction: "desc" }],
          limit: 2,
          time: Q,
        }).compiled.sql;
        expect(sql).toMatch(/ORDER BY "__grane_result"\."revenue" DESC$/);
      } finally {
        await k.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
});
