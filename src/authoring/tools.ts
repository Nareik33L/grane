import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { generateDraftYaml } from "./generate.js";
import { formatProposalPlayback } from "./playback.js";
import type { GraneKernel } from "../kernel.js";
import { createDiscovery, hashDiscoverySnapshot } from "./discover.js";
import { configError } from "../errors.js";
import { loadConfig } from "../config/load.js";
import { validateModel } from "../validate/validate.js";
import { SemanticModel } from "../model/model.js";
import type { DatabaseSchema } from "../connectors/types.js";
import {
  createSession,
  loadSession,
  sessionDraftSourceHash,
  updateSession,
  warehouseLocator,
  type AuthoringSession,
  type OpenAmbiguity,
} from "./session.js";
import { createProposal, deleteProposalBranch, githubPrPlan, type GitHubPrPlan, type Proposal } from "./git.js";
import { readRelationshipsFile, type InferredRelationship } from "../discover/relationships.js";
import { readYamlMapFile } from "./yaml-merge.js";
import {
  detectAmbiguities,
  forbiddenSemiGroupByPrimaryKeyMessage,
  forbiddenSemiGroupByTemporalMessage,
  GLOBAL_SNAPSHOT_GROUP_BY,
  mergeAmbiguities,
  parseNonAdditiveAmbiguityId,
  parseSemiAdditiveGroupById,
  resolvedTimeColumn,
  semiAdditiveGroupByAmbiguity,
  semiGroupByRefusalReason,
} from "./ambiguity.js";

export function requireProjectDir(kernel: GraneKernel): string {
  if (!kernel.projectDir) {
    throw configError("Authoring tools require a project directory. Start Grane with -p <dir>.");
  }
  return kernel.projectDir;
}

function discoveryFor(kernel: GraneKernel, sessionId: string) {
  return createDiscovery({
    config: kernel.config,
    connector: kernel.getConnector(),
    projectDir: kernel.projectDir,
    sessionId,
    agent: kernel.agent?.id ?? null,
    http: kernel.http,
    // Outer MCP tool call owns the single audit line.
    audit: false,
  });
}

function publicSchema(schema: DatabaseSchema) {
  return {
    schemaName: schema.schemaName,
    tables: schema.tables.map((table) => ({
      schema: table.schema,
      name: table.name,
      columns: table.columns.map((column) => ({
        name: column.name,
        dataType: column.dataType,
        nullable: column.nullable,
      })),
    })),
  };
}

function seedAmbiguities(
  schema: DatabaseSchema,
  relationships: Record<string, { from: string; to: string; type: string }>,
  session: AuthoringSession,
): OpenAmbiguity[] {
  return mergeAmbiguities(
    session.open_ambiguities,
    session.resolved_ambiguities,
    detectAmbiguities({ schema, relationships, session }),
  );
}

export function authoringStart(kernel: GraneKernel): { session: AuthoringSession } {
  const projectDir = requireProjectDir(kernel);
  const session = createSession(projectDir, {
    warehouse_ref: {
      type: kernel.config.connection.type,
      locator: warehouseLocator(kernel.config.connection),
    },
  });
  return { session };
}

export async function discoverSchema(
  kernel: GraneKernel,
  sessionId: string,
): Promise<{
  session_id: string;
  schema: ReturnType<typeof publicSchema>;
  relationships: Record<string, { from: string; to: string; type: string }>;
  snapshot_hash: string | null;
  open_ambiguities: OpenAmbiguity[];
}> {
  const projectDir = requireProjectDir(kernel);
  loadSession(projectDir, sessionId);
  const discovery = discoveryFor(kernel, sessionId);
  const schema = await discovery.introspectSchema();
  const relationships = await discovery.inferRelationships(schema);
  const session = loadSession(projectDir, sessionId);
  const open_ambiguities = seedAmbiguities(schema, relationships, session);
  const snapshot_hash = hashDiscoverySnapshot({ schema: publicSchema(schema), relationships });
  updateSession(projectDir, sessionId, {
    discovered_snapshot_hash: snapshot_hash,
    open_ambiguities,
  });
  return {
    session_id: sessionId,
    schema: publicSchema(schema),
    relationships,
    snapshot_hash,
    open_ambiguities,
  };
}

export async function profileColumn(
  kernel: GraneKernel,
  sessionId: string,
  table: string,
  column: string,
) {
  const projectDir = requireProjectDir(kernel);
  loadSession(projectDir, sessionId);
  const discovery = discoveryFor(kernel, sessionId);
  const profile = await discovery.profileColumn(table, column);
  const persisted = loadSession(projectDir, sessionId);
  return { profile, session: persisted };
}

