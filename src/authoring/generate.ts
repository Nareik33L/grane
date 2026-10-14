import { stringify as stringifyYaml } from "yaml";
import type { DatabaseSchema } from "../connectors/types.js";
import { planRelationshipWrite, type InferredRelationship } from "../discover/relationships.js";
import { configError } from "../errors.js";
import { parseColumnRef } from "../model/refs.js";
import {
  fanoutAmbiguityId,
  isForbiddenSemiGroupByColumn,
  looksNonAdditive,
  looksRevenueLike,
  parseGroupByChoice,
  parseNonAdditiveAmbiguityId,
  resolvedEntityPrimaryKey,
  resolvedTimeColumn,
  semiAdditiveGroupById,
} from "./ambiguity.js";
import type { AuthoringSession } from "./session.js";
import { compareOrdinal, mergeNamedDefs } from "./yaml-merge.js";

export interface GenerateDraftInput {
  session: AuthoringSession;
  schema: DatabaseSchema;
  inferred: Record<string, InferredRelationship>;
  /** Existing catalog relationships — skipped by planRelationshipWrite. */
  catalogRelationships?: Record<string, InferredRelationship>;
  fileRelationships?: Record<string, InferredRelationship>;
  fileEntities?: Record<string, Record<string, unknown>>;
  fileMetrics?: Record<string, Record<string, unknown>>;
}

export interface GenerateDraftResult {
  files: Record<string, string>;
  skipped_tables: string[];
}

function parseColumn(ref: string): { table: string; column: string } | null {
  return parseColumnRef(ref);
}

/**
 * Glossary terms (e.g. "revenue") bind to a unique revenue-like column when
 * there is no revenue_like_columns ambiguity. Demo shop `orders.net_amount`
 * is the usual case — asking would be guessing among one candidate.
 * Several unique sources: prefer `orders`, otherwise refuse to guess.
 */
function uniqueRevenueLikeSource(
  session: AuthoringSession,
  schema: DatabaseSchema,
  slug: string,
): { table: string; column: string } | null {
  const sources: { table: string; column: string }[] = [];
  for (const table of schema.tables) {
    if (!resolvedEntityPrimaryKey(session, schema, table.name)) continue;
    const cols = table.columns.filter(
      (column) => looksRevenueLike(column.name, column.dataType) && !looksNonAdditive(column.name, column.dataType),
    );
    if (cols.length !== 1) continue;
    sources.push({ table: table.name, column: cols[0]!.name });
  }
  if (sources.length === 0) return null;
  const compact = slug.replace(/_/g, "");
  const named = sources.filter(
    (item) => item.column === slug || item.column.replace(/_/g, "") === compact,
  );
  if (named.length === 1) return named[0]!;
  if (slug === "revenue") {
    const orders = sources.find((item) => item.table === "orders");
    if (orders) return orders;
  }
  return sources.length === 1 ? sources[0]! : null;
}

function sortRecord<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => compareOrdinal(a, b)));
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
export function generateDraftYaml(input: GenerateDraftInput): GenerateDraftResult {
  const { session, schema, inferred } = input;
  const metrics: Record<string, Record<string, unknown>> = {};
  const entities: Record<string, Record<string, unknown>> = {};
  const skipped = new Set<string>();

  const addEntity = (table: string): boolean => {
    if (entities[table]) return true;
    const pk = resolvedEntityPrimaryKey(session, schema, table);
    if (!pk) {
      skipped.add(table);
      return false;
    }
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
    if (resolved.kind === "primary_key") continue;
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
    if (!slug) continue;
    if (metrics[slug]) {
      if (entry.answer && !metrics[slug]!.description) {
        metrics[slug] = { ...metrics[slug], description: entry.answer };
      }
      continue;
    }
    const fromResolved = session.resolved_ambiguities.find(
      (item) => item.kind === "revenue_like_columns" && parseColumn(item.chosen),
    );
    const parsed = fromResolved
      ? parseColumn(fromResolved.chosen)
      : uniqueRevenueLikeSource(session, schema, slug);
    if (!parsed) continue;
    if (slug === "revenue" && metrics.revenue) {
      if (entry.answer && !metrics.revenue.description) {
        metrics.revenue = { ...metrics.revenue, description: entry.answer };
      }
      continue;
    }
    addMetric(slug, parsed.table, parsed.column, entry.answer);
  }

  for (const table of schema.tables) {
    if (entities[table.name]) continue;
    if (!resolvedEntityPrimaryKey(session, schema, table.name)) skipped.add(table.name);
  }

  const skipped_tables = [...skipped].sort(compareOrdinal);
  if (Object.keys(metrics).length === 0) {
    const skipNote =
      skipped_tables.length > 0
        ? ` Skipped tables without a usable primary key: ${skipped_tables.join(", ")}. Resolve the primary_key ambiguity first.`
        : "";
    throw configError(`Nothing to propose. Record glossary terms or resolve ambiguities first.${skipNote}`);
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

  const mergedEntities = mergeNamedDefs(
    input.fileEntities ?? {},
    entities,
    "entity",
    "entities.yml",
  );
  const mergedMetrics = mergeNamedDefs(input.fileMetrics ?? {}, metrics, "metric", "metrics.yml");

  const files: Record<string, string> = {
    "entities.yml": stringifyYaml({ entities: sortRecord(mergedEntities) }),
    "metrics.yml": stringifyYaml({ metrics: sortRecord(mergedMetrics) }),
  };
  if (Object.keys(plan.nextFile).length > 0) {
    const preaggNotes = session.resolved_ambiguities
      .filter((item) => item.kind === "fanout_join" && item.chosen === "preaggregate")
      .map((item) => `# authoring fan-out ${item.id}: preaggregate`)
      .sort(compareOrdinal);
    const body = stringifyYaml({ relationships: sortRecord(plan.nextFile) });
    files["relationships.yml"] = preaggNotes.length > 0 ? `${preaggNotes.join("\n")}\n${body}` : body;
  }
  return { files, skipped_tables };
}
