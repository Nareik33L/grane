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
  looksNonAdditive,
  mergeAmbiguities,
  parseNonAdditiveAmbiguityId,
  resolvedTimeColumn,
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

export function resolveAmbiguity(kernel: GraneKernel, sessionId: string, id: string, chosen: string): AuthoringSession {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  const open = session.open_ambiguities.find((item) => item.id === id);
  if (!open) {
    throw configError(`No open ambiguity "${id}".`);
  }
  if (open.candidates.length > 0 && !open.candidates.includes(chosen)) {
    throw configError(`"${chosen}" is not a candidate for ambiguity "${id}".`);
  }
  return updateSession(projectDir, sessionId, {
    open_ambiguities: session.open_ambiguities.filter((item) => item.id !== id),
    resolved_ambiguities: [...session.resolved_ambiguities, { ...open, chosen }],
  });
}

function parseColumn(ref: string): { table: string; column: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(ref.trim());
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

export async function proposeDefinitions(kernel: GraneKernel, sessionId: string): Promise<AuthoringSession> {
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
  ) => {
    addEntity(table);
    const time = resolvedTimeColumn(session, schema, table);
    metrics[name] = {
      entity: table,
      type: "sum",
      sql: `\${${table}.${column}}`,
      status: "experimental",
      ...(additive ? { additive } : {}),
      ...(description ? { description } : {}),
      ...(time ? { time_dimension: `\${${table}.${time}}` } : {}),
    };
  };

  for (const resolved of session.resolved_ambiguities) {
    if (resolved.kind === "fanout_join") continue;
    if (resolved.kind === "date_columns") continue;
    if (resolved.kind === "non_additive_measure") {
      const parsed = parseNonAdditiveAmbiguityId(resolved.id) ?? parseColumn(resolved.candidates[0] ?? "");
      if (!parsed) continue;
      if (resolved.chosen === "unsupported") continue;
      if (resolved.chosen === "semi") {
        addMetric(parsed.column, parsed.table, parsed.column, undefined, "semi");
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

  const skipFanout = new Set(
    session.resolved_ambiguities
      .filter((item) => item.kind === "fanout_join" && item.chosen === "do_not_join")
      .map((item) => item.id),
  );
  const relationships: Record<string, { from: string; to: string; type: string }> = {};
  for (const [name, rel] of Object.entries(inferred)) {
    const from = parseColumnRef(rel.from);
    const to = parseColumnRef(rel.to);
    if (
      from &&
      to &&
      (skipFanout.has(fanoutAmbiguityId(from.table, to.table)) ||
        skipFanout.has(fanoutAmbiguityId(to.table, from.table)))
    ) {
      continue;
    }
    relationships[name] = { from: rel.from, to: rel.to, type: rel.type };
  }

  const draft_yaml: Record<string, string> = {
    "entities.yml": stringifyYaml({ entities }),
    "metrics.yml": stringifyYaml({ metrics }),
  };
  if (Object.keys(relationships).length > 0) {
    draft_yaml["relationships.yml"] = stringifyYaml({ relationships });
  }

  return updateSession(projectDir, sessionId, { draft_yaml });
}

export function previewYaml(kernel: GraneKernel, sessionId: string): {
  files: Record<string, string>;
  validation: { ok: boolean; issues: { severity: string; code: string; subject: string; message: string }[] };
} {
  const projectDir = requireProjectDir(kernel);
  const session = loadSession(projectDir, sessionId);
  if (Object.keys(session.draft_yaml).length === 0) {
    throw configError("No draft YAML. Call propose_definitions first.");
  }
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
  const proposal = createProposal(projectDir, {
    slug: slug?.trim() || `session-${sessionId.slice(0, 8)}`,
    files: session.draft_yaml,
    title: `Grane authoring proposal from session ${sessionId}`,
  });
  return { proposal, github: githubPrPlan(projectDir, proposal.id) };
}
