/**
 * Run the consistency question set on one backend: GraneKernel.query (MCP
 * query path) vs independently written SQL through the warehouse driver.
 */
process.env.TZ = "UTC";

import { GraneError } from "../../src/errors.js";
import type { TrustLevel } from "../../src/query/model.js";
import { buildQuestions, REFUSE_STATUS, type ConsistencyQuestion, type Expectation } from "./questions.js";
import { formatTable, tableNonEmpty, tableNonTrivial, tablesMatch, toTable, type Table } from "./compare.js";
import { resolveAnchorNow, type ConsistencyBackend } from "./warehouse.js";

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
  all_time: boolean;
  note?: string;
  grane: PathAnswer;
  raw: PathAnswer;
  governed?: PathAnswer;
  tables_match: boolean | null;
  row_count_grane: number | null;
  row_count_raw: number | null;
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

function answeredRows(answer: PathAnswer): Table | undefined {
  return answer.kind === "answered" ? answer.rows : undefined;
}

export function judge(
  question: ConsistencyQuestion,
  grane: PathAnswer,
  raw: PathAnswer,
  governed?: PathAnswer,
): Pick<QuestionResult, "tables_match" | "ok" | "detail" | "row_count_grane" | "row_count_raw"> {
  const graneRows = answeredRows(grane);
  const rawRows = answeredRows(raw);
  const match = graneRows && rawRows ? tablesMatch(graneRows, rawRows) : null;
  const row_count_grane = graneRows ? graneRows.length : null;
  const row_count_raw = rawRows ? rawRows.length : null;

  if (question.expect === "match") {
    if (grane.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `Grane ${grane.kind}: ${grane.message ?? grane.status}`, row_count_grane, row_count_raw };
    }
    if (raw.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}`, row_count_grane, row_count_raw };
    }
    if (!tableNonEmpty(graneRows) || !tableNonEmpty(rawRows)) {
      return { tables_match: match, ok: false, detail: `empty result grane_rows=${row_count_grane} raw_rows=${row_count_raw}`, row_count_grane, row_count_raw };
    }
    if (!tableNonTrivial(graneRows) || !tableNonTrivial(rawRows)) {
      return { tables_match: match, ok: false, detail: `trivial (all-null/zero) result grane=${formatTable(graneRows ?? [])} raw=${formatTable(rawRows ?? [])}`, row_count_grane, row_count_raw };
    }
    if (row_count_grane !== row_count_raw) {
      return { tables_match: match, ok: false, detail: `row count grane=${row_count_grane} raw=${row_count_raw}`, row_count_grane, row_count_raw };
    }
    if (!match) {
      return {
        tables_match: false,
        ok: false,
        detail: `cells differ. grane=${formatTable(graneRows ?? [])} raw=${formatTable(rawRows ?? [])}`,
        row_count_grane,
        row_count_raw,
      };
    }
    return { tables_match: true, ok: true, detail: "match", row_count_grane, row_count_raw };
  }

  if (question.expect === "grane_refuses") {
    if (grane.kind !== "refused" || grane.status !== REFUSE_STATUS) {
      return {
        tables_match: match,
        ok: false,
        detail: `expected Grane ${REFUSE_STATUS}, got ${grane.kind}:${grane.status ?? grane.message ?? ""}`,
        row_count_grane,
        row_count_raw,
      };
    }
    if (raw.kind !== "answered") {
      return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}`, row_count_grane, row_count_raw };
    }
    if (!tableNonEmpty(rawRows) || !tableNonTrivial(rawRows)) {
      return { tables_match: match, ok: false, detail: `raw SQL empty/trivial after grain-trap join`, row_count_grane, row_count_raw };
    }
    return { tables_match: match, ok: true, detail: `Grane refused (${grane.status}); raw answered`, row_count_grane, row_count_raw };
  }

  // mismatch: Grane must equal governedSql; raw is the English question; they differ.
  if (grane.kind !== "answered") {
    return { tables_match: match, ok: false, detail: `Grane ${grane.kind}: ${grane.message ?? grane.status}`, row_count_grane, row_count_raw };
  }
  if (raw.kind !== "answered") {
    return { tables_match: match, ok: false, detail: `raw SQL ${raw.kind}: ${raw.message}`, row_count_grane, row_count_raw };
  }
  if (!governed || governed.kind !== "answered" || !governed.rows) {
    return { tables_match: match, ok: false, detail: `governed SQL ${governed?.kind ?? "missing"}: ${governed?.message ?? ""}`, row_count_grane, row_count_raw };
  }
  if (!tableNonEmpty(graneRows) || !tableNonEmpty(rawRows) || !tableNonEmpty(governed.rows)) {
    return { tables_match: match, ok: false, detail: "empty Grane, raw, or governed result", row_count_grane, row_count_raw };
  }
  if (!tableNonTrivial(rawRows)) {
    return { tables_match: match, ok: false, detail: `independent SQL trivial: ${formatTable(rawRows ?? [])}`, row_count_grane, row_count_raw };
  }
  if (!tablesMatch(graneRows ?? [], governed.rows)) {
    return {
      tables_match: match,
      ok: false,
      detail: `Grane did not match governed SQL (expected ${formatTable(governed.rows)}, got ${formatTable(graneRows ?? [])})`,
      row_count_grane,
      row_count_raw,
    };
  }
  if (match) {
    return { tables_match: true, ok: false, detail: "expected definition mismatch, but cells matched", row_count_grane, row_count_raw };
  }
  return { tables_match: false, ok: true, detail: "mismatch as expected (Grane matched governed SQL)", row_count_grane, row_count_raw };
}

export async function runBackend(backend: ConsistencyBackend): Promise<EngineRun> {
  const now = await resolveAnchorNow(backend.runRaw);
  const questions = buildQuestions();
  const results: QuestionResult[] = [];

  for (const question of questions) {
    const [grane, raw, governed] = await Promise.all([
      runGrane(backend, question),
      runRaw(backend, question.rawSql),
      question.governedSql ? runRaw(backend, question.governedSql) : Promise.resolve(undefined),
    ]);
    const judged = judge(question, grane, raw, governed);
    results.push({
      id: question.id,
      question: question.question,
      category: question.category,
      expect: question.expect,
      all_time: question.allTime,
      note: question.note,
      grane,
      raw,
      ...(governed ? { governed } : {}),
      ...judged,
    });
  }

  const failed = results.filter((r) => !r.ok).length;
  return {
    engine: backend.engine,
    engine_version: backend.engineVersion,
    status: "ran",
    anchor_now: now.toISOString(),
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

export function skippedRun(engine: "duckdb" | "postgres", reason: string): EngineRun {
  return {
    engine,
    engine_version: "",
    status: "skipped",
    skip_reason: reason,
    anchor_now: null,
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
    questions: [],
    summary: { total: 0, ok: 0, failed: 1, match_ok: 0, refuse_ok: 0, mismatch_ok: 0 },
  };
}
