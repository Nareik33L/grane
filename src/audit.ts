import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { GraneConfig } from "./config/schema.js";
import { GraneError, configError } from "./errors.js";
import type { SemanticQueryInput, TrustLevel } from "./query/model.js";

/** Correlation fields on HTTP-originated audit events. Omitted on stdio. */
export interface HttpAuditContext {
  request_id: string;
  client_ip: string | null;
  user_agent: string | null;
}

/**
 * Query / explain audit record. `query` stays required so existing JSONL
 * readers and the public TypeScript type keep the 0.6.5 contract.
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
  request_id?: string;
  client_ip?: string | null;
  user_agent?: string | null;
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
  request_id?: string;
  client_ip?: string | null;
  user_agent?: string | null;
}

export type DiscoveryOperation = "introspect" | "relationships" | "profile";

/** Warehouse object a discovery call touched. Omit fields that do not apply. */
export interface DiscoveryTarget {
  schema?: string;
  table?: string;
  column?: string;
}

/**
 * One discovery call (schema introspect, relationship inference, or bounded
 * column profile). Sample values are never fields on this event — only SQL,
 * counts, and optional hashes. Tokens are never logged.
 */
export interface DiscoveryAuditEvent {
  ts: string;
  kind: "discovery";
  session_id: string | null;
  agent: string | null;
  operation: DiscoveryOperation;
  connector: string;
  target: DiscoveryTarget;
  /** Exact statements issued, in order. */
  sql: string[];
  row_count: number;
  duration_ms: number;
  read_only: true;
  /** Hash of the snapshot or sample set; never the sampled values. */
  snapshot_hash?: string;
  refusal?: {
    status: string;
    message: string;
    requested?: string;
  };
  request_id?: string;
  client_ip?: string | null;
  user_agent?: string | null;
}

export type AuthoringAuditOperation =
  | "authoring_start"
  | "discover_schema"
  | "profile_column"
  | "record_term"
  | "list_ambiguities"
  | "resolve_ambiguity"
  | "propose_definitions"
  | "preview_yaml"
  | "submit_proposal"
  | "proposal_created";

export type PinAuditOperation = "load" | "refuse" | "write";

/**
 * One authoring MCP tool call. The outer tool owns this line; nested
 * `createDiscovery` calls from those tools must not write their own.
 * Sample values and tokens are never fields. Successful `submit_proposal`
 * uses `operation: "proposal_created"` plus commit / branch / PR ref.
 */
export interface AuthoringAuditEvent {
  ts: string;
  kind: "authoring";
  operation: AuthoringAuditOperation;
  session_id: string | null;
  agent: string | null;
  duration_ms: number;
  refusal?: {
    status: string;
    message: string;
    requested?: string;
  };
  commit?: string;
  branch?: string;
  /** Branch/PR ref (`owner/repo#head` or the proposal branch). */
  pr?: string;
  request_id?: string;
  client_ip?: string | null;
  user_agent?: string | null;
}

/**
 * Active-config pin (`.grane/active.json`). `refuse` always includes `reason`.
 * Tokens and YAML contents are never fields.
 */
export interface PinAuditEvent {
  ts: string;
  kind: "pin";
  operation: PinAuditOperation;
  ref?: string;
  commit?: string;
  approved_by?: string;
  reason?: string;
}

/**
 * One append-only audit record. Never include row payloads, sample values,
 * SQL bind params, or agent tokens. Discriminate on `kind`: query/refusal
 * events always have `query`; auth, discovery, authoring, and pin events never do.
 */
export type AuditEvent =
  | SemanticAuditEvent
  | AuthAuditEvent
  | DiscoveryAuditEvent
  | AuthoringAuditEvent
  | PinAuditEvent;

export interface DiscoveryAuditInput {
  ts?: string;
  session_id: string | null;
  agent: string | null;
  operation: DiscoveryOperation;
  connector: string;
  target: DiscoveryTarget;
  sql: string | readonly string[];
  row_count: number;
  duration_ms: number;
  snapshot_hash?: string;
  refusal?: NonNullable<DiscoveryAuditEvent["refusal"]>;
  http?: HttpAuditContext | null;
}

/**
 * Build a discovery line from known fields only, so extra keys (samples,
 * rows, tokens) cannot leak into JSONL.
 */
