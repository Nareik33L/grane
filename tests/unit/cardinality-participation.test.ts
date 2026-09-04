/**
 * Cardinality participation (PR #32).
 *
 * Recurring PR #18 finding `guard-dups-outside-filter-population` was the
 * C1/C2 joined-filter corpus: duplicates that fail the same-table predicate
 * were treated as participating. Independent oracle: JOIN + WHERE keeps at
 * most as many copies as matching target rows. Same-table filters now
 * constrain P(n) of that table; P0 is not shrunk.
 *
 * NULL-measure false refusal is removable only when no selected output comes
 * from a joined table. COUNT(*) and joined group-by keep every qualifying
 * row. Remaining later-hop-filter / metric-FILTER cases stay conservative.
 */
import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mcpTrustText } from "../../src/query/trust.js";
import { CONTRIB_CTE, POP_CTE } from "../../src/compile/compiler.js";

const execFileAsync = promisify(execFile);

type Row = Array<string | number | null>;
interface Data {
  orders?: Row[];
  customers?: Row[];
  managers?: Row[];
  regions?: Row[];
  products?: Row[];
  balances?: Row[];
}

const DDL: Record<keyof Data, string> = {
  orders: `CREATE TABLE orders (id INTEGER, customer_id INTEGER, product_id INTEGER, status VARCHAR, ordered_at DATE, amount DECIMAL(18,2), channel VARCHAR)`,
  customers: `CREATE TABLE customers (id INTEGER, name VARCHAR, segment VARCHAR, country VARCHAR, manager_id INTEGER)`,
  managers: `CREATE TABLE managers (id INTEGER, name VARCHAR, region_id INTEGER)`,
  regions: `CREATE TABLE regions (id INTEGER, name VARCHAR)`,
  products: `CREATE TABLE products (id INTEGER, category VARCHAR)`,
  balances: `CREATE TABLE balances (id INTEGER, customer_id INTEGER, as_of DATE, balance DECIMAL(18,2), kind VARCHAR)`,
};

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

function literal(value: string | number | null): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

