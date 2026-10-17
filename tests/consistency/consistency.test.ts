/**
 * Live consistency gate: demo DuckDB (always) and certified Postgres when
 * reachable. Fails when a required engine cannot run or a question's expected
 * Grane-vs-raw outcome does not hold. All-time answers are checked against
 * results/committed.json so a tampered figure fails.
 */
process.env.TZ = "UTC";

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { reportExitCode, runConsistency } from "./run.js";
import { postgresRequired } from "./warehouse.js";
import { allTimeQuestionIds, buildQuestions } from "./questions.js";
import { allTimeDrift, loadCommittedReport } from "./committed.js";
import { COMMITTED_RESULTS } from "./record.js";
import { tablesMatch } from "./compare.js";
import type { EngineRun } from "./harness.js";

describe("Grane vs independent SQL consistency", { timeout: 120_000, hookTimeout: 120_000 }, () => {
  it("asks the demo metric questions two ways on DuckDB and Postgres", async () => {
    const report = await runConsistency({ engine: "all" });
    const duck = report.engines.find((e) => e.engine === "duckdb");
    const pg = report.engines.find((e) => e.engine === "postgres");
    const expected = buildQuestions();
    const matchN = expected.filter((q) => q.expect === "match").length;
    const refuseN = expected.filter((q) => q.expect === "grane_refuses").length;
    const mismatchN = expected.filter((q) => q.expect === "mismatch").length;

    expect(duck, "DuckDB engine missing from report").toBeTruthy();
    expect(duck!.status).toBe("ran");
    expect(duck!.summary.failed, failDetail(duck!)).toBe(0);
    expect(duck!.summary.match_ok).toBe(matchN);
    expect(duck!.summary.refuse_ok).toBe(refuseN);
    expect(duck!.summary.mismatch_ok).toBe(mismatchN);
    expect(matchN).toBe(12);
    expect(refuseN).toBe(3);
    expect(mismatchN).toBe(1);

    if (pg?.status === "ran") {
      expect(pg.summary.failed, failDetail(pg)).toBe(0);
      expect(pg.summary.match_ok).toBe(12);
      expect(pg.summary.refuse_ok).toBe(3);
      expect(pg.summary.mismatch_ok).toBe(1);
    } else if (postgresRequired()) {
      expect.fail(`Postgres is required in this environment but ${pg?.status}: ${pg?.skip_reason ?? pg?.error}`);
    } else {
      expect(pg?.status).toBe("skipped");
    }

    const committed = loadCommittedReport();
    expect(committed.git_dirty, "committed.json must be recorded on a clean tree").toBe(false);
    const committedDuck = committed.engines.find((e) => e.engine === "duckdb" && e.status === "ran");
    expect(committedDuck, "committed.json missing DuckDB run").toBeTruthy();
    const drift = allTimeDrift(duck!, committedDuck!);
    expect(drift, drift.join("\n")).toEqual([]);
    if (pg?.status === "ran") {
      const committedPg = committed.engines.find((e) => e.engine === "postgres" && e.status === "ran");
      expect(committedPg, "committed.json missing Postgres run").toBeTruthy();
      expect(allTimeDrift(pg, committedPg!), allTimeDrift(pg, committedPg!).join("\n")).toEqual([]);
    }

    expect(report.commit_sha).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(report.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reportExitCode(report)).toBe(0);
  });

  it("fails when a committed all-time figure is tampered", () => {
    const committed = loadCommittedReport();
    const duck = committed.engines.find((e) => e.engine === "duckdb" && e.status === "ran")!;
    const live = structuredClone(duck) as EngineRun;
    const target = live.questions.find((q) => q.id === "orders_completed")!;
    expect(target.grane.rows?.[0]?.[0]).toBeTruthy();
    const original = target.grane.rows![0]![0];
    target.grane.rows![0]![0] = typeof original === "number" ? original + 1 : "tampered";
    const drift = allTimeDrift(live, duck, ["orders_completed"]);
    expect(drift.length).toBeGreaterThan(0);
    const file = JSON.parse(readFileSync(COMMITTED_RESULTS, "utf8")) as { engines: EngineRun[] };
    const fileQ = file.engines
      .find((e) => e.engine === "duckdb")!
      .questions.find((q) => q.id === "orders_completed")!;
    expect(tablesMatch(fileQ.grane.rows ?? [], duck.questions.find((q) => q.id === "orders_completed")!.grane.rows ?? [])).toBe(
      true,
    );
    expect(allTimeQuestionIds().length).toBeGreaterThan(0);
  });
});

function failDetail(run: { questions: { id: string; ok: boolean; detail: string }[]; error?: string }): string {
  if (run.error) return run.error;
  return run.questions
    .filter((q) => !q.ok)
    .map((q) => `${q.id}: ${q.detail}`)
    .join("\n");
}
