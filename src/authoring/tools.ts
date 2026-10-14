import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { GraneKernel } from "../kernel.js";
import { createDiscovery, hashDiscoverySnapshot } from "./discover.js";
import { configError } from "../errors.js";
import { loadConfig } from "../config/load.js";
import { validateModel } from "../validate/validate.js";
import { SemanticModel } from "../model/model.js";
import type { DatabaseSchema } from "../connectors/types.js";
import { parseColumnRef } from "../model/refs.js";
import {
  createSession,
  loadSession,
  updateSession,
  warehouseLocator,
  type AuthoringSession,
  type OpenAmbiguity,
} from "./session.js";
import { createProposal, githubPrPlan, type GitHubPrPlan, type Proposal } from "./git.js";
import {
  detectAmbiguities,
  fanoutAmbiguityId,
  forbiddenSemiGroupByMessage,
  GLOBAL_SNAPSHOT_GROUP_BY,
  isForbiddenSemiGroupByColumn,
  looksNonAdditive,
  mergeAmbiguities,
  parseGroupByChoice,
  parseNonAdditiveAmbiguityId,
  parseSemiAdditiveGroupById,
  resolvedTimeColumn,
  semiAdditiveGroupByAmbiguity,
  semiAdditiveGroupById,
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
    detectAmbiguities({ schema, relationships }),
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
      if (isForbiddenSemiGroupByColumn(schema, parsed.table, parsed.column, col.column, time)) {
        throw configError(forbiddenSemiGroupByMessage(chosen));
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

function relationshipOnChosenPath(
  rel: { from: string; to: string },
  chosen: string,
): boolean {
  if (chosen === "preaggregate") return true;
  if (chosen === "do_not_join") return false;
  const from = parseColumnRef(rel.from);
  const to = parseColumnRef(rel.to);
  if (!from || !to) return false;
  const forward = `${from.table}.${from.column} → ${to.table}.${to.column}`;
  const reverse = `${to.table}.${to.column} → ${from.table}.${from.column}`;
  return chosen.includes(forward) || chosen.includes(reverse);
}

/** Keep a relationship only when fan-out is resolved as preaggregate (or a chosen path). */
function includeInferredRelationship(
  rel: { from: string; to: string },
  session: AuthoringSession,
): boolean {
  const from = parseColumnRef(rel.from);
  const to = parseColumnRef(rel.to);
  if (!from || !to) return false;
  const fanningId = fanoutAmbiguityId(to.table, from.table);
  const pathId = fanoutAmbiguityId(from.table, to.table);
  const resolvedFanout = session.resolved_ambiguities.filter((item) => item.kind === "fanout_join");
  const openFanout = session.open_ambiguities.filter((item) => item.kind === "fanout_join");
  const fanning = resolvedFanout.find((item) => item.id === fanningId);
  const path = resolvedFanout.find((item) => item.id === pathId);

  if (fanning?.chosen === "do_not_join" || path?.chosen === "do_not_join") return false;
  if (openFanout.some((item) => item.id === fanningId || item.id === pathId)) return false;
  if (fanning?.chosen === "preaggregate") {
    return path ? relationshipOnChosenPath(rel, path.chosen) : true;
  }
  if (path) return relationshipOnChosenPath(rel, path.chosen);
  return true;
}

function parseColumn(ref: string): { table: string; column: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

export async function proposeDefinitions(
  kernel: GraneKernel,
  sessionId: string,
): Promise<
  AuthoringSession & {
    unresolved_ambiguities: OpenAmbiguity[];
    unresolved: boolean;
    warning?: string;
  }
> {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  const discovery = discoveryFor(kernel, sessionId);
  const schema = await discovery.introspectSchema();
  const inferred = await discovery.inferRelationships(schema);

  const metrics: Record<string, Record<string, unknown>> = {};
  const entities: Record<string, Record<string, unknown>> = {};

  const addEntity = (table: string) => {
    if (entities[table]) return;
    const info = schema.tables.find((item) => item.name === table);
    const pk = info?.columns.find((column) => column.name === "id")?.name ?? info?.columns[0]?.name;
    if (!pk) return;
    entities[table] = { table, primary_key: pk };
  };

  const addMetric = (
    name: string,
    table: string,
    column: string,
    description?: string,
    additive?: "semi",
    groupBy?: string[],
  ) => {
    addEntity(table);
    const time = resolvedTimeColumn(session, schema, table);
    metrics[name] = {
      entity: table,
      type: "sum",
      sql: `\${${table}.${column}}`,
      status: "experimental",
      ...(additive === "semi"
        ? { additive: "semi", semi_additive: { window: "last", group_by: groupBy ?? [] } }
        : {}),
      ...(description ? { description } : {}),
      ...(time ? { time_dimension: `\${${table}.${time}}` } : {}),
    };
  };

  for (const resolved of session.resolved_ambiguities) {
    if (resolved.kind === "fanout_join") continue;
    if (resolved.kind === "date_columns") continue;
    if (resolved.kind === "semi_additive_group_by") continue;
    if (resolved.kind === "non_additive_measure") {
      const parsed = parseNonAdditiveAmbiguityId(resolved.id) ?? parseColumn(resolved.candidates[0] ?? "");
      if (!parsed) continue;
      if (resolved.chosen === "unsupported") continue;
      if (resolved.chosen === "semi") {
        const group = session.resolved_ambiguities.find(
          (item) =>
            item.kind === "semi_additive_group_by" &&
            item.id === semiAdditiveGroupById(parsed.table, parsed.column),
        );
        if (!group) continue;
        const groupCol = parseColumn(group.chosen);
        const time = resolvedTimeColumn(session, schema, parsed.table);
        if (
          groupCol &&
          isForbiddenSemiGroupByColumn(schema, parsed.table, parsed.column, groupCol.column, time)
        ) {
          continue;
        }
        addMetric(parsed.column, parsed.table, parsed.column, undefined, "semi", parseGroupByChoice(group.chosen));
      }
      continue;
    }
    const parsed = parseColumn(resolved.chosen);
    if (!parsed) continue;
    const info = schema.tables
      .find((item) => item.name === parsed.table)
      ?.columns.find((column) => column.name === parsed.column);
    if (info && looksNonAdditive(parsed.column, info.dataType)) continue;
    const name = resolved.kind === "revenue_like_columns" ? "revenue" : parsed.column;
    addMetric(name, parsed.table, parsed.column);
  }

  for (const entry of session.glossary_answers) {
    const slug = entry.term.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (!slug || metrics[slug]) continue;
    const fromResolved = session.resolved_ambiguities.find(
      (item) => item.kind === "revenue_like_columns" && parseColumn(item.chosen),
    );
    const parsed = fromResolved ? parseColumn(fromResolved.chosen) : null;
    if (!parsed) continue;
    if (slug === "revenue" && metrics.revenue) {
      metrics.revenue = { ...metrics.revenue, description: entry.answer };
      continue;
    }
    if (!metrics[slug]) addMetric(slug, parsed.table, parsed.column, entry.answer);
  }

  if (Object.keys(metrics).length === 0) {
    throw configError("Nothing to propose. Record glossary terms or resolve ambiguities first.");
  }

  const relationships: Record<string, { from: string; to: string; type: string }> = {};
  for (const [name, rel] of Object.entries(inferred)) {
    if (!includeInferredRelationship(rel, session)) continue;
    relationships[name] = { from: rel.from, to: rel.to, type: rel.type };
  }

  const draft_yaml: Record<string, string> = {
    "entities.yml": stringifyYaml({ entities }),
    "metrics.yml": stringifyYaml({ metrics }),
  };
  if (Object.keys(relationships).length > 0) {
    const preaggNotes = session.resolved_ambiguities
      .filter((item) => item.kind === "fanout_join" && item.chosen === "preaggregate")
      .map((item) => `# authoring fan-out ${item.id}: preaggregate`);
    const body = stringifyYaml({ relationships });
    draft_yaml["relationships.yml"] = preaggNotes.length > 0 ? `${preaggNotes.join("\n")}\n${body}` : body;
  }

  const updated = updateSession(projectDir, sessionId, { draft_yaml });
  return { ...updated, ...unresolvedFlag(updated.open_ambiguities) };
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
      const path = join(tmp, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const loaded = loadConfig(tmp);
    const report = validateModel(new SemanticModel(loaded.config));
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