async function scenario(data: Data): Promise<{ kernel: GraneKernel; path: string }> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-part-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const table of Object.keys(DDL) as Array<keyof Data>) {
    await conn.run(DDL[table]);
    const rows = data[table] ?? [];
    if (rows.length > 0) {
      await conn.run(`INSERT INTO ${table} VALUES ${rows.map((r) => `(${r.map(literal).join(", ")})`).join(", ")}`);
    }
  }
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  const kernel = new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "participation", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: {
        order: { table: "orders", primary_key: "id" },
        customer: { table: "customers", primary_key: "id" },
        manager: { table: "managers", primary_key: "id" },
        region: { table: "regions", primary_key: "id" },
        product: { table: "products", primary_key: "id" },
        balance: { table: "balances", primary_key: "id" },
      },
      metrics: {
        revenue: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        order_count: { entity: "order", type: "count", time_dimension: "${orders.ordered_at}" },
        amount_count: { entity: "order", type: "count", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        distinct_customers: {
          entity: "order",
          type: "count_distinct",
          sql: "${orders.customer_id}",
          time_dimension: "${orders.ordered_at}",
        },
        avg_amount: { entity: "order", type: "avg", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        min_amount: { entity: "order", type: "min", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        max_amount: { entity: "order", type: "max", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        completed_revenue: {
          entity: "order",
          type: "sum",
          sql: "${orders.amount}",
          time_dimension: "${orders.ordered_at}",
          filters: { "orders.status": "complete" },
        },
        pending_revenue: {
          entity: "order",
          type: "sum",
          sql: "${orders.amount}",
          time_dimension: "${orders.ordered_at}",
          filters: { "orders.status": "pending" },
        },
        uk_revenue: {
          entity: "order",
          type: "sum",
          sql: "${orders.amount}",
          time_dimension: "${orders.ordered_at}",
          filters: { "customers.country": "UK" },
        },
        completion_rate: { entity: "order", type: "ratio", numerator: "completed_revenue", denominator: "revenue" },
        ending_balance: {
          entity: "balance",
          type: "sum",
          sql: "${balances.balance}",
          time_dimension: "${balances.as_of}",
          additive: "semi",
          semi_additive: { window: "last", group_by: ["${balances.customer_id}"] },
        },
      },
      dimensions: {
        channel: { entity: "order", sql: "${orders.channel}" },
        status: { entity: "order", sql: "${orders.status}" },
        account: { entity: "customer", sql: "${customers.name}" },
        segment: { entity: "customer", sql: "${customers.segment}" },
        country: { entity: "customer", sql: "${customers.country}" },
        manager_name: { entity: "manager", sql: "${managers.name}" },
        region_name: { entity: "region", sql: "${regions.name}" },
        category: { entity: "product", sql: "${products.category}" },
      },
      relationships: {
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        orders_products: { from: "orders.product_id", to: "products.id", type: "many_to_one" },
        customers_managers: { from: "customers.manager_id", to: "managers.id", type: "many_to_one" },
        managers_regions: { from: "managers.region_id", to: "regions.id", type: "many_to_one" },
        balances_customers: { from: "balances.customer_id", to: "customers.id", type: "many_to_one" },
      },
    }),
  );
  kernels.push(kernel);
  return { kernel, path };
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

const n = (v: unknown): number => Number(v);

// Building blocks
// 1 Acme UK unique Maya UK   complete Jan web 100
// 2 Corp US dup   Ravi US    pending Feb store 50
// 3 Null UK+FR dup           complete Jan web NULL
// 4 Zero UK unique           complete Jan web 0
const ORDERS: Row[] = [
  [1, 1, 10, "complete", "2026-01-10", 100, "web"],
  [2, 2, 11, "pending", "2026-02-10", 50, "store"],
  [3, 3, 10, "complete", "2026-01-11", null, "web"],
  [4, 4, 10, "complete", "2026-01-12", 0, "web"],
];
const CUSTOMERS: Row[] = [
  [1, "Acme", "SMB", "UK", 7],
  [2, "CorpA", "ENT", "US", 8],
  [2, "CorpB", "MM", "US", 8],
  [3, "NullA", "SMB", "UK", 7],
  [3, "NullB", "SMB", "FR", 7],
  [4, "Zero", "SMB", "UK", 7],
];
const MANAGERS: Row[] = [
  [7, "Maya", 1],
  [8, "Ravi", 2],
];
const REGIONS: Row[] = [
  [1, "UK"],
  [2, "US"],
];
const PRODUCTS: Row[] = [
  [10, "Hardware"],
  [11, "Software"],
];

const BASE = { orders: ORDERS, customers: CUSTOMERS, managers: MANAGERS, regions: REGIONS, products: PRODUCTS };

describe.skipIf(!available)("query-filter population (recurring C1/C2/C3)", () => {
  it("duplicates that fail the same-table predicate execute; copies that survive refuse", async () => {
    const { kernel: k, path } = await scenario(BASE);
    const outside = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    });
    expect(outside.trust).toBe("governed");
    expect(outside.rows).toHaveLength(1);
    expect(n(outside.rows[0]?.revenue)).toBe(100);
    const sql = k.compile({
      metrics: ["revenue"],
      dimensions: ["account"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    }).compiled.sql;
    expect(sql).toMatch(/__grane_reach_customers[\s\S]*AND "customers"\."name" = /);
    expect(sql).not.toMatch(/SELECT DISTINCT/i);

    const inside = await refusal(() =>
      k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "country", operator: "=", value: "US" }],
      }),
    );
    expect(inside.status).toBe("unsafe_query");
    expect(inside.message).toMatch(/customers/);

    const unfiltered = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
    expect(unfiltered.status).toBe("unsafe_query");
    void path;
  });

  it("filter-only joined dimension (no selected join column) follows the same P(n) rule", async () => {
    const { kernel: k } = await scenario(BASE);
    const acme = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    });
    expect(acme.trust).toBe("governed");
    expect(n(acme.rows[0]?.revenue)).toBe(100);
    const corp = await refusal(() =>
      k.query({ metrics: ["revenue"], filters: [{ field: "country", operator: "=", value: "US" }] }),
    );
    expect(corp.status).toBe("unsafe_query");
  });

  it("a later-hop filter does not hide a first-hop duplicate (intentional remainder)", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await refusal(() =>
      k.query({
        metrics: ["revenue"],
        dimensions: ["manager_name"],
        filters: [{ field: "region_name", operator: "=", value: "UK" }],
      }),
    );
    expect(r.status).toBe("unsafe_query");
  });
});

