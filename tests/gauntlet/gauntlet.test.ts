/**
 * Grane Gauntlet — internal robustness suite.
 *
 * This is not the public A/B/C usefulness benchmark. It exists to try to make
 * Grane return the wrong answer, bypass a permission, or label exploration as
 * governed. A safe refusal is a pass. A confident wrong number is a critical
 * failure.
 *
 * The test file fails CI only when the harness is broken or when known
 * defect-class mutations are not detected. Individual scenario findings are
 * the report, not a green-build target.
 */

process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allScenarios } from "./catalog.js";
import { GOLD, GOLD_SQL, tablesMatchScalar } from "./gold.js";
import { createKernel, runScenario, type Harness } from "./harness.js";
import { withDisabledFanout, withEmptyExclude } from "./mutations.js";
import { buildScorecard } from "./scoring.js";
import type { ScenarioResult } from "./types.js";
import { createGauntletWarehouse, duckdbAvailable } from "./warehouse.js";
import { revenueTotal } from "./data.js";

const available = await duckdbAvailable();

if (!available) {
  describe.skip("grane gauntlet", () => {
    it("needs @duckdb/node-api", () => {});
  });
  process.stderr.write(
    "\n[gauntlet] skipped: needs the DuckDB driver.\n" +
      "            npm install -D @duckdb/node-api && npm run test:gauntlet\n\n",
  );
}

describe.skipIf(!available)("grane gauntlet", () => {
  let harness: Harness;
  let results: ScenarioResult[] = [];
  let goldFailures: string[] = [];
  let duplicateCheck = "";

  beforeAll(async () => {
    const warehouse = await createGauntletWarehouse();
    const schema = await warehouse.introspect();
    const kernel = createKernel(warehouse, schema);
    harness = { kernel, warehouse, schema };

    const sqlGold = Number((await warehouse.runGold(GOLD_SQL.revenueTotal))[0]?.["v"]);
    if (!tablesMatchScalar(sqlGold, GOLD.revenueTotal)) {
      goldFailures.push(`TS revenue ${GOLD.revenueTotal} !== SQL ${sqlGold}`);
    }
    if (!tablesMatchScalar(sqlGold, revenueTotal())) {
      goldFailures.push(`revenueTotal() ${revenueTotal()} !== SQL ${sqlGold}`);
    }
    const pay = Number((await warehouse.runGold(GOLD_SQL.successfulPayments))[0]?.["v"]);
    if (!tablesMatchScalar(pay, GOLD.successfulPayments)) {
      goldFailures.push(`payments TS ${GOLD.successfulPayments} !== SQL ${pay}`);
    }

    const scenarios = allScenarios();
    duplicateCheck = `${scenarios.length}`;
    for (const scenario of scenarios) {
      const started = Date.now();
      const verdict = await runScenario(scenario, harness);
      results.push({
        scenario,
        verdict,
        durationMs: Date.now() - started,
        sql: null,
        trust: null,
        refusalStatus: verdict.detail,
      });
    }

    const card = buildScorecard(results);
    process.stderr.write(`${card.report}\n`);
  }, 120_000);

  afterAll(async () => {
    await harness?.kernel.close();
    await harness?.warehouse.close();
  });

  it("has a scenario set in the intended size range", () => {
    expect(results.length).toBeGreaterThanOrEqual(800);
    expect(results.length).toBeLessThan(5000);
    expect(duplicateCheck).not.toBe("0");
  });

  it("covers every gauntlet category", () => {
    const cats = new Set(results.map((r) => r.scenario.category));
    for (const required of [
      "join",
      "grain",
      "distinct",
      "metrics",
      "time",
      "permissions",
      "hostile",
      "exploration",
      "ambiguity",
      "dirty",
      "schema_mutation",
      "semantic_mutation",
      "provenance",
      "trust",
      "determinism",
      "equivalent",
      "readonly",
      "resources",
      "mcp",
      "concurrency",
      "cache",
      "leakage",
      "properties",
    ]) {
      expect(cats.has(required as never), `missing category ${required}`).toBe(true);
    }
  });

  it("agrees with independent gold SQL on the seed", () => {
    expect(goldFailures).toEqual([]);
  });

  it("scored every scenario", () => {
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) {
      expect(result.verdict.code).toMatch(/PASS|FAIL|CRITICAL|SECURITY/);
    }
  });

  it("prints a scorecard (findings are the report, not a CI gate)", () => {
    const card = buildScorecard(results);
    expect(card.report).toContain("GRANE GAUNTLET");
    expect(card.scenarios).toBe(results.length);
  });

  it("detects a disabled fan-out check (mutation testing)", async () => {
    const scenario = results.find((r) => r.scenario.id === "join/revenue-by-product-category")?.scenario;
    expect(scenario).toBeTruthy();
    const verdict = await withDisabledFanout(harness.kernel, () => runScenario(scenario!, harness));
    expect(
      verdict.code === "CRITICAL FAIL" || verdict.code === "SECURITY CRITICAL" || verdict.code === "FAIL",
      `gauntlet stayed green under a missing cardinality check: ${verdict.code} ${verdict.detail}`,
    ).toBe(true);
  });

  it("detects a removed blocked-column check (mutation testing)", async () => {
    const scenario = results.find((r) => r.scenario.id === "perm/raw-dim/customers-email")?.scenario;
    expect(scenario).toBeTruthy();
    const verdict = await withEmptyExclude(harness.kernel, () => runScenario(scenario!, harness));
    expect(
      verdict.code === "SECURITY CRITICAL" || verdict.code === "CRITICAL FAIL" || verdict.code === "FAIL",
      `gauntlet stayed green after dropping the exclude list: ${verdict.code} ${verdict.detail}`,
    ).toBe(true);
  });
});
