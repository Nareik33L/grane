import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { GraneConfig } from "./config/schema.js";
import { GraneError } from "./errors.js";
import type { SemanticQueryInput, TrustLevel } from "./query/model.js";

/**
 * Query / explain audit record. `query` stays required so existing JSONL
 * readers and the public TypeScript type keep the 0.6.4 contract.
 */
export interface SemanticAuditEvent {
  ts: string;
  kind: "query" | "refusal";
  operation: "query" | "explain";
  agent: string | null;
  query: SemanticQueryInput;
  trust?: TrustLevel;
  query_id?: string;
  sql?: string;
  row_count?: number;
  duration_ms?: number;
  refusal?: {
    status: string;
    message: string;
    requested?: string;
  };
}

/**
 * HTTP MCP authentication denial. Separate variant so `query` is never
 * optional on query/refusal lines, and so tokens are never logged.
 */
export interface AuthAuditEvent {
  ts: string;
  kind: "auth";
  operation: "http";
  agent: string | null;
  reason: "missing" | "invalid";
}

/**
 * One append-only audit record. Never include row payloads, SQL bind params,
 * or agent tokens. Discriminate on `kind`: query/refusal events always have
 * `query`; auth events never do.
 */
export type AuditEvent = SemanticAuditEvent | AuthAuditEvent;

export function refusalFromError(err: unknown): NonNullable<SemanticAuditEvent["refusal"]> {
  if (err instanceof GraneError) {
    return {
      status: err.refusal.status,
      message: err.refusal.message,
      ...(err.refusal.requested ? { requested: err.refusal.requested } : {}),
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { status: "error", message };
}

export function resolveAuditPath(projectDir: string | undefined, configured: string): string | null {
  if (isAbsolute(configured)) return configured;
  if (!projectDir) return null;
  return join(projectDir, configured);
}

export function appendAudit(
  event: AuditEvent,
  options: { path?: string | null; stdout?: boolean },
): void {
  const line = `${JSON.stringify(event)}\n`;
  if (options.stdout) {
    process.stderr.write(line);
  }
  if (options.path) {
    mkdirSync(dirname(options.path), { recursive: true });
    appendFileSync(options.path, line);
  }
}

/** Best-effort: never throws. */
export function recordAudit(
  config: GraneConfig,
  projectDir: string | undefined,
  event: AuditEvent,
): void {
  if (!config.audit.enabled) return;
  try {
    appendAudit(event, {
      path: resolveAuditPath(projectDir, config.audit.path),
      stdout: config.audit.stdout,
    });
  } catch {
    // Audit must not fail a query.
  }
}
