import type { PathId } from "./meta.js";
import type { Table } from "../compare.js";

export interface AttemptReplyA {
  id: string;
  sql?: string | null;
  error?: string;
}

export interface AttemptReplyB {
  id: string;
  query?: Record<string, unknown> | null;
  error?: string;
}

export interface PathAnswerRecord {
  kind: "answered" | "refused" | "error" | "missing";
  rows?: Table;
  columns?: string[];
  sql?: string | null;
  params?: unknown[];
  trust?: string;
  status?: string;
  message?: string;
}

/** One unedited attempt at one question. */
export interface AttemptTranscript {
  protocol: "r1-5b";
  model: string;
  temperature: string;
  path: PathId;
  attempt: number;
  question_id: string;
  question: string;
  prompt: string;
  /** Path A: the SQL the model returned. Path B: null. */
  sql: string | null;
  /** Path B: the MCP query tool arguments. Path A: null. */
  tool_call: { name: "query"; arguments: { query: unknown } } | null;
  raw_model_reply: unknown;
  /** Full unedited attempt-file text for this round. */
  raw_model_text: string;
  raw_output: PathAnswerRecord;
  ran_at: string;
  commit_sha: string;
  git_dirty: boolean;
}
