/**
 * Shape gate for AI-consistency transcripts. Does not grade accuracy.
 * Scoring against #117 expected outcomes is `npx tsx tests/consistency/ai-runs/score.ts`.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AI_CONSISTENCY, QUESTION_STEMS } from "./ai-runs/meta.js";
import { matchesExpectedOutcome, withGoldOrderBy } from "./ai-runs/score.js";
import { REFUSE_STATUS } from "./questions.js";

const here = dirname(fileURLToPath(import.meta.url));
const transcripts = join(here, "ai-runs/transcripts");
const summary = join(here, "ai-runs/SUMMARY.md");
const score = join(here, "ai-runs/SCORE.json");
const promptA = join(here, "ai-runs/prompts/path-a.txt");
const promptB = join(here, "ai-runs/prompts/path-b.txt");

describe("AI-consistency transcripts", () => {
  it("records model, temperature, prompt, and at least 5 attempts per question per path", () => {
    expect(existsSync(promptA)).toBe(true);
    expect(existsSync(promptB)).toBe(true);
    expect(existsSync(summary)).toBe(true);
    expect(existsSync(score)).toBe(true);
    const files = existsSync(transcripts) ? readdirSync(transcripts).filter((f) => f.endsWith(".json")) : [];
    const expected =
      QUESTION_STEMS.length * AI_CONSISTENCY.paths.length * AI_CONSISTENCY.attempts_per_question_per_path;
    expect(files.length).toBe(expected);

    for (const path of AI_CONSISTENCY.paths) {
      for (const stem of QUESTION_STEMS) {
        for (let attempt = 1; attempt <= AI_CONSISTENCY.attempts_per_question_per_path; attempt += 1) {
          const name = `${path === "a_no_grane" ? "a" : "b"}-${String(attempt).padStart(2, "0")}-${stem.id}.json`;
          const body = JSON.parse(readFileSync(join(transcripts, name), "utf8")) as {
            model: string;
            temperature: string;
            prompt: string;
            commit_sha: string;
            ran_at: string;
            path: string;
            attempt: number;
            question_id: string;
          };
          expect(body.model).toBe(AI_CONSISTENCY.model);
          expect(body.temperature).toBe("not controllable");
          expect(body.prompt.length).toBeGreaterThan(100);
          expect(body.commit_sha).toMatch(/^[0-9a-f]{40}$|^unknown$/);
          expect(body.ran_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          expect(body.path).toBe(path);
          expect(body.attempt).toBe(attempt);
          expect(body.question_id).toBe(stem.id);
        }
      }
    }

    const generated = readFileSync(summary, "utf8");
    expect(generated.startsWith("# AI-consistency summary (generated)")).toBe(true);
    expect(generated).toContain(`model: ${AI_CONSISTENCY.model}`);
    expect(generated).toContain("temperature: not controllable");
    expect(generated).toContain(`attempts per question per path: ${AI_CONSISTENCY.attempts_per_question_per_path}`);
    const scored = JSON.parse(readFileSync(score, "utf8")) as {
      git_dirty: boolean;
      gold: string;
      questions: { expect: string; paths: Record<string, { attempts: number }> }[];
    };
    expect(scored.git_dirty).toBe(false);
    expect(scored.gold).toMatch(/expected outcome/);
    for (const q of scored.questions) {
      expect(q.paths.a_no_grane.attempts).toBeGreaterThanOrEqual(5);
      expect(q.paths.b_grane.attempts).toBeGreaterThanOrEqual(5);
      expect(["match", "grane_refuses", "mismatch"]).toContain(q.expect);
    }
  });

  it("scores #117 expected outcomes, not raw SQL grain-trap numbers", () => {
    expect(withGoldOrderBy("SELECT 1 AS n")).toMatch(/ORDER BY 1/);
    expect(
      matchesExpectedOutcome(
        { kind: "refused", status: REFUSE_STATUS },
        { expect: "grane_refuses", kind: "refused", status: REFUSE_STATUS, fingerprint: "", preview: "" },
      ),
    ).toBe(true);
    expect(
      matchesExpectedOutcome(
        { kind: "refused", status: "invalid_query" },
        { expect: "grane_refuses", kind: "refused", status: REFUSE_STATUS, fingerprint: "", preview: "" },
      ),
    ).toBe(false);
    expect(
      matchesExpectedOutcome(
        { kind: "answered", rows: [["home", 241112.49]] },
        { expect: "grane_refuses", kind: "refused", status: REFUSE_STATUS, fingerprint: "", preview: "" },
      ),
    ).toBe(false);
    expect(
      matchesExpectedOutcome(
        { kind: "answered", rows: [[0]] },
        { expect: "mismatch", kind: "answered", table: [[0]], fingerprint: "", preview: "" },
      ),
    ).toBe(true);
    expect(
      matchesExpectedOutcome(
        { kind: "answered", rows: [[181]] },
        { expect: "mismatch", kind: "answered", table: [[0]], fingerprint: "", preview: "" },
      ),
    ).toBe(false);
  });
});
