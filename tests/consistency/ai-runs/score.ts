/**
 * Score AI-consistency transcripts against #117 expected outcomes, not raw
 * SQL results. Match questions: the matching number. Grain traps:
 * refusal with unsafe_query. Definition mismatch: the governed value.
 *
 *   npx tsx tests/consistency/ai-runs/score.ts
 *
 * Writes SCORE.json and SUMMARY.md from the transcript files + a live gold
 * execution. Regenerating those two files is the only allowed "summary"
 * authorship. Transcripts are not rewritten.
 */
process.env.TZ = "UTC";

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuestions, REFUSE_STATUS, type ConsistencyQuestion } from "../questions.js";
import { formatTable, tablesMatch, toTable, type Table } from "../compare.js";
import { gitHeadSha } from "../record.js";
import { openDuckdbBackend } from "../warehouse.js";
import { AI_CONSISTENCY, QUESTION_STEMS, type PathId } from "./meta.js";
import { TRANSCRIPTS_DIR } from "./record.js";
import type { AttemptTranscript, PathAnswerRecord } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));

export function answerFingerprint(out: PathAnswerRecord): string {
  if (out.kind === "answered" && out.rows) {
    const sorted = [...out.rows].sort((a, b) =>
      JSON.stringify(a.map((c) => (typeof c === "number" ? c.toFixed(4) : c))).localeCompare(
        JSON.stringify(b.map((c) => (typeof c === "number" ? c.toFixed(4) : c))),
      ),
    );
    return `answered:${JSON.stringify(sorted)}`;
  }
  if (out.kind === "refused") return `refused:${out.status ?? ""}`;
  return `${out.kind}:${out.message ?? ""}`;
}

export interface GoldOutcome {
  expect: ConsistencyQuestion["expect"];
  kind: "answered" | "refused" | "error";
  table?: Table;
  status?: string;
  fingerprint: string;
  preview: string;
}

/** Wrap gold SQL so the preview has a stable ORDER BY. */
export function withGoldOrderBy(sql: string): string {
  return `SELECT * FROM (\n${sql}\n) AS gold_preview ORDER BY 1`;
}

export function matchesExpectedOutcome(out: PathAnswerRecord, gold: GoldOutcome): boolean {
  if (gold.expect === "grane_refuses") {
    return out.kind === "refused" && out.status === REFUSE_STATUS;
  }
  return (
    out.kind === "answered" &&
    gold.kind === "answered" &&
    out.rows !== undefined &&
    gold.table !== undefined &&
    tablesMatch(out.rows, gold.table)
  );
}

export interface AttemptScore {
  path: PathId;
  attempt: number;
  question_id: string;
  fingerprint: string;
  gold_match: boolean;
  output_kind: PathAnswerRecord["kind"];
  gold_kind: GoldOutcome["kind"];
  gold_expect: ConsistencyQuestion["expect"] | "missing";
  transcript: string;
}

export interface QuestionScore {
  question_id: string;
  question: string;
  expect: ConsistencyQuestion["expect"] | "missing";
  gold_fingerprint: string;
  gold_preview: string;
  paths: Record<
    PathId,
    {
      attempts: number;
      distinct_answers: number;
      gold_matches: number;
      fingerprints: string[];
      kinds: Record<string, number>;
    }
  >;
}

export interface ScoreReport {
  scored_at: string;
  commit_sha: string;
  git_dirty: boolean;
  model: string;
  temperature: string;
  attempts_per_question_per_path: number;
  gold: "tests/consistency/questions.ts expected outcome (match value / unsafe_query / governed value)";
  questions: QuestionScore[];
  attempts: AttemptScore[];
}

