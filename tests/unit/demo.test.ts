/**
 * Canonical demo shop: last-month revenue falls on the partner channel
 * under ungoverned discount_code PARTNER20. Grane compiles the SQL.
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

  it("builds the shop and proves the last-month decline story", async () => {
    result = await runDemo({ dir, io: quiet });
    expect(result.lastMonthRevenue).toBe(18200);
    expect(result.priorMonthRevenue).toBe(21400);
    expect(result.lastMonthRevenue).toBeLessThan(result.priorMonthRevenue);

    const partner = result.lastMonthByChannel.find((row) => row.channel === "partner");
    const web = result.lastMonthByChannel.find((row) => row.channel === "web");
    expect(partner?.revenue).toBe(4800);
    expect(web?.revenue).toBe(8000);
    expect(partner!.revenue).toBeLessThan(web!.revenue);

    expect(result.mixedCodes).toContain("PARTNER20");
    expect(result.productCategoryStatus).toBe("unsafe_query");
    expect(result.emailStatus).toBe("column_not_permitted");
    expect(result.generatedSql.toUpperCase()).toContain("SELECT");
    expect(result.generatedSql).toMatch(/net_amount/i);
    expect(result.generatedSql.toLowerCase()).not.toContain("partner20");
  });

  it("lists discount_code as explorable and hides customer email", async () => {
    const loaded = loadConfig(dir);
    const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
    try {
      const catalog = await kernel.catalog();
      const names = catalog.exploration.columns.map((c) => `${c.table}.${c.column}`);
      expect(names).toContain("orders.discount_code");
      expect(names).not.toContain("customers.email");
    } finally {
      await kernel.close();
    }
  });
});
