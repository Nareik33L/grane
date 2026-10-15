import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { warehouseTypeSchema, type ConnectionConfig } from "../config/schema.js";
import { configError } from "../errors.js";

/**
 * Authoring-session documents live under `.grane/authoring/<id>.json`.
 * They are runtime state for V2 onboarding/authoring, not project config:
 * `loadConfig` only reads top-level YAML, and `SemanticModel` is built from
 * the loaded config object. Neither path scans `.grane/`.
 */

export const AUTHORING_SESSION_VERSION = 1 as const;
export const AUTHORING_DIR = ".grane/authoring";

/** Secret-free pointer at the warehouse this session is authoring against. */
export const warehouseRefSchema = z.object({
  type: warehouseTypeSchema,
  /** Host/database, file path, account, or other locator — never a password or token. */
  locator: z.string().min(1),
});
export type WarehouseRef = z.infer<typeof warehouseRefSchema>;

export const glossaryAnswerSchema = z.object({
  term: z.string().min(1),
  answer: z.string(),
});
export type GlossaryAnswer = z.infer<typeof glossaryAnswerSchema>;

export const openAmbiguitySchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  question: z.string().min(1),
  candidates: z.array(z.string()).default([]),
});
export type OpenAmbiguity = z.infer<typeof openAmbiguitySchema>;

export const resolvedAmbiguitySchema = openAmbiguitySchema.extend({
  chosen: z.string().min(1),
});
export type ResolvedAmbiguity = z.infer<typeof resolvedAmbiguitySchema>;

/**
 * Versioned authoring session. Breaking field changes bump `version`;
 * additive optional fields may stay on the current version.
 */
export const authoringSessionSchema = z.object({
  version: z.literal(AUTHORING_SESSION_VERSION),
  id: z.string().min(1),
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  warehouse_ref: warehouseRefSchema,
  discovered_snapshot_hash: z.string().nullable().default(null),
  glossary_answers: z.array(glossaryAnswerSchema).default([]),
  open_ambiguities: z.array(openAmbiguitySchema).default([]),
  /** Additive: resolved items leave `open_ambiguities`. */
  resolved_ambiguities: z.array(resolvedAmbiguitySchema).default([]),
  /** Draft YAML files keyed by project-relative path (`metrics.yml`, …). */
  draft_yaml: z.record(z.string(), z.string()).default({}),
  /**
   * Hash of glossary / ambiguities / discovery at the last `propose_definitions`.
   * `submit_proposal` refuses when the session has moved on (stale draft).
   */
  draft_source_hash: z.string().nullable().default(null),
});
export type AuthoringSession = z.infer<typeof authoringSessionSchema>;

export interface CreateSessionInput {
  warehouse_ref: WarehouseRef;
  id?: string;
  created_at?: string;
  updated_at?: string;
  discovered_snapshot_hash?: string | null;
  glossary_answers?: GlossaryAnswer[];
  open_ambiguities?: OpenAmbiguity[];
  resolved_ambiguities?: ResolvedAmbiguity[];
  draft_yaml?: Record<string, string>;
  draft_source_hash?: string | null;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function authoringDir(projectDir: string): string {
  return join(projectDir, ".grane", "authoring");
}

export function sessionPath(projectDir: string, id: string): string {
  return join(authoringDir(projectDir), `${assertSessionId(id)}.json`);
}

function assertSessionId(id: string): string {
  if (!SESSION_ID.test(id)) {
    throw configError(
      `Invalid authoring session id "${id}". Use a UUID or letters, digits, dot, underscore, and hyphen.`,
    );
  }
  return id;
}

/** Inputs that must match the stored draft. Order-sensitive; excludes `draft_yaml`. */
export function sessionDraftSourceHash(
  session: Pick<
    AuthoringSession,
    "glossary_answers" | "open_ambiguities" | "resolved_ambiguities" | "discovered_snapshot_hash"
  >,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        discovered_snapshot_hash: session.discovered_snapshot_hash,
        glossary_answers: session.glossary_answers,
        open_ambiguities: session.open_ambiguities,
        resolved_ambiguities: session.resolved_ambiguities,
      }),
    )
    .digest("hex");
}

