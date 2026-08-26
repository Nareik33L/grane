/**
 * The Grane thesis benchmark: is "a good agent + a database MCP + a well-written
 * SKILL.md" already good enough, or does a deterministic semantic layer earn its
 * keep?
 *
 * Three execution paths answer the same questions against the same DuckDB
 * example shop (example/analytics-duckdb):
 *
 *   A  Direct warehouse SQL. What an unconstrained agent with a database MCP
 *      tends to emit: SUM(net_amount) with no status filter, "last month" on
 *      created_at, payments joined without pre-aggregation, revenue split by
 *      product category, an invented formula instead of a refusal.
 *   B  Warehouse SQL written from tests/benchmark/SKILL.md. The metric prose is
 *      correct and the model still writes the joins by hand.
 *   C  Grane Query Model v1. The agent sends intent (metrics, dimensions,
 *      raw_dimensions, time) and Grane compiles the SQL.
 *
 * No LLM is called. Paths A and B are handwritten SQL fixtures in cases.ts, so
 * the suite is deterministic and repeatable. Gold answers come from
 * independently reviewed SQL in the same file, executed against the same
 * warehouse file, never from Grane.
 *
 * This test fails only when the harness itself is broken: gold SQL that will
 * not run, a fixture that will not run, path C unable to execute, or scoring
 * that produced nothing. Low scores for A and B are the finding, not a failure.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildCases, type BenchCase } from "./cases.js";
import {
  benchmarkKernel,
  duckdbAvailable,
  rawWarehouse,
  resolveBenchTime,
  runGranePath,
  runSqlPath,
  toTable,
  type Outcome,
  type Table,
} from "./harness.js";
import { analyzeSql } from "./sql.js";
import {
  PATHS,
  renderFindings,
  renderPerCaseTable,
  renderScoreTable,
  scoreCase,
  summarize,
  type CaseScore,
  type PathId,
  type PathSummary,
} from "./scoring.js";

const available = await duckdbAvailable();

if (!available) {
  describe.skip("grane thesis benchmark (A/B/C)", () => {
    it("needs @duckdb/node-api", () => {});
  });
  process.stderr.write(
    "\n[benchmark] skipped: the A/B/C benchmark needs the DuckDB driver.\n" +
      "            npm install -D @duckdb/node-api && npm run test:benchmark\n\n",
  );
}

describe.skipIf(!available)("grane thesis benchmark (A/B/C)", () => {
  const warehouse = rawWarehouse();
  const kernel = benchmarkKernel();

  let cases: BenchCase[] = [];
  let scores: CaseScore[] = [];
  let summaries: Record<PathId, PathSummary>;
  let goldFailures: string[] = [];
  let goldRulerFailures: string[] = [];
  let fixtureFailures: string[] = [];
  let report = "";

  beforeAll(async () => {
    const time = await resolveBenchTime(warehouse.run);
    cases = buildCases(time);

    for (const kase of cases) {
      let gold: Table | null = null;
      if (kase.gold !== null) {
        try {
          gold = toTable(await warehouse.run(kase.gold));
        } catch (err) {
          goldFailures.push(`${kase.id}: ${(err as Error).message}`);
          continue;
        }
        // Grade the reviewed SQL with the same ruler used on the three paths.
        // A gold query the ruler rejects means the ruler or the SQL is wrong.
        const selfScore = scoreCase(
          kase,
          "C",
          { kind: "answered", table: gold, analysis: analyzeSql(kase.gold) },
          gold,
        );
        for (const c of selfScore.checks) {
          if (c.applicable && !c.passed) goldRulerFailures.push(`${kase.id} (${c.dimension}): ${c.detail}`);
        }
      }

      const outcomes: Record<PathId, Outcome> = {
        A: await attempt(kase, "A"),
        B: await attempt(kase, "B"),
        C: await runGranePath(kernel, kase.pathC),
      };

      for (const path of PATHS) {
        const outcome = outcomes[path];
        if (outcome.kind === "error") {
          fixtureFailures.push(`${kase.id} [${path}]: ${outcome.message}`);
        }
        scores.push(scoreCase(kase, path, outcome, gold));
      }
    }

    summaries = summarize(cases, scores);
    report = [
      "",
      `Grane thesis benchmark — ${cases.length} questions, anchored on ${time.anchor} (UTC)`,
      `  last_month = ${time.lastMonth.from}..${time.lastMonth.to}   last_30d = ${time.last30d.from}..${time.last30d.to}`,
      "",
      renderPerCaseTable(cases, scores),
      "",
      renderScoreTable(summaries),
      "",
      "Where A or B returned a wrong number (or answered an unanswerable question) and C did not:",
      renderFindings(cases, scores),
      "",
    ].join("\n");
    // Written directly rather than via console.log, which Vitest intercepts.
    process.stderr.write(`${report}\n`);
  });

  async function attempt(kase: BenchCase, path: "A" | "B"): Promise<Outcome> {
    const fixture = path === "A" ? kase.pathA : kase.pathB;
    if (fixture.refuse !== undefined) {
      return { kind: "refused", status: "skill_refusal", message: fixture.refuse };
    }
    return runSqlPath(warehouse.run, fixture.sql);
  }

  afterAll(async () => {
    await kernel.close();
    await warehouse.close();
  });

  // --- harness health: these are the only reasons to fail CI ---

  it("has a question set in the intended size range", () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
    expect(cases.length).toBeLessThanOrEqual(30);
  });

  it("ran every gold query successfully", () => {
    expect(goldFailures).toEqual([]);
  });

  it("ran every path A and path B fixture successfully", () => {
    expect(fixtureFailures).toEqual([]);
  });

  it("scored every case on every path", () => {
    expect(scores).toHaveLength(cases.length * PATHS.length);
    for (const score of scores) {
      expect(score.checks.length).toBe(4);
    }
  });

  it("grades its own gold SQL as correct, definition-adherent and grain-safe", () => {
    expect(goldRulerFailures).toEqual([]);
    expect(cases.filter((c) => c.gold !== null).length).toBeGreaterThan(15);
  });

  it("path C executes against the warehouse (the kernel is actually exercised)", () => {
    const c = summaries.C;
    expect(c.errored).toBe(0);
    expect(c.answered).toBeGreaterThan(15);
    expect(c.refused).toBeGreaterThan(0);
  });

  it("path C labels trust as expected on every answered case", () => {
    const mismatches: string[] = [];
    for (const kase of cases) {
      if (!kase.expectTrust) continue;
      const score = scores.find((s) => s.caseId === kase.id && s.path === "C")!;
      if (score.outcome !== "answered") {
        mismatches.push(`${kase.id}: expected trust ${kase.expectTrust}, got ${score.outcome}`);
      } else if (score.trust !== kase.expectTrust) {
        mismatches.push(`${kase.id}: expected trust ${kase.expectTrust}, got ${score.trust}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  // --- the thesis assertions ---

  it("never returns a number for a grain-unsafe or undefined question (path C)", () => {
    expect(summaries.C.wrongNumberOnRefusalCase).toEqual([]);
  });

  it("emits no fan-out join at the query grain (path C)", () => {
    const grain = summaries.C.byDimension.grain;
    expect(grain.passed).toBe(grain.applicable);
  });

  it("beats direct warehouse SQL on numeric and refusal correctness (C > A)", () => {
    const a = summaries.A;
    const c = summaries.C;
    expect(c.byDimension.numeric.passed / c.byDimension.numeric.applicable).toBeGreaterThan(
      a.byDimension.numeric.passed / a.byDimension.numeric.applicable,
    );
    expect(c.byDimension.refusal.passed / c.byDimension.refusal.applicable).toBeGreaterThan(
      a.byDimension.refusal.passed / a.byDimension.refusal.applicable,
    );
  });

  it("reports the score table", () => {
    // The finding, not a pass/fail gate: printed above and asserted only to
    // exist so a silent harness cannot look like a green run.
    expect(report).toContain("path");
    expect(report).toContain("overall");
  });
});
