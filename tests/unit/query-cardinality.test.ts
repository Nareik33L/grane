/**
 * Query-scoped cardinality validation — adversarial matrix.
 *
 * Every test verifies the governed invariant: runtime cardinality checks
 * apply to the *logical analytical population* of this execution (fact-side
 * rows after query filters and time bounds, and snapshot selection for
 * semi-additive metrics), not to the entire dimension table.
 *
 * Invariants under test:
 *   A  drop unmatched facts?                               NO
 *   B  multiply participating facts?                       NO
 *   C  unrelated duplicate refuse a safe query?            NO
 *   D  empty / null result bypass a *relevant* violation?  NO
 *   E  validation vs same logical population as execution? YES
 *   F  import-order change governed dimension meaning?     NO  (PR #17 / #18)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { mapMetricFlowGraph } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-join-safety");
const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));

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
  const path = join(mkdtempSync(join(tmpdir(), `grane-card-${name}-`)), "db.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const sql of ddl) await conn.run(sql);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

function kernelFor(path: string): GraneKernel {
  return new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "card-test", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: contribution.entities,
      metrics: contribution.metrics,
      dimensions: contribution.dimensions,
      relationships: contribution.relationships,
      unsupported: contribution.unsupported,
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

function n(v: unknown): number {
  return Number(v);
}

function total(rows: Record<string, unknown>[], col: string): number {
  return rows.reduce((s, r) => s + n(r[col] ?? 0), 0);
}

const available = await duckdbAvailable();

// ─────────────────────────────────────────────────────────────────────────────
// Case A: unreferenced duplicate — no participating FK reaches the dup
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("A: unreferenced duplicate (invariant C — unrelated dup must not refuse)", () => {
  // fct_orders: cust 1 only → dim_customers: 1→Acme (unique), 99→BadA, 99→BadB (dup but never joined)
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100)`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (99, 'BadA', 'SMB', NULL), (99, 'BadB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("a", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("executes governed and returns correct revenue (not refused)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account === "Acme")?.revenue)).toBe(100);
  });

  it("total is preserved (no fact drop)", async () => {
    const r = await kernel.query({ metrics: ["revenue"] });
    expect(n(r.rows[0]?.revenue)).toBe(100);
    expect(r.trust).toBe("governed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case B: fact-filter excludes the FK that reaches the duplicate
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("B: fact-filter excludes the dup FK (invariant C)", () => {
  // cust 1 has channel=web; cust 2 has channel=store and is duplicated in dim
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise'), (2, 2, '2026-01-02', 50, 'store', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'CorpA', 'SMB', NULL), (2, 'CorpB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("b", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("channel=web query governs safely (cust 2 excluded by fact filter)", async () => {
    const r = await kernel.query({
      metrics: ["revenue"],
      filters: [{ field: "channel", operator: "=", value: "web" }],
    });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.revenue)).toBe(100);
  });

  it("channel=store query is refused (cust 2 duplicated and participates)", async () => {
    const refused = await refusal(() =>
      kernel.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "channel", operator: "=", value: "store" }],
      }),
    );
    expect(refused.status).toBe("unsafe_query");
  });

  it("ungrouped channel=store: no join so no guard; governed result", async () => {
    // When querying without grouping by account there is no join to dim_customers.
    const r = await kernel.query({
      metrics: ["revenue"],
      filters: [{ field: "channel", operator: "=", value: "store" }],
    });
    expect(r.trust).toBe("governed");
    expect(n(r.rows[0]?.revenue)).toBe(50);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cases C1/C2/C3: joined dimension filter (WHERE dim.col = X)
// does NOT shrink the cardinality check (the FK still participates)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("C: joined-filter does not shrink cardinality check (invariant D)", () => {
  // cust 1 → EU only (unique); cust 2 → region duplicated
  const DDL_C1 = [
    // cust 2 has two EU rows → filter region=US → 0 final rows but dup still participates
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise'), (2, 2, '2026-01-02', 50, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'Corp', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    // cust 2: two EU rows (dup); cust 1: one EU row
    `INSERT INTO dim_regions VALUES (1, 'EU'), (2, 'EU'), (2, 'EU')`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  const DDL_C2 = [
    // cust 2 has US + EU rows → filter region=US → 1 final row but dup still participates
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise'), (2, 2, '2026-01-02', 50, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'Corp', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `INSERT INTO dim_regions VALUES (1, 'EU'), (2, 'US'), (2, 'EU')`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  const DDL_C3 = [
    // cust 2 has two US rows → filter region=US → 2 final rows, dup participating → must refuse
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise'), (2, 2, '2026-01-02', 50, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'Corp', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `INSERT INTO dim_regions VALUES (1, 'EU'), (2, 'US'), (2, 'US')`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];

  let k1: GraneKernel, k2: GraneKernel, k3: GraneKernel;
  beforeAll(async () => {
    k1 = kernelFor(await buildWarehouse("c1", DDL_C1));
    k2 = kernelFor(await buildWarehouse("c2", DDL_C2));
    k3 = kernelFor(await buildWarehouse("c3", DDL_C3));
  });
  afterAll(async () => {
    await Promise.all([k1?.close(), k2?.close(), k3?.close()]);
  });

  it("C1: cust2 two-EU rows, filter US → 0 results but dup participates → refuse", async () => {
    const refused = await refusal(() =>
      k1.query({ metrics: ["revenue"], dimensions: ["region"], filters: [{ field: "region", operator: "=", value: "US" }] }),
    );
    expect(refused.status).toBe("unsafe_query");
  });

  it("C2: cust2 US+EU, filter US → 1 result but dup participates → refuse", async () => {
    const refused = await refusal(() =>
      k2.query({ metrics: ["revenue"], dimensions: ["region"], filters: [{ field: "region", operator: "=", value: "US" }] }),
    );
    expect(refused.status).toBe("unsafe_query");
  });

  it("C3: cust2 two-US rows, filter US → 2 results → refuse", async () => {
    const refused = await refusal(() =>
      k3.query({ metrics: ["revenue"], dimensions: ["region"], filters: [{ field: "region", operator: "=", value: "US" }] }),
    );
    expect(refused.status).toBe("unsafe_query");
  });

  it("C1/C2/C3: query without the region dimension is safe (no join to dup)", async () => {
    for (const k of [k1, k2, k3]) {
      const r = await k.query({ metrics: ["revenue"] });
      expect(r.trust).toBe("governed");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case D: multi-hop — the dup is in a table not reachable from the participating FKs
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("D: multi-hop unused dup (invariant C)", () => {
  // facts only reach manager 7 (unique); manager 8 is duplicated but never joined
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', 7)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `INSERT INTO dim_managers VALUES (7, 'Alice'), (8, 'Bob1'), (8, 'Bob2')`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("d", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("queries manager_name governed (manager 8 dup never reached)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.manager_name === "Alice")?.revenue)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case E: semi-additive snapshot — historical FKs excluded
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("E: semi-additive snapshot excludes historical-only dup FK (invariant E)", () => {
  // Feb snapshot: only cust 1 (cust 2 is Jan-only, and is duplicated in dim)
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'CorpA', 'SMB', NULL), (2, 'CorpB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
    // cust 1 in both months; cust 2 in Jan only
    `INSERT INTO fct_mrr_snapshot VALUES ('cm1', 1, '2026-01-01', 90, 'Enterprise'), ('cm2', 1, '2026-02-01', 110, 'Enterprise'), ('cm3', 2, '2026-01-01', 50, 'SMB')`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("e", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("Feb-only snapshot governed (cust 2 excluded by snapshot selection, dup not reached)", async () => {
    const r = await kernel.query({
      metrics: ["ending_mrr"],
      dimensions: ["account"],
      time: { from: "2026-02-01", to: "2026-02-28" },
    });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account === "Acme")?.ending_mrr)).toBe(110);
    expect(r.rows.find((x) => x.account === "CorpA" || x.account === "CorpB")).toBeUndefined();
  });

  it("Jan snapshot with dup participating is refused", async () => {
    const refused = await refusal(() =>
      kernel.query({
        metrics: ["ending_mrr"],
        dimensions: ["account"],
        time: { from: "2026-01-01", to: "2026-01-31" },
      }),
    );
    expect(refused.status).toBe("unsafe_query");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cases F/G: empty result holes — the guard must still be checked
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("F/G: empty result holes (invariant D — empty result must not bypass a relevant violation)", () => {
  // cust 1 is duplicated in dim; grouped query with account=Nope → 0 analytic rows.
  // The dup is a participating FK so this must be refused.
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (1, 'AcmeDup', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("fg", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("F: grouped query account=Nope → dup cust1 participates → refuse (not governed empty)", async () => {
    const refused = await refusal(() =>
      kernel.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Nope" }],
      }),
    );
    expect(refused.status).toBe("unsafe_query");
  });

  it("G: scalar query (no dims) with joined dim filter account=Nope → refuse", async () => {
    // Joining dim_customers to filter account=Nope with cust1 duplicated → refuse
    const refused = await refusal(() =>
      kernel.query({
        metrics: ["revenue"],
        filters: [{ field: "account", operator: "=", value: "Nope" }],
      }),
    );
    // This query doesn't join (account filter is on a joined table so no join guard for scalar
    // without a dimension... actually account filter requires the join → guard exists)
    expect(refused.status).toBe("unsafe_query");
  });

  it("H: unique dim → governed empty (account=Nope, no dup)", async () => {
    // Use the non-dup fixture (case A) for this check — unique dim, filter yields 0 rows
    // Reuse fixture B (cust1 unique) for this case.
    const DDL_UNIQUE = [
      `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
      `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
      `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
      `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL)`,
      `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
      `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
      `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
      `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
      `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
    ];
    const k = kernelFor(await buildWarehouse("h", DDL_UNIQUE));
    try {
      const r = await k.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        filters: [{ field: "account", operator: "=", value: "Nope" }],
      });
      expect(r.trust).toBe("governed");
      expect(r.rows).toHaveLength(0);
    } finally {
      await k.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case I: NULL FK — never a duplicate target, safe
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("I: NULL FK never participates in a dup (invariant A)", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, NULL, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (1, 'AcmeDup', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("i", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("NULL FK → no relevant keys → governed (dup in dim irrelevant)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    // The NULL-FK row lands in the NULL group; the dup in dim is unreachable.
    expect(n(r.rows.find((x) => x.account == null)?.revenue)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case J: unmatched FK — not a dup, safe (LEFT JOIN keeps facts, no target rows)
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("J: unmatched FK is not a cardinality violation (invariant A)", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 999, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    // 999 not in dim, but 98 is duplicated (never reached)
    `INSERT INTO dim_customers VALUES (98, 'BadA', 'SMB', NULL), (98, 'BadB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("j", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("unmatched FK → NULL group → governed (98 dup never reached by FK 999)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account == null)?.revenue)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case K: multi-hop — dup at hop 2 but hop-1 key never reaches it
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("K: multi-hop unused dup at hop-2 (invariant C)", () => {
  // cust 1 → manager 7 (unique); manager 8 is duplicated but cust 1's FK never reaches it
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', 7)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `INSERT INTO dim_managers VALUES (7, 'Alice'), (8, 'Bob1'), (8, 'Bob2')`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("k", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("manager_name governed (manager 8 unreachable)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.manager_name === "Alice")?.revenue)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case L: multi-hop — dup at hop 2 that IS reached → refuse
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("L: multi-hop dup at hop-2 that is reached → refuse (invariant B)", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', 7)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    // manager 7 is duplicated
    `INSERT INTO dim_managers VALUES (7, 'Alice1'), (7, 'Alice2')`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("l", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("manager_name refused (manager 7 reached and duplicated)", async () => {
    const refused = await refusal(() =>
      kernel.query({ metrics: ["revenue"], dimensions: ["manager_name"] }),
    );
    expect(refused.status).toBe("unsafe_query");
    expect(refused.message).toMatch(/dim_managers/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case M: two dimensions — one dim unique, other dup but unused
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("M: two dimensions, one unused dup (invariant C)", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `INSERT INTO dim_products VALUES (99, 'X'), (99, 'Y')`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("m", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("account dim governed (products dup unreachable from participating facts)", async () => {
    const r = await kernel.query({ metrics: ["revenue"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account === "Acme")?.revenue)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case N: ratio metric — scoped guard applies normally
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("N: ratio metric with scoped cardinality", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise'), (2, 2, '2026-01-02', 200, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'Corp', 'SMB', NULL), (99, 'BadA', 'SMB', NULL), (99, 'BadB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("n", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("ratio governed (99 dup never reached)", async () => {
    const r = await kernel.query({ metrics: ["revenue_per_order"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account === "Acme")?.revenue_per_order)).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case O: COUNT(1) with scoped guard
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("O: COUNT(1) with scoped cardinality (invariant C)", () => {
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-01', 100, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (99, 'BadA', 'SMB', NULL), (99, 'BadB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("o", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("order_count governed (99 dup unreachable)", async () => {
    const r = await kernel.query({ metrics: ["order_count"], dimensions: ["account"] });
    expect(r.trust).toBe("governed");
    expect(total(r.rows, "order_count")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Case P: time-bounded query — historical dup excluded by time filter
// ─────────────────────────────────────────────────────────────────────────────
describe.skipIf(!available)("P: time-bounded query excludes historical dup FK (invariant E)", () => {
  // Jan: cust 1 (unique in dim). Feb: cust 1 + cust 2 (dup in dim).
  const DDL = [
    `CREATE TABLE fct_orders (order_id INTEGER, customer_id INTEGER, ordered_at DATE, amount DECIMAL, channel VARCHAR, order_segment VARCHAR)`,
    `INSERT INTO fct_orders VALUES (1, 1, '2026-01-15', 100, 'web', 'Enterprise'), (2, 2, '2026-02-15', 50, 'web', 'Enterprise')`,
    `CREATE TABLE dim_customers (customer_id INTEGER, account VARCHAR, segment VARCHAR, manager_id INTEGER)`,
    `INSERT INTO dim_customers VALUES (1, 'Acme', 'SMB', NULL), (2, 'CorpA', 'SMB', NULL), (2, 'CorpB', 'SMB', NULL)`,
    `CREATE TABLE dim_managers (manager_id INTEGER, manager_name VARCHAR)`,
    `CREATE TABLE dim_products (product_id INTEGER, category VARCHAR)`,
    `CREATE TABLE dim_tags (tag_row_id INTEGER, customer_id INTEGER, tag VARCHAR)`,
    `CREATE TABLE dim_regions (customer_id INTEGER, region VARCHAR)`,
    `CREATE TABLE fct_mrr_snapshot (customer_month_id VARCHAR, customer_id INTEGER, month_start DATE, mrr DECIMAL, snapshot_segment VARCHAR)`,
  ];
  let kernel: GraneKernel;
  beforeAll(async () => { kernel = kernelFor(await buildWarehouse("p", DDL)); });
  afterAll(async () => { await kernel?.close(); });

  it("Jan query governed (cust 2 not in Jan, dup not reached)", async () => {
    const r = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["account"],
      time: { from: "2026-01-01", to: "2026-01-31" },
    });
    expect(r.trust).toBe("governed");
    expect(n(r.rows.find((x) => x.account === "Acme")?.revenue)).toBe(100);
  });

  it("Feb query refused (cust 2 participates, dup)", async () => {
    const refused = await refusal(() =>
      kernel.query({
        metrics: ["revenue"],
        dimensions: ["account"],
        time: { from: "2026-02-01", to: "2026-02-28" },
      }),
    );
    expect(refused.status).toBe("unsafe_query");
  });
});