describe.skipIf(!available)("NULL-measure participation", () => {
  it("NULL SUM + selected joined dimension with distinct values refuses (extra groups)", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
    const seg = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["segment"] }));
    expect(seg.status).toBe("unsafe_query");
  });

  it("NULL SUM + identical selected joined values still refuses (no target dedupe)", async () => {
    const { kernel: k } = await scenario({
      ...BASE,
      customers: [
        [1, "Acme", "SMB", "UK", 7],
        [3, "Null", "SMB", "UK", 7],
        [3, "Null", "SMB", "UK", 7],
        [4, "Zero", "SMB", "UK", 7],
      ],
    });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
  });

  it("NULL SUM without joined output: duplicate only on the NULL fact does not refuse", async () => {
    const { kernel: k } = await scenario({
      orders: [
        [1, 1, 10, "complete", "2026-01-10", 100, "web"],
        [3, 3, 10, "complete", "2026-01-11", null, "web"],
      ],
      customers: [
        [1, "Acme", "SMB", "UK", 7],
        [3, "NullA", "SMB", "UK", 7],
        [3, "NullB", "SMB", "FR", 7],
      ],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
    });
    const q = {
      metrics: ["revenue"],
      dimensions: ["status"],
      filters: [{ field: "country", operator: "=", value: "UK" }],
    };
    const groupedBase = await k.query(q);
    expect(groupedBase.trust).toBe("governed");
    expect(n(groupedBase.rows[0]?.revenue)).toBe(100);
    const filtered = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    });
    expect(filtered.trust).toBe("governed");
    expect(n(filtered.rows[0]?.revenue)).toBe(100);
    const compiled = k.compile(q).compiled;
    expect(compiled.sql).toMatch(/"orders"\."amount" IS NOT NULL/);
    expect(compiled.plan.population.contributing).toBe(CONTRIB_CTE);
  });

  it("COUNT(*) never treats a NULL measure row as irrelevant", async () => {
    const { kernel: k } = await scenario({
      orders: [
        [1, 1, 10, "complete", "2026-01-10", 100, "web"],
        [3, 3, 10, "complete", "2026-01-11", null, "web"],
      ],
      customers: [
        [1, "Acme", "SMB", "UK", 7],
        [3, "NullA", "SMB", "UK", 7],
        [3, "NullB", "SMB", "FR", 7],
      ],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
    });
    const r = await refusal(() => k.query({ metrics: ["order_count"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
    const sql = k.compile({ metrics: ["order_count"], dimensions: ["status"] }).compiled.sql;
    expect(sql).not.toMatch(/"orders"\."amount" IS NOT NULL/);
  });

  it("COUNT(column) / COUNT DISTINCT / AVG / MIN / MAX keep joined-group NULL rows in P0", async () => {
    const { kernel: k } = await scenario(BASE);
    for (const metric of ["amount_count", "distinct_customers", "avg_amount", "min_amount", "max_amount"]) {
      const r = await refusal(() => k.query({ metrics: [metric], dimensions: ["account"] }));
      expect(r.status, metric).toBe("unsafe_query");
    }
  });

  it("#27 all-NULL group with a unique target survives (not deleted as a cardinality fix)", async () => {
    const { kernel: k } = await scenario({
      orders: [
        [1, 1, 10, "complete", "2026-01-10", null, "web"],
        [2, 2, 10, "complete", "2026-01-11", 50, "web"],
      ],
      customers: [
        [1, "NullOnly", "SMB", "UK", 7],
        [2, "Acme", "SMB", "UK", 7],
      ],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    const nullGroup = r.rows.find((row) => row.account === "NullOnly");
    expect(nullGroup).toBeDefined();
    expect(nullGroup?.revenue).toBeNull();
    expect(n(r.rows.find((row) => row.account === "Acme")?.revenue)).toBe(50);
  });
});

describe.skipIf(!available)("metric-definition filters, ratios, multi-metric", () => {
  it("base-table metric filter excludes the pending duplicate from completed_revenue", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await k.query({ metrics: ["completed_revenue"], dimensions: ["channel"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.channel === "web")?.completed_revenue)).toBe(100);
    const pending = await refusal(() => k.query({ metrics: ["pending_revenue"], dimensions: ["account"] }));
    expect(pending.status).toBe("unsafe_query");
    const both = await refusal(() =>
      k.query({ metrics: ["completed_revenue", "pending_revenue"], dimensions: ["account"] }),
    );
    expect(both.status).toBe("unsafe_query");
  });

  it("joined metric-definition FILTER does not shrink P(n) (groups still exist)", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await refusal(() => k.query({ metrics: ["uk_revenue"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
    // Ungrouped: FILTER is not WHERE, so Corp's US duplicates still sit in P(n).
    const ungrouped = await refusal(() => k.query({ metrics: ["uk_revenue"] }));
    expect(ungrouped.status).toBe("unsafe_query");
  });

  it("ratio participation is the union of numerator and denominator", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await refusal(() => k.query({ metrics: ["completion_rate"], dimensions: ["account"] }));
    expect(r.status).toBe("unsafe_query");
    const numOnly = await k.query({ metrics: ["completed_revenue"], dimensions: ["channel"] });
    expect(numOnly.trust).toBe("governed");
  });

  it("#31 query filter naming a metric remains invalid_query", async () => {
    const { kernel: k } = await scenario(BASE);
    const r = await refusal(() =>
      k.query({
        metrics: ["revenue"],
        filters: [{ field: "revenue", operator: ">", value: 0 }],
      }),
    );
    expect(r.status).toBe("invalid_query");
    expect(r.message).not.toMatch(/Binder Error/i);
  });

  it("#30 metric + dimension sharing a public name is ambiguous_query", async () => {
    const { kernel: k } = await scenario(BASE);
    const colliding = new GraneKernel(
      graneConfigSchema.parse({
        ...k.config,
        metrics: {
          ...k.config.metrics,
          account: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
        },
      }),
    );
    kernels.push(colliding);
    const r = await refusal(() => colliding.query({ metrics: ["account"], dimensions: ["account"] }));
    expect(r.status).toBe("ambiguous_query");
  });
});

describe.skipIf(!available)("time, multi-hop, LEFT JOIN, semi-additive", () => {
  it("time-excluded duplicate does not refuse; in-range duplicate does", async () => {
    const { kernel: k } = await scenario({
      orders: [
        [1, 1, 10, "complete", "2026-01-10", 100, "web"],
        [2, 2, 11, "pending", "2026-02-10", 50, "store"],
      ],
      customers: [
        [1, "Acme", "SMB", "UK", 7],
        [2, "CorpA", "ENT", "US", 8],
        [2, "CorpB", "MM", "US", 8],
      ],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
    });
    const jan = await k.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      time: { from: "2026-01-01", to: "2026-01-31" },
    });
    expect(jan.trust).toBe("governed");
    expect(n(jan.rows[0]?.revenue)).toBe(100);
    const feb = await refusal(() =>
      k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        time: { from: "2026-02-01", to: "2026-02-28" },
      }),
    );
    expect(feb.status).toBe("unsafe_query");
  });

  it("later-hop duplicate refuses even when hop-1 is unique", async () => {
    const { kernel: k } = await scenario({
      orders: [[1, 1, 10, "complete", "2026-01-10", 100, "web"]],
      customers: [[1, "Acme", "SMB", "UK", 7]],
      managers: [
        [7, "Maya", 1],
        [7, "MayaDup", 1],
      ],
      regions: REGIONS,
      products: PRODUCTS,
    });
    const r = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["manager_name"] }));
    expect(r.status).toBe("unsafe_query");
  });

  it("unmatched LEFT JOIN fact stays in the NULL group", async () => {
    const { kernel: k } = await scenario({
      orders: [
        [1, 1, 10, "complete", "2026-01-10", 100, "web"],
        [9, 99, 10, "complete", "2026-01-10", 5, "web"],
      ],
      customers: [[1, "Acme", "SMB", "UK", 7]],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
    });
    const r = await k.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((row) => row.account === "Acme")?.revenue)).toBe(100);
    expect(n(r.rows.find((row) => row.account == null)?.revenue)).toBe(5);
  });

  it("semi-additive snapshot excludes historical-only duplicates", async () => {
    const { kernel: k } = await scenario({
      orders: ORDERS,
      customers: [
        [1, "Acme", "SMB", "UK", 7],
        [2, "CorpA", "ENT", "US", 8],
        [2, "CorpB", "MM", "US", 8],
      ],
      managers: MANAGERS,
      regions: REGIONS,
      products: PRODUCTS,
      balances: [
        [1, 1, "2026-01-31", 110, "active"],
        [2, 1, "2026-02-28", 130, "active"],
        [3, 2, "2026-01-31", 50, "active"],
      ],
    });
    const feb = await k.query({
      metrics: ["ending_balance"],
      dimensions: ["account"],
      time: { from: "2026-02-01", to: "2026-02-28" },
    });
    expect(feb.trust).toBe("governed");
    expect(n(feb.rows.find((row) => row.account === "Acme")?.ending_balance)).toBe(130);
    const jan = await refusal(() =>
      k.query({
        metrics: ["ending_balance"],
        dimensions: ["account"],
        time: { from: "2026-01-01", to: "2026-01-31" },
      }),
    );
    expect(jan.status).toBe("unsafe_query");
  });
});

