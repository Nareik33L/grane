/**
 * Score AI-consistency transcripts against #117 handwritten SQL (questions.ts
 * rawSql executed on the demo DuckDB). Nothing is scored by hand.
 *
 *   npx tsx tests/consistency/ai-runs/score.ts
 *
 * Writes SCORE.json and SUMMARY.md from the transcript files + a live gold
 * execution. Regenerating those two files is the only allowed "summary"
 * authorship.
 */
process.env.TZ = "UTC";

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQuestions } from "../questions.js";
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

export interface AttemptScore {
  path: PathId;
  attempt: number;
  question_id: string;
  fingerprint: string;
  gold_match: boolean;
  output_kind: PathAnswerRecord["kind"];
  gold_kind: "answered" | "error";
  transcript: string;
}

export interface QuestionScore {
  question_id: string;
  question: string;
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
  gold: "tests/consistency/questions.ts rawSql executed on demo DuckDB";
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
  const goldById = new Map<string, { table: Table; fingerprint: string; preview: string; kind: "answered" | "error" }>();
  try {
    for (const q of buildQuestions()) {
      try {
        const rows = await backend.runRaw(q.rawSql);
        const table = toTable(rows);
        const fp = answerFingerprint({ kind: "answered", rows: table });
        goldById.set(q.id, {
          table,
          fingerprint: fp,
          preview: formatTable(table, 8),
          kind: "answered",
        });
      } catch (err) {
        goldById.set(q.id, {
          table: [],
          fingerprint: `error:${(err as Error).message}`,
          preview: (err as Error).message,
          kind: "error",
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
    const match =
      Boolean(gold) &&
      t.raw_output.kind === "answered" &&
      gold!.kind === "answered" &&
      t.raw_output.rows !== undefined &&
      tablesMatch(t.raw_output.rows, gold!.table);
    attempts.push({
      path: t.path,
      attempt: t.attempt,
      question_id: t.question_id,
      fingerprint: fp,
      gold_match: match,
      output_kind: t.raw_output.kind,
      gold_kind: gold?.kind ?? "error",
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
    gold: "tests/consistency/questions.ts rawSql executed on demo DuckDB",
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
  lines.push("Gold is the #117 handwritten SQL (`questions.ts` `rawSql`) executed on the demo DuckDB in this scoring run. Grain-trap gold SQL is the naive join recorded there, not a refusal.");
  lines.push("");
  lines.push("| question | path A distinct | path A gold matches | path B distinct | path B gold matches | path A kinds | path B kinds |");
  lines.push("| --- | ---: | ---: | ---: | ---: | --- | --- |");
  for (const q of report.questions) {
    const a = q.paths.a_no_grane;
    const b = q.paths.b_grane;
    lines.push(
      `| ${q.question_id} | ${a.distinct_answers} | ${a.gold_matches}/${a.attempts} | ${b.distinct_answers} | ${b.gold_matches}/${b.attempts} | ${JSON.stringify(a.kinds)} | ${JSON.stringify(b.kinds)} |`,
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
  const report = await scoreTranscripts();
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
