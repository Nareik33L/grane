/**
 * JSON null is not a legal value for ordinary comparison / membership
 * operators. Explicit is_null / is_not_null remain the NULL cohort operators.
 * Warehouse NULL data is unchanged.
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
import { validateModel } from "../../src/validate/validate.js";
import { translateMfFilter } from "../../src/providers/dbt/filters.js";
import type { MfSemanticModel } from "../../src/providers/dbt/graph.js";
import { NULL_DDL, nullFilterConfig } from "../helpers/path-null-fixtures.js";
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

type FilterOp = "=" | "!=" | ">" | ">=" | "<" | "<=" | "in" | "not_in" | "contains";

const NULL_COMPARISONS: Array<{ id: string; operator: FilterOp; value: unknown }> = [
  { id: "N1", operator: "=", value: null },
  { id: "N2", operator: "!=", value: null },
  { id: "N3", operator: "!=", value: null },
  { id: "N4", operator: ">", value: null },
  { id: "N5", operator: ">=", value: null },
  { id: "N6", operator: "<", value: null },
  { id: "N7", operator: "<=", value: null },
  { id: "N8", operator: "in", value: [null] },
  { id: "N9", operator: "in", value: ["ok", null] },
  { id: "N10", operator: "not_in", value: [null] },
  { id: "N11", operator: "not_in", value: ["bad", null] },
  { id: "N12", operator: "contains", value: null },
];

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

function expectJsonNullRefusal(r: GraneError["refusal"], operator: string, field = "status") {
  expect(r.status).toBe("invalid_query");
  expect(r.message).toMatch(new RegExp(`Operator "${operator}"`));
  expect(r.message).toMatch(new RegExp(`"${field}"`));
  expect(r.message).toMatch(/JSON null/);
  expect(r.message).toMatch(/is_null/);
  expect(r.message).toMatch(/is_not_null/);
  expect(r.message).not.toMatch(/Cannot create values of type ANY/i);
  expect(r.message).not.toMatch(/BFS/);
}

function expectSurfacesRefuseNull(k: GraneKernel, operator: FilterOp, value: unknown, field = "status") {
  const input = { metrics: ["total"], filters: [{ field, operator, value }] };
  const resolved = refusal(() => k.resolve(input as never));
  expectJsonNullRefusal(resolved, operator, field);
  expectJsonNullRefusal(refusal(() => k.compile(input as never)), operator, field);
}

async function loadDuck(ddl: string[]): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-null-")), "w.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const stmt of ddl) await conn.run(stmt);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

describe("JSON null filter validation (no warehouse)", () => {
  const k = new GraneKernel(nullFilterConfig({ type: "postgres", schema: "public" }));

  for (const { id, operator, value } of NULL_COMPARISONS) {
    it(`${id}: status ${operator} ${JSON.stringify(value)} is invalid_query on every resolve surface`, () => {
      expectSurfacesRefuseNull(k, operator, value, operator === "contains" ? "label" : "status");
    });
  }

  it("N3 <> is not a Query Model operator; schema refusal is still before SQL", () => {
    const r = refusal(() =>
      k.resolve({ metrics: ["total"], filters: [{ field: "status", operator: "<>" as never, value: null }] }),
    );
    expect(r.status).toBe("invalid_query");
  });

  it("N13: metric-definition equality null is invalid at resolve and validate", () => {
    expectJsonNullRefusal(refusal(() => k.resolve({ metrics: ["null_eq_total"] })), "=", "facts.status");
    const report = validateModel(new SemanticModel(k.config));
    expect(report.metrics.find((m) => m.metric === "null_eq_total")?.ok).toBe(false);
    expect(
      report.metrics.find((m) => m.metric === "null_eq_total")?.issues.some((i) => i.code === "invalid_filter"),
    ).toBe(true);
  });

  it("N14: metric-definition membership containing null is invalid", () => {
    expectJsonNullRefusal(refusal(() => k.resolve({ metrics: ["null_in_total"] })), "in", "facts.status");
  });

  it("empty in [] / not_in [] keep the existing non-empty-array refusal", () => {
    expect(refusal(() => k.resolve({ metrics: ["total"], filters: [{ field: "status", operator: "in", value: [] }] })).message).toMatch(
      /non-empty array/,
    );
    expect(
      refusal(() => k.resolve({ metrics: ["total"], filters: [{ field: "status", operator: "not_in", value: [] }] })).message,
    ).toMatch(/non-empty array/);
  });

  it("multi-metric, ratio, and grouped queries with JSON null all refuse", () => {
    expectJsonNullRefusal(
      refusal(() =>
        k.resolve({
          metrics: ["total", "counted"],
          filters: [{ field: "status", operator: "=", value: null }],
        }),
      ),
      "=",
    );
    const ratioCfg = nullFilterConfig({ type: "postgres", schema: "public" }, {
      rate: { entity: "fact", type: "ratio", numerator: "total", denominator: "counted" },
    });
    const rk = new GraneKernel(ratioCfg);
    expectJsonNullRefusal(
      refusal(() => rk.resolve({ metrics: ["rate"], filters: [{ field: "status", operator: "not_in", value: ["bad", null] }] })),
      "not_in",
    );
    expectJsonNullRefusal(
      refusal(() =>
        k.resolve({
          metrics: ["total"],
          dimensions: ["status"],
          filters: [{ field: "status", operator: "in", value: ["ok", null] }],
        }),
      ),
      "in",
    );
  });

  it("MetricFlow raw NULL equality is skipped, not mapped to is_null", () => {
    const model: MfSemanticModel = {
      name: "facts",
      table: "facts",
      primaryEntity: "fact",
      entities: [{ name: "fact", type: "primary", expr: "id", column: "id" }],
      dimensions: [{ name: "status", type: "categorical", expr: "status", column: "status" }],
      measures: [],
      metrics: [],
      sourcePath: "x.yml",
    };
    const result = translateMfFilter("{{ Dimension('fact__status') }} = NULL", model);
    expect(result).toEqual(
      expect.objectContaining({
        error: expect.stringMatching(/true\/false|quoted string|number/),
      }),
    );
  });
});

async function runLiveNullMatrix(k: GraneKernel) {
  for (const { id, operator, value } of NULL_COMPARISONS) {
    const field = operator === "contains" ? "label" : "status";
    const input = { metrics: ["total"], filters: [{ field, operator, value }] };
    const resolved = refusal(() => k.resolve(input as never));
    expectJsonNullRefusal(resolved, operator, field);
    expectJsonNullRefusal(refusal(() => k.compile(input as never)), operator, field);
    expectJsonNullRefusal(await refusalAsync(() => k.explain(input as never)), operator, field);
    expectJsonNullRefusal(await refusalAsync(() => k.query(input as never)), operator, field);
    void id;
  }

  expectJsonNullRefusal(await refusalAsync(() => k.query({ metrics: ["null_eq_total"] })), "=", "facts.status");
  expectJsonNullRefusal(await refusalAsync(() => k.query({ metrics: ["null_in_total"] })), "in", "facts.status");

  const isNull = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_null" }] });
  expect(isNull.trust).toBe("governed");
  expect(isNull.completeness.status).toBe("complete");
  expect(Number(isNull.rows[0]!.total)).toBe(11);
  expect(isNull.provenance.generated_sql).toMatch(/IS NULL/);
  expect(isNull.provenance.generated_sql).not.toMatch(/=\s*\$/);

  const isNotNull = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "is_not_null" }] });
  expect(isNotNull.trust).toBe("governed");
  expect(Number(isNotNull.rows[0]!.total)).toBe(110);

  const threeVl = await k.query({
    metrics: ["total"],
    filters: [{ field: "status", operator: "!=", value: "bad" }],
  });
  expect(threeVl.trust).toBe("governed");
  expect(Number(threeVl.rows[0]!.total)).toBe(10);

  const emptyContains = await k.query({
    metrics: ["total"],
    filters: [{ field: "label", operator: "contains", value: "" }],
  });
  expect(emptyContains.trust).toBe("governed");
  expect(Number(emptyContains.rows[0]!.total)).toBe(110);

  const escaped = await k.query({
    metrics: ["total"],
    filters: [{ field: "label", operator: "contains", value: "%" }],
  });
  expect(escaped.trust).toBe("governed");
  expect(Number(escaped.rows[0]!.total)).toBe(100);

  const groups = await k.query({ metrics: ["region_amount"], dimensions: ["region"] });
  expect(groups.trust).toBe("governed");
  const byName = new Map(groups.rows.map((row) => [row.region as string | null, Number(row.region_amount)]));
  expect(byName.get("US")).toBe(10);
  expect(byName.get(null)).toBe(25);

  const all = await k.query({ metrics: ["total"] });
  expect(all.trust).toBe("governed");
  expect(Number(all.rows[0]!.total)).toBe(121);
}

describe.skipIf(!duckOk)("JSON null filters (DuckDB live)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    path = await loadDuck(NULL_DDL);
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(): GraneKernel {
    const k = new GraneKernel(nullFilterConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    return k;
  }

  it("refuses the null matrix before DuckDB binder errors; explicit NULL operators succeed", async () => {
    await runLiveNullMatrix(kernel());
  });

  it("DuckDB no longer surfaces Cannot create values of type ANY", async () => {
    const k = kernel();
    const r = await refusalAsync(() =>
      k.query({ metrics: ["total"], filters: [{ field: "status", operator: "=", value: null }] }),
    );
    expectJsonNullRefusal(r, "=");
    expect(r.message).not.toMatch(/ANY/);
  });

  it("all-eight-dialect: valid is_null compiles; invalid = null refuses identically", () => {
    const k = kernel();
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
      const ok = k.compile({ metrics: ["total"], filters: [{ field: "status", operator: "is_null" }] });
      expect(ok.compiled.sql, type).toMatch(/IS NULL/);
      expect(ok.compiled.params, type).toEqual([]);
      expect(ok.resolved.trust, type).toBe("governed");
      const notNull = k.compile({ metrics: ["total"], filters: [{ field: "status", operator: "is_not_null" }] });
      expect(notNull.compiled.sql, type).toMatch(/IS NOT NULL/);
      const escaped = k.compile({
        metrics: ["total"],
        filters: [{ field: "label", operator: "contains", value: "%" }],
      });
      expect(escaped.compiled.sql, type).toMatch(/ESCAPE '!'/);
      expect(escaped.compiled.params, type).toContain("%");
      expect(refusal(() => k.compile({ metrics: ["total"], filters: [{ field: "status", operator: "=", value: null }] })).status, type).toBe(
        "invalid_query",
      );
    }
  });

  it("boolean flag = 1 coercion is unchanged / deferred (not this PR)", () => {
    const k = kernel();
    const { compiled } = k.compile({ metrics: ["total"], filters: [{ field: "flag", operator: "=", value: 1 }] });
    expect(compiled.params).toContain(1);
  });
});

describe.skipIf(!pgEnv)("JSON null filters (PostgreSQL live)", () => {
  const live = pgEnv!;
  const schema = newCertSchema();
  const kernels: GraneKernel[] = [];
  let writePool: pg.Pool;

  beforeAll(async () => {
    await ensureReadonlyRole(live.writeUrl);
    writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schema}`);
    await writePool.query(`SET search_path TO ${schema}`);
    for (const stmt of NULL_DDL) await writePool.query(stmt.replaceAll("VARCHAR", "TEXT"));
    await grantReadonlyOnSchema(writePool, schema);
  }, 60_000);

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (writePool) {
      await writePool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    }
  });

  function kernel(): GraneKernel {
    const k = new GraneKernel(nullFilterConfig({ type: "postgres", url: live.readUrl, schema }));
    kernels.push(k);
    return k;
  }

  it("refuses the null matrix before PostgreSQL 3VL empty/NULL aggregates; explicit operators match the oracle", async () => {
    await runLiveNullMatrix(kernel());
    const oracleNull = await writePool.query(`SELECT SUM(amount) AS v FROM ${schema}.facts WHERE status IS NULL`);
    const oracleNotNull = await writePool.query(`SELECT SUM(amount) AS v FROM ${schema}.facts WHERE status IS NOT NULL`);
    expect(Number(oracleNull.rows[0]!.v)).toBe(11);
    expect(Number(oracleNotNull.rows[0]!.v)).toBe(110);
  });

  it("valid ordinary filters remain correct", async () => {
    const k = kernel();
    const ok = await k.query({ metrics: ["total"], filters: [{ field: "status", operator: "=", value: "ok" }] });
    expect(ok.trust).toBe("governed");
    expect(Number(ok.rows[0]!.total)).toBe(10);
    const notIn = await k.query({
      metrics: ["total"],
      filters: [{ field: "status", operator: "not_in", value: ["bad"] }],
    });
    expect(Number(notIn.rows[0]!.total)).toBe(10);
  });
});

describe.skipIf(!duckOk)("JSON null CLI --sql agrees with query", () => {
  it("CLI query and --sql refuse status = JSON null", async () => {
    const db = await loadDuck(NULL_DDL);
    const dir = mkdtempSync(join(tmpdir(), "grane-null-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `project:
  name: cli-null
  timezone: UTC
connection:
  type: duckdb
  path: ${JSON.stringify(db)}
  schema: main
entities:
  fact:
    table: facts
    primary_key: id
metrics:
  total:
    entity: fact
    type: sum
    sql: "\${facts.amount}"
dimensions:
  status:
    entity: fact
    sql: "\${facts.status}"
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
    const ok = await run(["query", "total", "--json"]);
    expect(ok.code).toBe(0);
    const payload = JSON.parse(ok.stdout) as { rows: { total: number }[]; trust: string };
    expect(payload.trust).toBe("governed");
    expect(Number(payload.rows[0]!.total)).toBe(121);
  });
});
