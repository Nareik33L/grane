import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { GraneConfig } from "./config/schema.js";
import { GraneError } from "./errors.js";
import type { SemanticQueryInput, TrustLevel } from "./query/model.js";

/**
 * One append-only audit record. Never include row payloads, SQL bind params,
 * or agent tokens.
 */
export interface AuditEvent {
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

export function refusalFromError(err: unknown): NonNullable<AuditEvent["refusal"]> {
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
