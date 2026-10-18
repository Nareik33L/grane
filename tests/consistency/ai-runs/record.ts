/**
 * Execute staged model replies against DuckDB / Grane and write transcripts.
 *
 *   npx tsx tests/consistency/ai-runs/record.ts
 *
 * Reads tests/consistency/ai-runs/attempts/{a,b}-[1-5].json (unedited model
 * JSON). Writes one transcript per question per attempt under transcripts/.
 * Does not score. Does not edit replies.
 */
process.env.TZ = "UTC";

import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GraneError } from "../../../src/errors.js";
import { semanticQuerySchema, type SemanticQueryInput } from "../../../src/query/model.js";
import { gitHeadSha } from "../record.js";
import { toTable } from "../compare.js";
import { openDuckdbBackend } from "../warehouse.js";
import { AI_CONSISTENCY, QUESTION_STEMS, type PathId } from "./meta.js";
import type { AttemptReplyA, AttemptReplyB, AttemptTranscript, PathAnswerRecord } from "./types.js";

const here = dirname(fileURLToPath(import.meta.url));
export const ATTEMPTS_DIR = join(here, "attempts");
export const TRANSCRIPTS_DIR = join(here, "transcripts");
export const PROMPTS_DIR = join(here, "prompts");

function parseJsonArray(text: string): unknown {
  const trimmed = text.trim();
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("model reply is not a JSON array");
  return JSON.parse(trimmed.slice(start, end + 1));
}

function loadAttempt(path: PathId, attempt: number): { rows: unknown[]; rawText: string } {
  const file = join(ATTEMPTS_DIR, `${path === "a_no_grane" ? "a" : "b"}-${attempt}.json`);
  const raw = readFileSync(file, "utf8");
  const parsed = parseJsonArray(raw);
  if (!Array.isArray(parsed)) throw new Error(`${file} is not an array`);
  return { rows: parsed, rawText: raw };
}

function byId(rows: unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    if (row && typeof row === "object" && "id" in row && typeof (row as { id: unknown }).id === "string") {
      map.set((row as { id: string }).id, row);
    }
  }
  return map;
}

export async function recordAttempts(): Promise<string[]> {
  const { sha, dirty } = gitHeadSha();
  const promptA = readFileSync(join(PROMPTS_DIR, "path-a.txt"), "utf8");
  const promptB = readFileSync(join(PROMPTS_DIR, "path-b.txt"), "utf8");
  const backend = await openDuckdbBackend();
  const written: string[] = [];
  mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  for (const leftover of readdirSync(TRANSCRIPTS_DIR)) {
    if (leftover.endsWith(".json")) rmSync(join(TRANSCRIPTS_DIR, leftover));
  }

  try {
    for (let attempt = 1; attempt <= AI_CONSISTENCY.attempts_per_question_per_path; attempt += 1) {
      const loadedA = loadAttempt("a_no_grane", attempt);
      const loadedB = loadAttempt("b_grane", attempt);
      const repliesA = byId(loadedA.rows);
      const repliesB = byId(loadedB.rows);
      for (const stem of QUESTION_STEMS) {
        const aReply = repliesA.get(stem.id) as AttemptReplyA | undefined;
        const bReply = repliesB.get(stem.id) as AttemptReplyB | undefined;
        const aOut = await runSql(backend.runRaw, aReply);
        const bOut = await runGrane(backend.kernel.query.bind(backend.kernel), bReply);
        const ranAt = new Date().toISOString();
        written.push(
          writeTranscript({
            protocol: "r1-5b",
            model: AI_CONSISTENCY.model,
            temperature: AI_CONSISTENCY.temperature,
            path: "a_no_grane",
            attempt,
            question_id: stem.id,
            question: stem.question,
            prompt: promptA,
            sql: aReply?.sql ?? null,
            tool_call: null,
            raw_model_reply: aReply ?? { error: "missing from attempt file" },
            raw_model_text: loadedA.rawText,
            raw_output: aOut,
            ran_at: ranAt,
            commit_sha: sha,
            git_dirty: dirty,
          }),
        );
        written.push(
          writeTranscript({
            protocol: "r1-5b",
            model: AI_CONSISTENCY.model,
            temperature: AI_CONSISTENCY.temperature,
            path: "b_grane",
            attempt,
            question_id: stem.id,
            question: stem.question,
            prompt: promptB,
            sql: null,
            tool_call: bReply?.query
              ? { name: "query", arguments: { query: bReply.query } }
              : null,
            raw_model_reply: bReply ?? { error: "missing from attempt file" },
            raw_model_text: loadedB.rawText,
            raw_output: bOut,
            ran_at: ranAt,
            commit_sha: sha,
            git_dirty: dirty,
          }),
        );
      }
    }
  } finally {
    await backend.close();
  }
  return written;
}

function writeTranscript(t: AttemptTranscript): string {
  const name = `${t.path === "a_no_grane" ? "a" : "b"}-${String(t.attempt).padStart(2, "0")}-${t.question_id}.json`;
  const path = join(TRANSCRIPTS_DIR, name);
  writeFileSync(path, `${JSON.stringify(t, null, 2)}\n`);
  return path;
}

async function runSql(
  runRaw: (sql: string) => Promise<Record<string, unknown>[]>,
  reply: AttemptReplyA | undefined,
): Promise<PathAnswerRecord> {
  if (!reply) return { kind: "missing", message: "no reply for this question" };
  if (!reply.sql) return { kind: "error", message: reply.error ?? "sql was null", sql: null };
  try {
    const rows = await runRaw(reply.sql);
    return {
      kind: "answered",
      rows: toTable(rows),
      columns: rows[0] ? Object.keys(rows[0]) : [],
      sql: reply.sql,
    };
  } catch (err) {
    return { kind: "error", message: (err as Error).message, sql: reply.sql };
  }
}

async function runGrane(
  query: (input: SemanticQueryInput) => Promise<{
    rows: Record<string, unknown>[];
    columns: string[];
    trust: string;
    provenance: { generated_sql: string; params: unknown[] };
  }>,
  reply: AttemptReplyB | undefined,
): Promise<PathAnswerRecord> {
  if (!reply) return { kind: "missing", message: "no reply for this question" };
  if (!reply.query) return { kind: "error", message: reply.error ?? "query was null" };
  let parsed: SemanticQueryInput;
  try {
    parsed = semanticQuerySchema.parse(reply.query) as SemanticQueryInput;
  } catch (err) {
    return { kind: "error", message: `invalid Query Model: ${(err as Error).message}` };
  }
  try {
    const result = await query(parsed);
    return {
      kind: "answered",
      rows: toTable(result.rows),
      columns: result.columns,
      sql: result.provenance.generated_sql,
      params: result.provenance.params,
      trust: result.trust,
    };
  } catch (err) {
    if (err instanceof GraneError) {
      return { kind: "refused", status: err.refusal.status, message: err.refusal.message };
    }
    return { kind: "error", message: (err as Error).message };
  }
}

const isMain = process.argv[1]?.includes("ai-runs/record.ts");
if (isMain) {
  recordAttempts()
    .then((files) => {
      console.log(`wrote ${files.length} transcripts`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