function loadTranscripts(): AttemptTranscript[] {
  const files = readdirSync(TRANSCRIPTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  return files.map((f) => JSON.parse(readFileSync(join(TRANSCRIPTS_DIR, f), "utf8")) as AttemptTranscript);
}

export async function scoreTranscripts(): Promise<ScoreReport> {
  const transcripts = loadTranscripts();
  const backend = await openDuckdbBackend();
  const goldById = new Map<string, GoldOutcome>();
  try {
    for (const q of buildQuestions()) {
      if (q.expect === "grane_refuses") {
        goldById.set(q.id, {
          expect: q.expect,
          kind: "refused",
          status: REFUSE_STATUS,
          fingerprint: `refused:${REFUSE_STATUS}`,
          preview: REFUSE_STATUS,
        });
        continue;
      }
      const sql = q.expect === "mismatch" ? q.governedSql : q.rawSql;
      if (!sql) {
        goldById.set(q.id, {
          expect: q.expect,
          kind: "error",
          fingerprint: "error:missing gold SQL",
          preview: "missing gold SQL",
        });
        continue;
      }
      try {
        const rows = await backend.runRaw(withGoldOrderBy(sql));
        const table = toTable(rows);
        goldById.set(q.id, {
          expect: q.expect,
          kind: "answered",
          table,
          fingerprint: answerFingerprint({ kind: "answered", rows: table }),
          preview: formatTable(table, 8),
        });
      } catch (err) {
        goldById.set(q.id, {
          expect: q.expect,
          kind: "error",
          fingerprint: `error:${(err as Error).message}`,
          preview: (err as Error).message,
        });
      }
    }
  } finally {
    await backend.close();
  }

  const attempts: AttemptScore[] = [];
  for (const t of transcripts) {
    const gold = goldById.get(t.question_id);
    const fp = answerFingerprint(t.raw_output);
    attempts.push({
      path: t.path,
      attempt: t.attempt,
      question_id: t.question_id,
      fingerprint: fp,
      gold_match: gold ? matchesExpectedOutcome(t.raw_output, gold) : false,
      output_kind: t.raw_output.kind,
      gold_kind: gold?.kind ?? "error",
      gold_expect: gold?.expect ?? "missing",
      transcript: `transcripts/${t.path === "a_no_grane" ? "a" : "b"}-${String(t.attempt).padStart(2, "0")}-${t.question_id}.json`,
    });
  }

  const questions: QuestionScore[] = QUESTION_STEMS.map((stem) => {
    const gold = goldById.get(stem.id);
    const paths = {} as QuestionScore["paths"];
    for (const path of AI_CONSISTENCY.paths) {
      const rows = attempts.filter((a) => a.question_id === stem.id && a.path === path);
      const fingerprints = [...new Set(rows.map((r) => r.fingerprint))];
      const kinds: Record<string, number> = {};
      for (const r of rows) kinds[r.output_kind] = (kinds[r.output_kind] ?? 0) + 1;
      paths[path] = {
        attempts: rows.length,
        distinct_answers: fingerprints.length,
        gold_matches: rows.filter((r) => r.gold_match).length,
        fingerprints,
        kinds,
      };
    }
    return {
      question_id: stem.id,
      question: stem.question,
      expect: gold?.expect ?? "missing",
      gold_fingerprint: gold?.fingerprint ?? "missing",
      gold_preview: gold?.preview ?? "",
      paths,
    };
  });

  const { sha, dirty } = gitHeadSha();
  return {
    scored_at: new Date().toISOString(),
    commit_sha: sha,
    git_dirty: dirty,
    model: AI_CONSISTENCY.model,
    temperature: AI_CONSISTENCY.temperature,
    attempts_per_question_per_path: AI_CONSISTENCY.attempts_per_question_per_path,
    gold: "tests/consistency/questions.ts expected outcome (match value / unsafe_query / governed value)",
    questions,
    attempts,
  };
}

export function renderSummary(report: ScoreReport): string {
  const lines: string[] = [];
  lines.push("# AI-consistency summary (generated)");
  lines.push("");
  lines.push("Generated by `npx tsx tests/consistency/ai-runs/score.ts`. Do not edit.");
  lines.push("");
  lines.push(`- model: ${report.model}`);
  lines.push(`- temperature: ${report.temperature}`);
  lines.push(`- attempts per question per path: ${report.attempts_per_question_per_path}`);
  lines.push(`- scored_at: ${report.scored_at}`);
  lines.push(`- commit_sha: ${report.commit_sha}`);
  lines.push(`- git_dirty: ${report.git_dirty}`);
  lines.push(`- gold: ${report.gold}`);
  lines.push("");
  lines.push("Gold is #117's expected outcome per question: the match value, refusal with unsafe_query, or the governed value. Not the independent-SQL grain-trap numbers. Gold table previews use ORDER BY 1.");
  lines.push("");
  lines.push("| question | expect | path A distinct | path A gold matches | path B distinct | path B gold matches | path A kinds | path B kinds |");
  lines.push("| --- | --- | ---: | ---: | ---: | ---: | --- | --- |");
  for (const q of report.questions) {
    const a = q.paths.a_no_grane;
    const b = q.paths.b_grane;
    lines.push(
      `| ${q.question_id} | ${q.expect} | ${a.distinct_answers} | ${a.gold_matches}/${a.attempts} | ${b.distinct_answers} | ${b.gold_matches}/${b.attempts} | ${JSON.stringify(a.kinds)} | ${JSON.stringify(b.kinds)} |`,
    );
  }
  lines.push("");
  lines.push("## Distinct fingerprints");
  lines.push("");
  for (const q of report.questions) {
    lines.push(`### ${q.question_id}`);
    lines.push("");
    lines.push(`gold: \`${q.gold_preview.replaceAll("|", "/")}\``);
    for (const path of AI_CONSISTENCY.paths) {
      const p = q.paths[path];
      lines.push(`- ${path}: ${p.distinct_answers} distinct of ${p.attempts} (gold matches ${p.gold_matches})`);
      for (const fp of p.fingerprints) {
        const n = report.attempts.filter((a) => a.question_id === q.question_id && a.path === path && a.fingerprint === fp)
          .length;
        const shown = fp.length > 180 ? `${fp.slice(0, 180)}…` : fp;
        lines.push(`  - ${n}× \`${shown.replaceAll("|", "/")}\``);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export async function writeScore(): Promise<{ score: string; summary: string }> {
  const { dirty } = gitHeadSha();
  if (dirty) {
    throw new Error("refusing to write SCORE.json: working tree is dirty. Commit first so git_dirty is false.");
  }
  const report = await scoreTranscripts();
  if (report.git_dirty) {
    throw new Error("refusing to write SCORE.json with git_dirty true.");
  }
  const scorePath = join(here, "SCORE.json");
  const summaryPath = join(here, "SUMMARY.md");
  writeFileSync(scorePath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(summaryPath, renderSummary(report));
  return { score: scorePath, summary: summaryPath };
}

const isMain = process.argv[1]?.includes("ai-runs/score.ts");
if (isMain) {
  writeScore()
    .then((p) => {
      console.log(`wrote ${p.score}`);
      console.log(`wrote ${p.summary}`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