export function recordTerm(kernel: GraneKernel, sessionId: string, term: string, answer: string): AuthoringSession {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  const glossary_answers = [
    ...session.glossary_answers.filter((item) => item.term.toLowerCase() !== term.trim().toLowerCase()),
    { term: term.trim(), answer },
  ];
  return updateSession(projectDir, sessionId, { glossary_answers });
}

export function listAmbiguities(kernel: GraneKernel, sessionId: string): OpenAmbiguity[] {
  return loadSession(requireProjectDir(kernel), sessionId).open_ambiguities;
}

export async function resolveAmbiguity(
  kernel: GraneKernel,
  sessionId: string,
  id: string,
  chosen: string,
): Promise<AuthoringSession> {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  const open = session.open_ambiguities.find((item) => item.id === id);
  if (!open) {
    throw configError(`No open ambiguity "${id}".`);
  }
  if (open.candidates.length === 0) {
    throw configError(`Ambiguity "${id}" has no candidates to choose from.`);
  }

  if (open.kind === "semi_additive_group_by" && chosen.trim() !== GLOBAL_SNAPSHOT_GROUP_BY) {
    const parsed = parseSemiAdditiveGroupById(open.id);
    const col = parseColumn(chosen);
    if (parsed && col) {
      const schema = await discoveryFor(kernel, sessionId).introspectSchema();
      const time = resolvedTimeColumn(session, schema, parsed.table);
      const reason = semiGroupByRefusalReason(schema, parsed.table, parsed.column, col.column, time);
      if (reason === "primary_key") {
        throw configError(forbiddenSemiGroupByPrimaryKeyMessage(chosen));
      }
      if (reason === "temporal") {
        throw configError(forbiddenSemiGroupByTemporalMessage(chosen));
      }
    }
  }

  if (!open.candidates.includes(chosen)) {
    throw configError(`"${chosen}" is not a candidate for ambiguity "${id}".`);
  }

  let remaining = session.open_ambiguities.filter((item) => item.id !== id);
  const resolved = [...session.resolved_ambiguities, { ...open, chosen }];

  if (open.kind === "non_additive_measure" && chosen === "semi") {
    const parsed = parseNonAdditiveAmbiguityId(open.id);
    if (parsed) {
      const schema = await discoveryFor(kernel, sessionId).introspectSchema();
      const time = resolvedTimeColumn(session, schema, parsed.table);
      const followUp = semiAdditiveGroupByAmbiguity(schema, parsed.table, parsed.column, time);
      const already =
        remaining.some((item) => item.id === followUp.id) || resolved.some((item) => item.id === followUp.id);
      if (!already) remaining = [...remaining, followUp];
    }
  }

  return updateSession(projectDir, sessionId, {
    open_ambiguities: remaining,
    resolved_ambiguities: resolved,
  });
}

/**
 * Stop preview writes from escaping the temp dir (`..` / absolute).
 * `.git` and `.grane` are left to `createProposal` / `gitPath`.
 */
function assertDraftYamlPath(rel: string): void {
  const normalised = rel.replaceAll("\\", "/");
  if (!rel || isAbsolute(rel) || isAbsolute(normalised) || normalised.split("/").includes("..")) {
    throw configError(`Refusing to commit path "${rel}" onto a proposal branch.`);
  }
}

function unresolvedFlag(open: OpenAmbiguity[]): {
  unresolved_ambiguities: OpenAmbiguity[];
  unresolved: boolean;
  warning?: string;
} {
  if (open.length === 0) {
    return { unresolved_ambiguities: [], unresolved: false };
  }
  const ids = open.map((item) => item.id).join(", ");
  return {
    unresolved_ambiguities: open,
    unresolved: true,
    warning: `submit_proposal will refuse until ${open.length} open ambiguities are resolved (${ids}).`,
  };
}

