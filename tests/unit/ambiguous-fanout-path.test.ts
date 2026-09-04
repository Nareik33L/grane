/**
 * Ambiguous fan-out measure paths must refuse. YAML declaration order is not
 * a semantic discriminator. A unique fan-out path remains governed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { SemanticModel } from "../../src/model/model.js";
import { pathIdentity } from "../../src/model/graph.js";
import { validateModel } from "../../src/validate/validate.js";
import { gauntletConfig } from "../gauntlet/model.js";
import { exampleKernel } from "../fixtures.js";
import {
  PATH_DDL,
  combinedBugConfig,
  disconnectedMeasureConfig,
  dualFanoutConfig,
  oneSafePlusInvalidConfig,
  uniqueFanoutConfig,
} from "../helpers/path-null-fixtures.js";
import {
  ensureReadonlyRole,
  grantReadonlyOnSchema,
  newCertSchema,
  postgresLiveEnv,
} from "../helpers/postgres-live.js";

const execFileAsync = promisify(execFile);

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

function expectAmbiguousMeasure(refusal: GraneError["refusal"]) {
  expect(refusal.status).toBe("ambiguous_query");
  expect(refusal.message).toMatch(/multiple relationship paths/);
  expect(refusal.message).toMatch(/items/);
  expect(refusal.message).toMatch(/shipments/);
  expect(refusal.message).toMatch(/products/);
  expect(refusal.message).not.toMatch(/BFS|breadth-first|lexicograph/i);
  expect(refusal.message).toMatch(/YAML declaration order is not a semantic discriminator/);
}

function expectSurfacesRefuse(k: GraneKernel, input: Record<string, unknown>, status: string) {
  expect(refusal(() => k.resolve(input as never)).status).toBe(status);
  expect(refusal(() => k.compile(input as never)).status).toBe(status);
}

async function expectAllQuerySurfacesRefuse(k: GraneKernel, input: Record<string, unknown>, status: string) {
  expectSurfacesRefuse(k, input, status);
  expect((await refusalAsync(() => k.explain(input as never))).status).toBe(status);
  expect((await refusalAsync(() => k.query(input as never))).status).toBe(status);
}

async function loadDuck(ddl: string[]): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-path-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const stmt of ddl) await conn.run(stmt);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

describe("ambiguous fan-out measure path (structural)", () => {
  it("P-A1 / P-A2: reversed YAML order yields identical ambiguous_query", () => {
    const a = new SemanticModel(dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    const b = new SemanticModel(dualFanoutConfig("shipments-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    const pa = a.graph.findPath("orders", "products");
    const pb = b.graph.findPath("orders", "products");
    expect(pa?.fanningAmbiguous).toBe(true);
    expect(pb?.fanningAmbiguous).toBe(true);
    expect(pa?.ambiguous).not.toBe(true);
    expect(pb?.ambiguous).not.toBe(true);
    expect(pa?.alternatives?.length).toBeGreaterThanOrEqual(2);
    expect(pb?.alternatives?.length).toBeGreaterThanOrEqual(2);
    const idsA = new Set(pa!.alternatives);
    const idsB = new Set(pb!.alternatives);
    expect(idsA).toEqual(idsB);
    const ka = new GraneKernel(a.config);
    const kb = new GraneKernel(b.config);
    const ra = refusal(() => ka.resolve({ metrics: ["product_weight"] }));
    const rb = refusal(() => kb.resolve({ metrics: ["product_weight"] }));
    expectAmbiguousMeasure(ra);
    expectAmbiguousMeasure(rb);
    expect(ra.status).toBe(rb.status);
  });

  it("path identity distinguishes items vs shipments routes to the same table", () => {
    const model = new SemanticModel(
      dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }),
    );
    const path = model.graph.findPath("orders", "products");
    expect(path?.fanningAmbiguous).toBe(true);
    expect(path?.ambiguous).not.toBe(true);
    expect(path?.alternatives?.some((s) => s.includes("items"))).toBe(true);
    expect(path?.alternatives?.some((s) => s.includes("shipments"))).toBe(true);
    expect(path?.alternatives?.some((s) => s.includes("items.product_id"))).toBe(true);
    expect(path?.alternatives?.some((s) => s.includes("shipments.product_id"))).toBe(true);
    const marked = pathIdentity(path!);
    expect(marked.length).toBeGreaterThan(0);
  });

  it("P-A4: existing two-safe-path ambiguity (orders → countries) still refuses", () => {
    const kernel = new GraneKernel(gauntletConfig());
    kernel.setSchema({
      schemaName: "main",
      tables: [
        {
          schema: "main",
          name: "countries",
          columns: [
            { name: "id", dataType: "INTEGER", nullable: true },
            { name: "name", dataType: "VARCHAR", nullable: true },
          ],
        },
        {
          schema: "main",
          name: "orders",
          columns: [
            { name: "id", dataType: "INTEGER", nullable: true },
            { name: "completed_at", dataType: "TIMESTAMP", nullable: true },
            { name: "status", dataType: "VARCHAR", nullable: true },
            { name: "net_amount", dataType: "NUMERIC", nullable: true },
          ],
        },
      ],
      foreignKeys: [],
    });
    const path = kernel.model.graph.findPath("orders", "countries");
    expect(path?.ambiguous).toBe(true);
    expect(path?.fansOut).toBe(false);
    const r = refusal(() => kernel.compile({ metrics: ["revenue"], raw_dimensions: ["countries.name"] }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.message).toMatch(/customers/);
    expect(r.message).toMatch(/billing_addresses|shipping_addresses/);
  });

  it("P-A5: disconnected measure keeps the existing unreachable refusal", () => {
    const k = new GraneKernel(disconnectedMeasureConfig({ type: "duckdb", path: ":memory:", schema: "main" }));
    const r = refusal(() => k.resolve({ metrics: ["ghost_weight"] }));
    expect(r.status).toBe("invalid_query");
    expect(r.message).toMatch(/No relationship path/);
  });

  it("one safe + one invalid (unrelated) route does not create false ambiguity", () => {
    const k = new GraneKernel(oneSafePlusInvalidConfig({ type: "duckdb", path: ":memory:", schema: "main" }));
    const path = k.model.graph.findPath("orders", "products");
    expect(path?.ambiguous).not.toBe(true);
    expect(path?.fanningAmbiguous).not.toBe(true);
    expect(path?.fansOut).toBe(true);
  });

  it("P-A6: supported companion cannot launder an ambiguous metric", () => {
    const k = new GraneKernel(dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    const r = refusal(() => k.resolve({ metrics: ["order_count", "product_weight"] }));
    expectAmbiguousMeasure(r);
  });

  it("P-A7: ratio whose component needs an ambiguous path refuses the whole request", () => {
    const k = new GraneKernel(dualFanoutConfig("shipments-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    const r = refusal(() => k.resolve({ metrics: ["weight_per_order"] }));
    expectAmbiguousMeasure(r);
  });

  it("P-A8: row filters do not become path selectors", () => {
    const k = new GraneKernel(dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    expectAmbiguousMeasure(refusal(() => k.resolve({ metrics: ["product_weight"] })));
    expectAmbiguousMeasure(
      refusal(() => k.resolve({ metrics: ["product_weight"], filters: [{ field: "order_id", operator: "=", value: 1 }] })),
    );
    expectAmbiguousMeasure(refusal(() => k.resolve({ metrics: ["filtered_weight"] })));
  });

  it("multiple fanning routes to a dimension stay unsafe_query (not query-effective ambiguity)", () => {
    const k = new GraneKernel(
      dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }, {
        dimensions: {
          order_id: { entity: "order", sql: "${orders.id}" },
          product_wt: { entity: "product", sql: "${products.weight}" },
        },
      }),
    );
    const r = refusal(() => k.compile({ metrics: ["order_count"], dimensions: ["product_wt"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/one_to_many|fan out/i);
  });

  it("does not solve ambiguity with mixed or exploratory trust", () => {
    const k = new GraneKernel(dualFanoutConfig("items-first", { type: "duckdb", path: ":memory:", schema: "main" }));
    const r = refusal(() => k.compile({ metrics: ["product_weight"] }));
    expect(r.status).toBe("ambiguous_query");
    expect(r.status).not.toBe("invalid_query");
  });

  it("model validate flags the ambiguous measure path", () => {
    const model = new SemanticModel(dualFanoutConfig("items-first", { type: "postgres", schema: "public" }));
    const report = validateModel(model);
    const metric = report.metrics.find((m) => m.metric === "product_weight");
    expect(metric?.ok).toBe(false);
    expect(metric?.issues.some((i) => i.code === "ambiguous_relationship")).toBe(true);
  });

  it("unique fan-out config is not marked ambiguous", () => {
    const model = new SemanticModel(uniqueFanoutConfig({ type: "duckdb", path: ":memory:", schema: "main" }));
    const path = model.graph.findPath("orders", "shipping_costs");
    expect(path?.ambiguous).not.toBe(true);
    expect(path?.fanningAmbiguous).not.toBe(true);
    expect(path?.fansOut).toBe(true);
  });
});

describe.skipIf(!duckOk)("ambiguous fan-out measure path (DuckDB live)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    path = await loadDuck(PATH_DDL);
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(order: "items-first" | "shipments-first"): GraneKernel {
    const k = new GraneKernel(dualFanoutConfig(order, { type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    return k;
  }

  it("P-A10: dual fan-out refuses on DuckDB before SQL", async () => {
    const k = kernel("items-first");
    await expectAllQuerySurfacesRefuse(k, { metrics: ["product_weight"] }, "ambiguous_query");
  });

  it("reversed YAML order also refuses on DuckDB", async () => {
    const k = kernel("shipments-first");
    await expectAllQuerySurfacesRefuse(k, { metrics: ["product_weight"] }, "ambiguous_query");
  });

  it("P-A3: unique fan-out path is governed and matches the independent oracle", async () => {
    const k = new GraneKernel(uniqueFanoutConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    const result = await k.query({ metrics: ["shipping_cost"] });
    expect(result.trust).toBe("governed");
    expect(result.completeness.status).toBe("complete");
    expect(Number(result.rows[0]!.shipping_cost)).toBe(7.5);
    expect(result.provenance.generated_sql).toMatch(/shipments/);
    expect(result.provenance.generated_sql).toMatch(/shipping_costs/);
    expect(result.provenance.generated_sql).not.toMatch(/"items"/);
  });

  it("one unique items→products fan-out remains governed 2.5", async () => {
    const k = new GraneKernel(oneSafePlusInvalidConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    const result = await k.query({ metrics: ["product_weight"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.product_weight)).toBe(2.5);
  });

  it("combined: ambiguous path + JSON null filter refuses with no SQL", async () => {
    const k = new GraneKernel(combinedBugConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    const r = await refusalAsync(() =>
      k.query({
        metrics: ["product_weight"],
        filters: [{ field: "order_id", operator: "=", value: null }],
      }),
    );
    expect(["ambiguous_query", "invalid_query"]).toContain(r.status);
    expect(r.message).not.toMatch(/Cannot create values of type ANY/i);
  });

  it("all-eight-dialect valid unique-fanout compile inspect", () => {
    const k = new GraneKernel(uniqueFanoutConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    for (const type of WAREHOUSE_TYPES) {
      k.config.connection.type = type;
      if (type === "bigquery") {
        k.config.connection.project = "acme";
        k.config.connection.dataset = "analytics";
        k.config.connection.schema = undefined;
      }
      if (type === "mysql") k.config.connection.schema = "shop";
      if (type === "databricks") {
        k.config.connection.catalog = "main";
        k.config.connection.schema = "analytics";
      }
      if (type === "duckdb") k.config.connection.schema = "main";
      if (type === "postgres" || type === "redshift" || type === "snowflake" || type === "clickhouse") {
        k.config.connection.schema = "public";
      }
      const { compiled, resolved } = k.compile({ metrics: ["shipping_cost"] });
      expect(resolved.trust, type).toBe("governed");
      expect(compiled.sql, type).toMatch(/shipping_costs/);
      expect(compiled.sql, type).not.toMatch(/BFS/);
    }
  });

  it("all-eight-dialect invalid dual-path fails before dialect SQL", () => {
    const k = kernel("items-first");
    for (const type of WAREHOUSE_TYPES) {
      k.config.connection.type = type;
      expect(refusal(() => k.compile({ metrics: ["product_weight"] })).status, type).toBe("ambiguous_query");
    }
  });
});

describe.skipIf(!pgEnv)("ambiguous fan-out measure path (PostgreSQL live)", () => {
  const live = pgEnv!;
  const schema = newCertSchema();
  const kernels: GraneKernel[] = [];
  let writePool: pg.Pool;

  beforeAll(async () => {
    await ensureReadonlyRole(live.writeUrl);
    writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schema}`);
    await writePool.query(`SET search_path TO ${schema}`);
    for (const stmt of PATH_DDL) await writePool.query(stmt);
    await grantReadonlyOnSchema(writePool, schema);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (writePool) {
      await writePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    }
  });

  function kernel(order: "items-first" | "shipments-first"): GraneKernel {
    const k = new GraneKernel(dualFanoutConfig(order, { type: "postgres", url: live.readUrl, schema }));
    kernels.push(k);
    return k;
  }

  it("P-A9: dual fan-out refuses on PostgreSQL before execution", async () => {
    await expectAllQuerySurfacesRefuse(kernel("items-first"), { metrics: ["product_weight"] }, "ambiguous_query");
  });

  it("reversed YAML order refuses identically on PostgreSQL", async () => {
    const a = await refusalAsync(() => kernel("items-first").query({ metrics: ["product_weight"] }));
    const b = await refusalAsync(() => kernel("shipments-first").query({ metrics: ["product_weight"] }));
    expectAmbiguousMeasure(a);
    expectAmbiguousMeasure(b);
    expect(a.status).toBe(b.status);
  });

  it("unique fan-out control is governed 7.5 against an independent oracle", async () => {
    const k = new GraneKernel(uniqueFanoutConfig({ type: "postgres", url: live.readUrl, schema }));
    kernels.push(k);
    const result = await k.query({ metrics: ["shipping_cost"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.shipping_cost)).toBe(7.5);
    const oracle = await writePool.query(
      `SELECT SUM(c.cost) AS v FROM ${schema}.orders o
       JOIN ${schema}.shipments s ON s.order_id = o.id
       JOIN ${schema}.shipping_costs c ON c.shipment_order_id = s.order_id`,
    );
    expect(Number(oracle.rows[0]!.v)).toBe(7.5);
  });
});

describe.skipIf(!duckOk)("ambiguous path CLI --sql agrees with query", () => {
  it("CLI query and --sql both refuse dual fan-out", async () => {
    const db = await loadDuck(PATH_DDL);
    const dir = mkdtempSync(join(tmpdir(), "grane-path-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:
  name: cli-path
  timezone: UTC
connection:
  type: duckdb
  path: ${JSON.stringify(db)}
  schema: main
entities:
  order:
    table: orders
    primary_key: id
metrics:
  product_weight:
    entity: order
    type: sum
    sql: "\${products.weight}"
relationships:
  items_to_orders:
    from: items.order_id
    to: orders.id
    type: many_to_one
  items_to_products:
    from: items.product_id
    to: products.id
    type: many_to_one
  shipments_to_orders:
    from: shipments.order_id
    to: orders.id
    type: many_to_one
  shipments_to_products:
    from: shipments.product_id
    to: products.id
    type: many_to_one
`,
    );
    mkdirSync(join(dir, "unused"), { recursive: true });
    const cli = join(process.cwd(), "src/cli/index.ts");
    const run = async (args: string[]) => {
      try {
        const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], { cwd: process.cwd(), timeout: 30000 });
        return { code: 0, stdout: out.stdout, stderr: out.stderr };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    };
    const sql = await run(["query", "product_weight", "--sql"]);
    const exec = await run(["query", "product_weight", "--json"]);
    expect(sql.code).not.toBe(0);
    expect(exec.code).not.toBe(0);
    expect(sql.stderr + sql.stdout).toMatch(/ERROR \(ambiguous_query\)/);
    expect(exec.stderr + exec.stdout).toMatch(/ERROR \(ambiguous_query\)/);
  });
});

describe("existing dimension fan-out remains unsafe_query when the path is unique", () => {
  it("product_category at order grain is still a unique fanning dimension join", () => {
    const kernel = exampleKernel();
    const r = refusal(() => kernel.compile({ metrics: ["revenue"], dimensions: ["product_category"] }));
    expect(r.status).toBe("unsafe_query");
    expect(r.message).toMatch(/one_to_many/);
  });
});