export function discoveryAuditEvent(input: DiscoveryAuditInput): DiscoveryAuditEvent {
  const target: DiscoveryTarget = {};
  if (input.target.schema) target.schema = input.target.schema;
  if (input.target.table) target.table = input.target.table;
  if (input.target.column) target.column = input.target.column;
  const event: DiscoveryAuditEvent = {
    ts: input.ts ?? new Date().toISOString(),
    kind: "discovery",
    session_id: input.session_id,
    agent: input.agent,
    operation: input.operation,
    connector: input.connector,
    target,
    sql: (Array.isArray(input.sql) ? [...input.sql] : [input.sql]).map((statement) => String(statement)),
    row_count: input.row_count,
    duration_ms: input.duration_ms,
    read_only: true,
  };
  if (input.snapshot_hash) event.snapshot_hash = input.snapshot_hash;
  if (input.refusal) {
    event.refusal = {
      status: input.refusal.status,
      message: input.refusal.message,
      ...(input.refusal.requested ? { requested: input.refusal.requested } : {}),
    };
  }
  Object.assign(event, httpFields(input.http));
  return event;
}

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

export function auditWriteFailed(cause: unknown): GraneError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return configError(
    `Audit log write failed (${message}); refusing because audit.fail_closed is true.`,
    { audit_failed: true },
  );
}

export function isAuditWriteFailed(err: unknown): boolean {
  if (!(err instanceof GraneError)) return false;
  const details = err.refusal.details;
  return Boolean(details && typeof details === "object" && (details as { audit_failed?: boolean }).audit_failed);
}

/**
 * Append one audit line. Best-effort by default (never throws). When
 * `audit.fail_closed` is true, a write failure becomes `config_error` so a
 * regulated deployment can refuse rather than swallow.
 */
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
  } catch (err) {
    if (config.audit.fail_closed) throw auditWriteFailed(err);
  }
}

/** Record one discovery call. Fail-closed uses the same `recordAudit` path as queries. */
export function recordDiscoveryAudit(
  config: GraneConfig,
  projectDir: string | undefined,
  input: DiscoveryAuditInput,
): void {
  recordAudit(config, projectDir, discoveryAuditEvent(input));
}

export interface AuthoringAuditInput {
  ts?: string;
  operation: AuthoringAuditOperation;
  session_id: string | null;
  agent: string | null;
  duration_ms: number;
  refusal?: NonNullable<AuthoringAuditEvent["refusal"]>;
  commit?: string;
  branch?: string;
  pr?: string;
  http?: HttpAuditContext | null;
}

/**
 * Build an authoring line from known fields only, so extra keys (samples,
 * draft YAML, tokens) cannot leak into JSONL.
 */
export function authoringAuditEvent(input: AuthoringAuditInput): AuthoringAuditEvent {
  const event: AuthoringAuditEvent = {
    ts: input.ts ?? new Date().toISOString(),
    kind: "authoring",
    operation: input.operation,
    session_id: input.session_id,
    agent: input.agent,
    duration_ms: input.duration_ms,
  };
  if (input.refusal) {
    event.refusal = {
      status: input.refusal.status,
      message: input.refusal.message,
      ...(input.refusal.requested ? { requested: input.refusal.requested } : {}),
    };
  }
  if (input.commit) event.commit = input.commit;
  if (input.branch) event.branch = input.branch;
  if (input.pr) event.pr = input.pr;
  Object.assign(event, httpFields(input.http));
  return event;
}

/** Record one authoring MCP tool call. Fail-closed uses the same `recordAudit` path. */
export function recordAuthoringAudit(
  config: GraneConfig,
  projectDir: string | undefined,
  input: AuthoringAuditInput,
): void {
  recordAudit(config, projectDir, authoringAuditEvent(input));
}

export interface PinAuditInput {
  ts?: string;
  operation: PinAuditOperation;
  ref?: string;
  commit?: string;
  approved_by?: string;
  reason?: string;
}

/**
 * Build a pin line from known fields only, so YAML contents and tokens cannot
 * leak into JSONL.
 */
export function pinAuditEvent(input: PinAuditInput): PinAuditEvent {
  const event: PinAuditEvent = {
    ts: input.ts ?? new Date().toISOString(),
    kind: "pin",
    operation: input.operation,
  };
  if (input.ref) event.ref = input.ref;
  if (input.commit) event.commit = input.commit;
  if (input.approved_by) event.approved_by = input.approved_by;
  if (input.reason) event.reason = input.reason;
  return event;
}

/** Record one pin load, refuse, or write. Fail-closed uses the same `recordAudit` path. */
export function recordPinAudit(
  config: GraneConfig,
  projectDir: string | undefined,
  input: PinAuditInput,
): void {
  recordAudit(config, projectDir, pinAuditEvent(input));
}

export function httpFields(http: HttpAuditContext | null | undefined): HttpAuditContext | Record<string, never> {
  if (!http) return {};
  return {
    request_id: http.request_id,
    client_ip: http.client_ip,
    user_agent: http.user_agent,
  };
}
