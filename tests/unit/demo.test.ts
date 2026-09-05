/**
 * Canonical demo shop: last-month revenue falls in Germany under
 * exploratory payments.failure_code CARD_AUTH_FAILED. Grane compiles the SQL.
 */

process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { runDemo, type DemoIo } from "../../src/demo/run.js";
import { demoWarehouseConfigPath } from "../../src/demo/project.js";
import { splitSqlStatements } from "../../src/demo/duckdb.js";

const quiet: DemoIo = { log: () => undefined, error: () => undefined };

const duckdb = await (async () => {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
})();

describe("demo warehouse config path", () => {
  it("stores a project-local warehouse as a relative path", () => {
    expect(demoWarehouseConfigPath("/tmp/shop", "/tmp/shop/warehouse.duckdb")).toBe("warehouse.duckdb");
  });
});

describe("demo project destination", () => {
  it("uses the bundled project when cwd is the package root", async () => {
    const { resolveDemoProject } = await import("../../src/demo/project.js");
    const { packageRoot, bundledDuckdbProject } = await import("../../src/demo/paths.js");
    const root = packageRoot();
    const resolved = resolveDemoProject({ root, cwd: root });
    expect(resolved.projectDir).toBe(bundledDuckdbProject(root));
    expect(resolved.copied).toBe(false);
  });

  it("copies into ./demo/analytics when cwd is not the package root", async () => {
    const { resolveDemoProject } = await import("../../src/demo/project.js");
    const cwd = mkdtempSync(join(tmpdir(), "grane-cwd-"));
    const resolved = resolveDemoProject({ cwd });
    expect(resolved.projectDir).toBe(join(cwd, "demo", "analytics"));
    expect(resolved.copied).toBe(true);
    expect(existsSync(join(resolved.projectDir, "grane.yml"))).toBe(true);
    rmSync(cwd, { recursive: true, force: true });
  });
});

describe("demo seed SQL", () => {
  it("splits the DuckDB seed into executable statements", () => {
    const sql = `
      -- comment
      CREATE TABLE t (id INTEGER);
      INSERT INTO t VALUES (1);
    `;
    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE t (id INTEGER)",
      "INSERT INTO t VALUES (1)",
    ]);
  });
});

describe.skipIf(!duckdb)("canonical Grane demo", () => {
  const dir = mkdtempSync(join(tmpdir(), "grane-demo-"));
  let result: Awaited<ReturnType<typeof runDemo>>;

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the shop and proves the last-month Germany decline", async () => {
    result = await runDemo({ dir, io: quiet });
    expect(result.investigation.revenueLast).toBeCloseTo(184230, 0);
    expect(result.investigation.revenueChangePct).toBeCloseTo(-14.3, 1);

    const germany = result.investigation.byCountry.find((row) => row.country === "Germany");
    expect(germany?.changePct).toBeCloseTo(-39, 0);

    const auth = result.investigation.failures.find((row) => row.code === "CARD_AUTH_FAILED");
    expect(auth).toBeTruthy();
    expect(auth!.changePct).toBeGreaterThan(200);

    expect(result.productCategoryStatus).toBe("unsafe_query");
    expect(result.emailStatus).toBe("column_not_permitted");
    expect(result.generatedSql.toUpperCase()).toContain("SELECT");
    expect(result.generatedSql).toMatch(/net_amount/i);

    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*duckdb/);
    expect(yaml).toContain("path: warehouse.duckdb");
    expect(yaml).not.toMatch(/localhost:5433/);
  });

  it("lists failure_code as explorable and hides customer email", async () => {
    const loaded = loadConfig(dir);
    expect(loaded.config.connection.type).toBe("duckdb");
    expect(String(loaded.config.connection.path)).toMatch(/warehouse\.duckdb$/);
    const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
    try {
      const catalog = await kernel.catalog();
      const names = catalog.exploration.columns.map((c) => `${c.table}.${c.column}`);
      expect(names).toContain("payments.failure_code");
      expect(names).not.toContain("customers.email");
    } finally {
      await kernel.close();
    }
  });

  it("subsequent queries use the persisted DuckDB connection without a runtime override", async () => {
    const loaded = loadConfig(dir);
    const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
    try {
      const queried = await kernel.query({ metrics: ["revenue"], time: { period: "last_month" } });
      expect(queried.trust).toBe("governed");
      expect(Number(queried.rows[0]!.revenue)).toBeCloseTo(184230, 0);
    } finally {
      await kernel.close();
    }
  });
});