function parseColumn(ref: string): { table: string; column: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

function catalogRelationshipsOf(kernel: GraneKernel): Record<string, InferredRelationship> {
  const out: Record<string, InferredRelationship> = {};
  for (const [name, rel] of Object.entries(kernel.config.relationships)) {
    out[name] = { from: rel.from, to: rel.to, type: rel.type };
  }
  return out;
}

export async function proposeDefinitions(
  kernel: GraneKernel,
  sessionId: string,
): Promise<
  AuthoringSession & {
    unresolved_ambiguities: OpenAmbiguity[];
    unresolved: boolean;
    warning?: string;
    skipped_tables: string[];
    playback: string;
  }
> {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  const discovery = discoveryFor(kernel, sessionId);
  const schema = await discovery.introspectSchema();
  const inferred = await discovery.inferRelationships(schema);
  const open_ambiguities = seedAmbiguities(schema, inferred, session);
  const sessionForDraft =
    open_ambiguities === session.open_ambiguities
      ? session
      : updateSession(projectDir, sessionId, { open_ambiguities });
  const { files: draft_yaml, skipped_tables } = generateDraftYaml({
    session: sessionForDraft,
    schema,
    inferred,
    fileRelationships: readRelationshipsFile(projectDir).relationships,
    catalogRelationships: catalogRelationshipsOf(kernel),
    fileEntities: readYamlMapFile(projectDir, "entities") as Record<string, Record<string, unknown>>,
    fileMetrics: readYamlMapFile(projectDir, "metrics") as Record<string, Record<string, unknown>>,
  });
  const updated = updateSession(projectDir, sessionId, {
    draft_yaml,
    open_ambiguities: sessionForDraft.open_ambiguities,
  });
  const flag = unresolvedFlag(updated.open_ambiguities);
  const skipNote =
    skipped_tables.length > 0
      ? `Skipped tables without a usable primary key: ${skipped_tables.join(", ")}.`
      : undefined;
  const warning = [flag.warning, skipNote].filter(Boolean).join(" ");
  return {
    ...updated,
    ...flag,
    skipped_tables,
    playback: formatProposalPlayback(draft_yaml),
    ...(warning ? { warning } : {}),
  };
}

export function previewYaml(kernel: GraneKernel, sessionId: string): {
  files: Record<string, string>;
  validation: { ok: boolean; issues: { severity: string; code: string; subject: string; message: string }[] };
  unresolved_ambiguities: OpenAmbiguity[];
  unresolved: boolean;
  warning?: string;
} {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  if (Object.keys(session.draft_yaml).length === 0) {
    throw configError("No draft YAML. Call propose_definitions first.");
  }
  const flag = unresolvedFlag(session.open_ambiguities);
  const tmp = mkdtempSync(join(tmpdir(), "grane-authoring-preview-"));
  try {
    writeFileSync(
      join(tmp, "grane.yml"),
      stringifyYaml({
        project: { name: kernel.config.project.name, timezone: kernel.config.project.timezone },
        connection: { type: kernel.config.connection.type, schema: kernel.config.connection.schema ?? "public" },
      }),
    );
    for (const [rel, contents] of Object.entries(session.draft_yaml)) {
      assertDraftYamlPath(rel);
      const path = resolve(tmp, rel);
      const fromTmp = relative(tmp, path).replaceAll(sep, "/");
      if (fromTmp.startsWith("..") || isAbsolute(fromTmp)) {
        throw configError(`Refusing to commit path "${rel}" onto a proposal branch.`);
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const loaded = loadConfig(tmp);
    const report = validateModel(new SemanticModel(loaded.config), undefined, { generated: true });
    return {
      files: session.draft_yaml,
      validation: {
        ok: report.ok,
        issues: report.issues.map((issue) => ({
          severity: issue.severity,
          code: issue.code,
          subject: issue.subject,
          message: issue.message,
        })),
      },
      ...flag,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function submitProposal(
  kernel: GraneKernel,
  sessionId: string,
  slug?: string,
): { proposal: Proposal; github: GitHubPrPlan } {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  if (Object.keys(session.draft_yaml).length === 0) {
    throw configError("No draft YAML. Call propose_definitions first.");
  }
  const currentHash = sessionDraftSourceHash(session);
  if (!session.draft_source_hash || session.draft_source_hash !== currentHash) {
    throw configError(
      "Session changed after propose_definitions. Call propose_definitions again before submit_proposal.",
      { draft_source_hash: session.draft_source_hash, current_hash: currentHash },
    );
  }
  for (const rel of Object.keys(session.draft_yaml)) {
    assertDraftYamlPath(rel);
  }
  if (session.open_ambiguities.length > 0) {
    const listed = session.open_ambiguities
      .map((item) => `${item.id}: ${item.question}`)
      .join("; ");
    throw configError(`Unresolved ambiguities must be resolved before submit_proposal. ${listed}`, {
      unresolved_ambiguities: session.open_ambiguities,
    });
  }
  let preview: ReturnType<typeof previewYaml>;
  try {
    preview = previewYaml(kernel, sessionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw configError(`Draft YAML does not validate. ${message}`);
  }
  if (!preview.validation.ok) {
    throw configError("Draft YAML does not validate. Fix the draft before submit_proposal.", {
      issues: preview.validation.issues,
    });
  }
  const proposal = createProposal(projectDir, {
    slug: slug?.trim() || `session-${sessionId.slice(0, 8)}`,
    files: session.draft_yaml,
    title: `Grane authoring proposal from session ${sessionId}`,
  });
  return { proposal, github: githubPrPlan(projectDir, proposal.id) };
}

/** Undo a proposal branch after a failed post-submit audit. MCP must not call git delete itself. */
export function revertFailedProposal(projectDir: string, branch: string): void {
  deleteProposalBranch(projectDir, branch);
}
