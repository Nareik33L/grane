/**
 * Run the consistency question set on one backend: GraneKernel.query (MCP
 * query path) vs independently written SQL through the warehouse driver.
 */
process.env.TZ = "UTC";

import { GraneError } from "../../src/errors.js";
import type { TrustLevel } from "../../src/query/model.js";
import { buildQuestions, type ConsistencyQuestion, type Expectation } from "./questions.js";
import { formatTable, tablesMatch, toTable, type Table } from "./compare.js";
import { resolveAnchorTime, type ConsistencyBackend } from "./warehouse.js";

export type PathKind = "answered" | "refused" | "error";

export interface PathAnswer {
  kind: PathKind;
  rows?: Table;
  columns?: string[];
  sql?: string;
  params?: unknown[];
  trust?: TrustLevel;
  status?: string;
  message?: string;
  duration_ms: number;
}

export interface QuestionResult {
  id: string;
  question: string;
  category: string;
  expect: Expectation;
  note?: string;
  time_window?: { from: string; to: string } | null;
  grane: PathAnswer;
  raw: PathAnswer;
  tables_match: boolean | null;
  ok: boolean;
  detail: string;
}

export interface EngineRun {
  engine: "duckdb" | "postgres";
  engine_version: string;
  status: "ran" | "skipped" | "failed";
  skip_reason?: string;
  error?: string;
  anchor_now: string | null;
  time_windows: Record<string, { from: string; to: string }> | null;
  questions: QuestionResult[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    match_ok: number;
    refuse_ok: number;
    mismatch_ok: number;
  };
}

async function runGrane(backend: ConsistencyBackend, question: ConsistencyQuestion): Promise<PathAnswer> {
  const started = Date.now();
  try {
    const result = await backend.kernel.query(question.grane);
    return {
      kind: "answered",
      rows: toTable(result.rows),
      columns: result.columns,
      sql: result.provenance.generated_sql,
      params: result.provenance.params,
      trust: result.trust,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof GraneError) {
      return {
        kind: "refused",
        status: err.refusal.status,
        message: err.refusal.message,
        duration_ms: Date.now() - started,
      };
    }
    return { kind: "error", message: (err as Error).message, duration_ms: Date.now() - started };
  }
}

async function runRaw(backend: ConsistencyBackend, sql: string): Promise<PathAnswer> {
  const started = Date.now();
  try {
    const rows = await backend.runRaw(sql);
    return {
      kind: "answered",
      rows: toTable(rows),
      columns: rows[0] ? Object.keys(rows[0]) : [],
      sql,
      duration_ms: Date.now() - started,
    };
  } catch (err) {
    return {
      kind: "error",
      message: (err as Error).message,
      sql,
      duration_ms: Date.now() - started,
    };
  }
}

function judge(question: ConsistencyQuestion, grane: PathAnswer, raw: PathAnswer): Pick<QuestionResult, "tables_match" | "ok" | "detail"> {
  const match =
    grane.kind === "answered" && raw.kind === "answered" && grane.rows && raw.rows
      ? tablesMatch(grane.rows, raw.rows)
      : null;

  if (question.expect === "match") {
    if (grane.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `Grane ${grane.kind}: ${grane.message ?? grane.status}` };
    }
    if (raw.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}` };
    }
    if (!match) {
      return {
        tables_match: false,
        ok: false,
        detail: `cells differ. grane=${formatTable(grane.rows ?? [])} raw=${formatTable(raw.rows ?? [])}`,
      };
    }
    return { tables_match: true, ok: true, detail: "match" };
  }

  if (question.expect === "grane_refuses") {
    if (grane.kind !== "refused") {
      return {
        tables_match: match,
        ok: false,
        detail: `expected Grane refusal, got ${grane.kind}${grane.rows ? ` ${formatTable(grane.rows)}` : ""}`,
      };
    }
    if (raw.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}` };
    }
    return { tables_match: match, ok: true, detail: `Grane refused (${grane.status}); raw answered` };
  }

  // mismatch: both answer, cells must differ
  if (grane.kind !== "answered") {
    return { tables_match: match, ok: false, detail: `Grane ${grane.kind}: ${grane.message ?? grane.status}` };
  }
  if (raw.kind !== "answered") {
    return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}` };
  }
  if (match) {
    return { tables_match: true, ok: false, detail: "expected definition mismatch, but cells matched" };
  }
  return { tables_match: false, ok: true, detail: "mismatch as expected" };
}

export async function runBackend(backend: ConsistencyBackend): Promise<EngineRun> {
  const { now, time } = await resolveAnchorTime(backend.runRaw);
  const questions = buildQuestions(time);
  const results: QuestionResult[] = [];

  for (const question of questions) {
    const rawSql = question.rawSql(time);
    const [grane, raw] = await Promise.all([runGrane(backend, question), runRaw(backend, rawSql)]);
    const judged = judge(question, grane, raw);
    results.push({
      id: question.id,
      question: question.question,
      category: question.category,
      expect: question.expect,
      note: question.note,
      time_window: question.grane.time
        ? question.grane.time.period === "last_month"
          ? time.lastMonth
          : question.grane.time.period === "30d"
            ? time.last30d
            : question.grane.time.period === "last_quarter"
              ? time.lastQuarter
              : question.grane.time.period === "q2"
                ? time.q2
                : null
        : null,
      grane,
      raw,
      ...judged,
    });
  }

  const failed = results.filter((r) => !r.ok).length;
  return {
    engine: backend.engine,
    engine_version: backend.engineVersion,
    status: "ran",
    anchor_now: now.toISOString(),
    time_windows: {
      last_month: time.lastMonth,
      last_30d: time.last30d,
      last_quarter: time.lastQuarter,
      q2: time.q2,
    },
    questions: results,
    summary: {
      total: results.length,
      ok: results.length - failed,
      failed,
      match_ok: results.filter((r) => r.expect === "match" && r.ok).length,
      refuse_ok: results.filter((r) => r.expect === "grane_refuses" && r.ok).length,
      mismatch_ok: results.filter((r) => r.expect === "mismatch" && r.ok).length,
    },
  };
}

export function skippedRun(
  engine: "duckdb" | "postgres",
  reason: string,
): EngineRun {
  return {
    engine,
    engine_version: "",
    status: "skipped",
    skip_reason: reason,
    anchor_now: null,
    time_windows: null,
    questions: [],
    summary: { total: 0, ok: 0, failed: 0, match_ok: 0, refuse_ok: 0, mismatch_ok: 0 },
  };
}

export function failedRun(engine: "duckdb" | "postgres", error: string): EngineRun {
  return {
    engine,
    engine_version: "",
    status: "failed",
    error,
    anchor_now: null,
    time_windows: null,
    questions: [],
    summary: { total: 0, ok: 0, failed: 1, match_ok: 0, refuse_ok: 0, mismatch_ok: 0 },
  };
}