describe.skipIf(!available)("resolve / compile / explain / execute / MCP / CLI", () => {
  it("surfaces agree on a participating duplicate (refuse) and a provably irrelevant duplicate (governed)", async () => {
    const { kernel: k, path } = await scenario(BASE);
    const inside = {
      metrics: ["revenue"],
      dimensions: ["account"] as string[],
    };
    const outside = {
      metrics: ["revenue"],
      dimensions: ["account"] as string[],
      filters: [{ field: "account", operator: "=", value: "Acme" }],
    };
    // Compile / explain emit the guard; they do not execute it.
    const compiledInside = k.compile(inside).compiled;
    expect(compiledInside.trust).toBe("governed");
    expect(compiledInside.guards.length).toBeGreaterThan(0);
    expect(compiledInside.sql).not.toMatch(/SELECT DISTINCT/i);
    const explainedInside = await k.explain(inside);
    expect(explainedInside.trust).toBe("governed");
    const queryInside = await refusal(() => k.query(inside));
    expect(queryInside.status).toBe("unsafe_query");
    expect(queryInside.message).toMatch(/many_to_one|duplicat|cardinal/i);
    expect(queryInside.message).not.toMatch(/Binder Error/i);

    const compiled = k.compile(outside).compiled;
    expect(compiled.trust).toBe("governed");
    expect(compiled.sql).not.toMatch(/SELECT DISTINCT/i);
    const explained = await k.explain(outside);
    const ran = await k.query(outside);
    expect(explained.trust).toBe(ran.trust);
    expect(ran.trust).toBe("governed");
    expect(ran.completeness.status).toBe("complete");
    expect(n(ran.rows[0]?.revenue)).toBe(100);
    const text = mcpTrustText({
      trust: ran.trust,
      columns: ran.columns,
      rows: ran.rows,
      completeness: ran.completeness,
      provenance: ran.provenance,
    });
    expect(text).toMatch(/governed/i);

    const dir = mkdtempSync(join(tmpdir(), "grane-part-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:\n  name: cli-part\n  timezone: UTC\nconnection:\n  type: duckdb\n  path: ${JSON.stringify(path)}\n  schema: main\n`,
    );
    writeFileSync(
      join(dir, "model.yml"),
      `entities:
  order:
    table: orders
    primary_key: id
  customer:
    table: customers
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
    time_dimension: "\${orders.ordered_at}"
dimensions:
  account:
    entity: customer
    sql: "\${customers.name}"
relationships:
  orders_customers:
    from: orders.customer_id
    to: customers.id
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
    const sql = await run(["query", "revenue", "--dimension", "account", "--sql"]);
    expect(sql.code).toBe(0);
    expect(sql.stdout).toMatch(/__grane_card/);
    const execDup = await run(["query", "revenue", "--dimension", "account", "--json"]);
    expect(execDup.code).not.toBe(0);
    expect(execDup.stderr + execDup.stdout).toMatch(/ERROR \(unsafe_query\)/);
    const ok = await run(["query", "revenue", "--dimension", "account", "--filter", "account=Acme", "--json"]);
    expect(ok.code).toBe(0);
    const payload = JSON.parse(ok.stdout) as { rows: { revenue: number }[]; trust: string };
    expect(payload.trust).toBe("governed");
    expect(n(payload.rows[0]!.revenue)).toBe(100);
  });

  it("legal guarded SQL compiles on every dialect", () => {
    const cfg = graneConfigSchema.parse({
      project: { name: "participation", timezone: "UTC" },
      connection: { type: "postgres", schema: "public" },
      entities: {
        order: { table: "orders", primary_key: "id" },
        customer: { table: "customers", primary_key: "id" },
      },
      metrics: {
        revenue: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
      },
      dimensions: { account: { entity: "customer", sql: "${customers.name}" } },
      relationships: {
        orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    });
    const k = new GraneKernel(cfg);
    for (const type of WAREHOUSE_TYPES) {
      k.config.connection.type = type;
      if (type === "bigquery") {
        k.config.connection.project = "acme";
        k.config.connection.dataset = "analytics";
      }
      if (type === "mysql") {
        k.config.connection.schema = "shop";
      }
      if (type === "duckdb") {
        k.config.connection.schema = "main";
      }
      if (type === "databricks") {
        k.config.connection.catalog = "main";
        k.config.connection.schema = "main";
      }
      const { compiled } = k.compile({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Acme" }],
        time: { from: "2026-01-01", to: "2026-01-31" },
      });
      expect(compiled.sql, type).toMatch(/__grane_reach_customers/);
      expect(compiled.sql, type).not.toMatch(/SELECT DISTINCT/i);
      expect(compiled.plan.population.analytical).toBe(POP_CTE);
    }
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

describe.skipIf(!(await postgresUp()))("cardinality participation (PostgreSQL)", () => {
  it("same-table filter executes; inside-filter duplicate refuses", async () => {
    const pool = new pg.Pool({ connectionString: PG_URL });
    const schema = `part_${Date.now().toString(36)}`;
    await pool.query(`CREATE SCHEMA ${schema}`);
    try {
      await pool.query(`SET search_path TO ${schema}`);
      await pool.query(`CREATE TABLE orders (id INTEGER, customer_id INTEGER, status TEXT, ordered_at DATE, amount DOUBLE PRECISION)`);
      await pool.query(`INSERT INTO orders VALUES (1, 1, 'complete', DATE '2026-01-10', 100), (2, 2, 'pending', DATE '2026-02-10', 50)`);
      await pool.query(`CREATE TABLE customers (id INTEGER, name TEXT)`);
      await pool.query(`INSERT INTO customers VALUES (1, 'Acme'), (2, 'CorpA'), (2, 'CorpB')`);
      const k = new GraneKernel(
        graneConfigSchema.parse({
          project: { name: "part-pg", timezone: "UTC" },
          connection: { type: "postgres", url: PG_URL, schema },
          entities: {
            order: { table: "orders", primary_key: "id" },
            customer: { table: "customers", primary_key: "id" },
          },
          metrics: {
            revenue: { entity: "order", type: "sum", sql: "${orders.amount}", time_dimension: "${orders.ordered_at}" },
          },
          dimensions: { account: { entity: "customer", sql: "${customers.name}" } },
          relationships: {
            orders_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
          },
        }),
      );
      try {
        const ok = await k.query({
          metrics: ["revenue"],
          dimensions: ["account"],
          filters: [{ field: "account", operator: "=", value: "Acme" }],
        });
        expect(ok.trust).toBe("governed");
        expect(n(ok.rows[0]?.revenue)).toBe(100);
        const bad = await refusal(() => k.query({ metrics: ["revenue"], dimensions: ["account"] }));
        expect(bad.status).toBe("unsafe_query");
      } finally {
        await k.close();
      }
    } finally {
      await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    }
  });
});
