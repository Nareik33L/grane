/**
 * Grane Gauntlet — internal robustness suite.
 *
 * Frozen as the V1 release gate: CI fails unless behavioural correctness,
 * answerable capability, safety / policy / clarification accuracy are 100%,
 * unsupported capability is 0, and every listed kernel-guarantee mutation is
 * detected.
 */

process.env.TZ = "UTC";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allScenarios } from "./catalog.js";
import { GOLD, GOLD_SQL, tablesMatchScalar } from "./gold.js";
import { createKernel, runScenario, type Harness } from "./harness.js";
import { MUTATION_CASES } from "./mutations.js";
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
  const mutationScore: { id: string; detected: boolean; detail: string }[] = [];

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
    const snap = Number((await warehouse.runGold(GOLD_SQL.latestSnapshotBalance))[0]?.["v"]);
    if (!tablesMatchScalar(snap, GOLD.snapshotLatestTotal)) {
      goldFailures.push(`snapshot last-as-of TS ${GOLD.snapshotLatestTotal} !== SQL ${snap}`);
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
  }, 180_000);

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
      "composition",
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

  it("is the V1 release gate", () => {
    const card = buildScorecard(results);
    expect(card.report).toContain("GRANE GAUNTLET");
    expect(card.behaviouralCorrectnessPct, card.report).toBe(100);
    expect(card.answerableCapabilityPct, card.report).toBe(100);
    expect(card.safetyAccuracyPct, card.report).toBe(100);
    expect(card.policyAccuracyPct, card.report).toBe(100);
    expect(card.clarifyAccuracyPct, card.report).toBe(100);
    expect(card.unsupported, "true capability gaps").toBe(0);
    expect(card.standardFailures, card.report).toBe(0);
    expect(card.criticalFailures, card.report).toBe(0);
    expect(card.securityCriticalFailures, card.report).toBe(0);
    expect(card.findings, JSON.stringify(card.findings.slice(0, 20), null, 2)).toEqual([]);
  });

  it("detects every listed kernel-guarantee mutation", async () => {
    for (const mutation of MUTATION_CASES) {
      const scenario =
        results.find((r) => r.scenario.id === mutation.scenarioId)?.scenario ??
        results.find((r) => r.scenario.id.startsWith(mutation.scenarioId))?.scenario;
      expect(scenario, `missing catch scenario ${mutation.scenarioId}`).toBeTruthy();
      const verdict = await mutation.inject(harness.kernel, () => runScenario(scenario!, harness));
      const detected =
        verdict.code === "CRITICAL FAIL" ||
        verdict.code === "SECURITY CRITICAL" ||
        verdict.code === "FAIL";
      mutationScore.push({ id: mutation.id, detected, detail: `${verdict.code} ${verdict.detail}` });
      expect(
        detected,
        `gauntlet stayed green under ${mutation.id}: ${verdict.code} ${verdict.detail}`,
      ).toBe(true);
    }
    const caught = mutationScore.filter((m) => m.detected).length;
    process.stderr.write(
      `\nMutation score ${caught}/${MUTATION_CASES.length}\n${mutationScore
        .map((m) => `  ${m.detected ? "CAUGHT" : "MISS  "} ${m.id} — ${m.detail}`)
        .join("\n")}\n`,
    );
    expect(caught).toBe(MUTATION_CASES.length);
  }, 120_000);
});
