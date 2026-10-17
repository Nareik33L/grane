import { readFileSync } from "node:fs";
import { allTimeQuestionIds } from "./questions.js";
import { tablesMatch } from "./compare.js";
import { COMMITTED_RESULTS, type ConsistencyReport } from "./record.js";
import type { EngineRun, PathAnswer, QuestionResult } from "./harness.js";

function pathFingerprint(answer: PathAnswer): string {
  if (answer.kind === "answered" && answer.rows) {
    return `answered:${JSON.stringify(answer.rows)}`;
  }
  if (answer.kind === "refused") return `refused:${answer.status ?? ""}`;
  return `${answer.kind}:${answer.message ?? ""}`;
}

function questionDrift(id: string, side: "grane" | "raw", live: PathAnswer, committed: PathAnswer): string | null {
  if (live.kind === "answered" && committed.kind === "answered" && live.rows && committed.rows) {
    if (tablesMatch(live.rows, committed.rows)) return null;
    return `${id} ${side}: live ${pathFingerprint(live)} != committed ${pathFingerprint(committed)}`;
  }
  if (pathFingerprint(live) === pathFingerprint(committed)) return null;
  return `${id} ${side}: live ${pathFingerprint(live)} != committed ${pathFingerprint(committed)}`;
}

export function loadCommittedReport(path = COMMITTED_RESULTS): ConsistencyReport {
  return JSON.parse(readFileSync(path, "utf8")) as ConsistencyReport;
}

/** All-time live answers must match the committed file (tamper / drift gate). */
export function allTimeDrift(live: EngineRun, committed: EngineRun, ids = allTimeQuestionIds()): string[] {
  const errors: string[] = [];
  for (const id of ids) {
    const a = live.questions.find((q: QuestionResult) => q.id === id);
    const b = committed.questions.find((q: QuestionResult) => q.id === id);
    if (!a || !b) {
      errors.push(`${id}: missing in ${!a ? "live" : "committed"} ${live.engine} run`);
      continue;
    }
    const g = questionDrift(id, "grane", a.grane, b.grane);
    const r = questionDrift(id, "raw", a.raw, b.raw);
    if (g) errors.push(g);
    if (r) errors.push(r);
  }
  return errors;
}
