import { stringify as stringifyYaml } from "yaml";
import type { DatabaseSchema } from "../connectors/types.js";
import { tablePrimaryKey } from "../connectors/types.js";
import { planRelationshipWrite, type InferredRelationship } from "../discover/relationships.js";
import { configError } from "../errors.js";
import { parseColumnRef } from "../model/refs.js";
import {
  fanoutAmbiguityId,
  isForbiddenSemiGroupByColumn,
  looksNonAdditive,
  parseGroupByChoice,
  parseNonAdditiveAmbiguityId,
  resolvedTimeColumn,
  semiAdditiveGroupById,
} from "./ambiguity.js";
import type { AuthoringSession } from "./session.js";

export interface GenerateDraftInput {
  session: AuthoringSession;
  schema: DatabaseSchema;
  inferred: Record<string, InferredRelationship>;
  /** Existing catalog relationships — skipped by planRelationshipWrite. */
  catalogRelationships?: Record<string, InferredRelationship>;
  fileRelationships?: Record<string, InferredRelationship>;
}

function parseColumn(ref: string): { table: string; column: string } | null {
  return parseColumnRef(ref);
}

function sortRecord<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

function relationshipOnChosenPath(rel: { from: string; to: string }, chosen: string): boolean {
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
export function includeInferredRelationship(
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

/**
 * Turn an authoring session into YAML in the current Grane schema.
 * Relationships go through `planRelationshipWrite`. Deterministic: same
 * session + schema + inferred map yields the same bytes. Never emits an
 * exploration allow-list wildcard.
 */
export function generateDraftYaml(input: GenerateDraftInput): { files: Record<string, string> } {
  const { session, schema, inferred } = input;
  const metrics: Record<string, Record<string, unknown>> = {};
  const entities: Record<string, Record<string, unknown>> = {};

  const addEntity = (table: string): boolean => {
    if (entities[table]) return true;
    const info = schema.tables.find((item) => item.name === table);
    const pk = tablePrimaryKey(info);
    if (!pk) return false;
    entities[table] = { table, primary_key: pk };
    return true;
  };

  const addMetric = (
    name: string,
    table: string,
    column: string,
    description?: string,
    additive?: "semi",
    groupBy?: string[],
  ) => {
    if (!addEntity(table)) return;
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

  const allowed: Record<string, InferredRelationship> = {};
  for (const [name, rel] of Object.entries(inferred)) {
    if (!includeInferredRelationship(rel, session)) continue;
    allowed[name] = { from: rel.from, to: rel.to, type: rel.type };
  }
  const plan = planRelationshipWrite({
    fileRelationships: input.fileRelationships ?? {},
    catalogRelationships: input.catalogRelationships ?? {},
    inferred: allowed,
  });

  const files: Record<string, string> = {
    "entities.yml": stringifyYaml({ entities: sortRecord(entities) }),
    "metrics.yml": stringifyYaml({ metrics: sortRecord(metrics) }),
  };
  if (Object.keys(plan.nextFile).length > 0) {
    const preaggNotes = session.resolved_ambiguities
      .filter((item) => item.kind === "fanout_join" && item.chosen === "preaggregate")
      .map((item) => `# authoring fan-out ${item.id}: preaggregate`)
      .sort();
    const body = stringifyYaml({ relationships: sortRecord(plan.nextFile) });
    files["relationships.yml"] = preaggNotes.length > 0 ? `${preaggNotes.join("\n")}\n${body}` : body;
  }
  return { files };
}
