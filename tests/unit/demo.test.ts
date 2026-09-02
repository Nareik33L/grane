/**
 * Canonical demo shop: last-month revenue falls in Germany under
 * exploratory payments.failure_code CARD_AUTH_FAILED. Grane compiles the SQL.
 */

process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { runDemo, type DemoIo } from "../../src/demo/run.js";
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
  });

  it("lists failure_code as explorable and hides customer email", async () => {
    const loaded = loadConfig(dir);
    loaded.config.connection = {
      type: "duckdb",
      path: result.warehousePath ?? join(dir, "warehouse.duckdb"),
      schema: "main",
    };
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
});
