/**
 * Live consistency gate: demo DuckDB (always) and certified Postgres when
 * reachable. Fails when a required engine cannot run or a question's expected
 * Grane-vs-raw outcome does not hold. Does not lock numbers against committed
 * snapshots — those are evidence of a recorded run, regenerated with
 * `npx tsx tests/consistency/run.ts --write`.
 */
process.env.TZ = "UTC";

import { describe, expect, it } from "vitest";
import { reportExitCode, runConsistency } from "./run.js";
import { postgresRequired } from "./warehouse.js";

describe("Grane vs independent SQL consistency", { timeout: 120_000, hookTimeout: 120_000 }, () => {
  it("asks the demo metric questions two ways on DuckDB and Postgres", async () => {
    const report = await runConsistency({ engine: "all" });
    const duck = report.engines.find((e) => e.engine === "duckdb");
    const pg = report.engines.find((e) => e.engine === "postgres");

    expect(duck, "DuckDB engine missing from report").toBeTruthy();
    expect(duck!.status).toBe("ran");
    expect(duck!.summary.total).toBeGreaterThan(0);
    expect(duck!.summary.failed, duckFailDetail(duck!)).toBe(0);

    if (pg?.status === "ran") {
      expect(pg.summary.failed, duckFailDetail(pg)).toBe(0);
      expect(pg.summary.total).toBe(duck!.summary.total);
    } else if (postgresRequired()) {
      expect.fail(`Postgres is required in this environment but ${pg?.status}: ${pg?.skip_reason ?? pg?.error}`);
    } else {
      expect(pg?.status).toBe("skipped");
    }

    expect(report.commit_sha).toMatch(/^[0-9a-f]{40}$|^unknown$/);
    expect(report.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(reportExitCode(report)).toBe(0);
  });
});

function duckFailDetail(run: { questions: { id: string; ok: boolean; detail: string }[]; error?: string }): string {
  if (run.error) return run.error;
  return run.questions
    .filter((q) => !q.ok)
    .map((q) => `${q.id}: ${q.detail}`)
    .join("\n");
}