function parseSession(raw: unknown, source: string): AuthoringSession {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(`Authoring session ${source} must be a JSON object.`);
  }
  const version = (raw as { version?: unknown }).version;
  if (version !== AUTHORING_SESSION_VERSION) {
    throw configError(
      `Unsupported authoring session version ${String(version)} in ${source}. This Grane build reads version ${AUTHORING_SESSION_VERSION}.`,
    );
  }
  const parsed = authoringSessionSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `  ${issue.path.join(".")}: ${issue.message}`).join("\n");
    throw configError(`Invalid authoring session ${source}:\n${issues}`, parsed.error.issues);
  }
  return parsed.data;
}

function readSessionFile(path: string, id: string): AuthoringSession {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw configError(`No authoring session "${id}" at ${path}.`);
    }
    throw configError(`Failed to read authoring session "${id}": ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (err) {
    throw configError(`Authoring session "${id}" is not valid JSON: ${(err as Error).message}`);
  }
  const session = parseSession(raw, `"${id}"`);
  if (session.id !== id) {
    throw configError(`Authoring session file "${id}.json" has id "${session.id}".`);
  }
  return session;
}

/** Create a session document, persist it, and return the stored value. */
export function createSession(projectDir: string, input: CreateSessionInput): AuthoringSession {
  const now = new Date().toISOString();
  let session = authoringSessionSchema.parse({
    version: AUTHORING_SESSION_VERSION,
    id: input.id ?? randomUUID(),
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    warehouse_ref: input.warehouse_ref,
    discovered_snapshot_hash: input.discovered_snapshot_hash ?? null,
    glossary_answers: input.glossary_answers ?? [],
    open_ambiguities: input.open_ambiguities ?? [],
    resolved_ambiguities: input.resolved_ambiguities ?? [],
    draft_yaml: input.draft_yaml ?? {},
    draft_source_hash: input.draft_source_hash ?? null,
  });
  if (session.draft_source_hash == null && Object.keys(session.draft_yaml).length > 0) {
    session = { ...session, draft_source_hash: sessionDraftSourceHash(session) };
  }
  return saveSession(projectDir, session);
}

/** Persist a patch. Never accepts extra keys (samples, tokens, URLs). */
export function updateSession(
  projectDir: string,
  id: string,
  patch: Partial<
    Pick<
      AuthoringSession,
      | "warehouse_ref"
      | "discovered_snapshot_hash"
      | "glossary_answers"
      | "open_ambiguities"
      | "resolved_ambiguities"
      | "draft_yaml"
      | "draft_source_hash"
    >
  >,
): AuthoringSession {
  const current = loadSession(projectDir, id);
  const next: AuthoringSession = {
    ...current,
    ...patch,
    id: current.id,
    version: current.version,
    created_at: current.created_at,
    updated_at: new Date().toISOString(),
  };
  if (patch.draft_yaml !== undefined && patch.draft_source_hash === undefined) {
    next.draft_source_hash = sessionDraftSourceHash(next);
  }
  return saveSession(projectDir, next);
}

/** Secret-free warehouse locator for session state. Never includes password or token. */
export function warehouseLocator(connection: ConnectionConfig): string {
  if (connection.path) return connection.path;
  if (connection.host && connection.database) {
    const port = connection.port ? `:${connection.port}` : "";
    return `${connection.host}${port}/${connection.database}`;
  }
  if (connection.account && connection.database) return `${connection.account}/${connection.database}`;
  if (connection.project && (connection.dataset || connection.schema)) {
    return `${connection.project}/${connection.dataset || connection.schema}`;
  }
  if (connection.url) {
    try {
      const parsed = new URL(connection.url);
      parsed.username = "";
      parsed.password = "";
      const path = parsed.pathname.replace(/\/$/, "");
      return path ? `${parsed.host}${path}` : parsed.host;
    } catch {
      return connection.type;
    }
  }
  return connection.type;
}

/** Write `session` as `.grane/authoring/<id>.json`. Returns the validated document. */
export function saveSession(projectDir: string, session: AuthoringSession): AuthoringSession {
  const parsed = authoringSessionSchema.parse(session);
  assertSessionId(parsed.id);
  const dir = authoringDir(projectDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(sessionPath(projectDir, parsed.id), `${JSON.stringify(parsed, null, 2)}\n`);
  return parsed;
}

export function loadSession(projectDir: string, id: string): AuthoringSession {
  return readSessionFile(sessionPath(projectDir, assertSessionId(id)), id);
}

/** Sessions in `.grane/authoring/`, sorted by id. Missing directory → `[]`. */
export function listSessions(projectDir: string): AuthoringSession[] {
  const dir = authoringDir(projectDir);
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
  return names.map((name) => loadSession(projectDir, name.slice(0, -".json".length)));
}
