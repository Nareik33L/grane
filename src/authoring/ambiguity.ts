import type { DatabaseSchema } from "../connectors/types.js";
import { isNumericType, isTemporalType } from "../connectors/dialect.js";
import { RelationshipGraph, describeJoinPath } from "../model/graph.js";
import { parseColumnRef } from "../model/refs.js";
import type { RelationshipConfig } from "../config/schema.js";
import type { OpenAmbiguity, ResolvedAmbiguity } from "./session.js";

/**
 * Ambiguity classes V2-10 detects. Authoring asks; it does not guess.
 * `additive: none` stays unsupported (0.7.0): asked or refused, never SUM.
 */
export const AMBIGUITY_KINDS = [
  "revenue_like_columns",
  "date_columns",
  "non_additive_measure",
  "semi_additive_group_by",
  "fanout_join",
] as const;
export type AmbiguityKind = (typeof AMBIGUITY_KINDS)[number];

/** Numeric columns that might be governed revenue — never pick one silently. */
export const REVENUE_LIKE_NAME = /(amount|revenue|total|price|sales|net|gross|gmv)/i;

/**
 * Names that look like snapshots / balances. Summing them across dates is a
 * false governed number. Default is safe: ask, or refuse additive:none.
 */
export const NON_ADDITIVE_NAME =
  /(balance|stock|inventory|snapshot|outstanding|headcount|on_hand|onhand|current_|position|qty_on_hand)/i;

export const NON_ADDITIVE_CANDIDATES = ["semi", "unsupported"] as const;
/** One snapshot date for the whole result — never vacuous. */
export const GLOBAL_SNAPSHOT_GROUP_BY = "[]";
export const FANOUT_CANDIDATES = ["preaggregate", "do_not_join"] as const;

/** Quote a SQL identifier in question text. Candidates stay unquoted. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

export function quoteTableColumn(table: string, column: string): string {
  return `${quoteIdent(table)}.${quoteIdent(column)}`;
}

export interface DetectAmbiguitiesInput {
  schema: DatabaseSchema;
  relationships?: Record<string, { from: string; to: string; type: string }>;
}

export function revenueLikeAmbiguityId(table: string): string {
  return `amb-revenue-like-${table}`;
}

export function dateColumnsAmbiguityId(table: string): string {
  return `amb-date-${table}`;
}

export function nonAdditiveAmbiguityId(table: string, column: string): string {
  return `amb-non-additive-${table}-${column}`;
}

export function semiAdditiveGroupById(table: string, column: string): string {
  return `amb-semi-group-by-${table}-${column}`;
}

export function fanoutAmbiguityId(fromTable: string, toTable: string): string {
  return `amb-fanout-${fromTable}-${toTable}`;
}

export function looksRevenueLike(column: string, dataType: string): boolean {
  return isNumericType(dataType) && REVENUE_LIKE_NAME.test(column);
}

export function looksNonAdditive(column: string, dataType: string): boolean {
  return isNumericType(dataType) && NON_ADDITIVE_NAME.test(column);
}

export function looksTemporal(column: string, dataType: string): boolean {
  return isTemporalType(dataType) || /(_at|_on|date|time|day)$/i.test(column);
}

export function parseNonAdditiveAmbiguityId(id: string): { table: string; column: string } | null {
  const match = /^amb-non-additive-([A-Za-z_][A-Za-z0-9_]*)-([A-Za-z_][A-Za-z0-9_]*)$/.exec(id);
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

export function parseSemiAdditiveGroupById(id: string): { table: string; column: string } | null {
  const match = /^amb-semi-group-by-([A-Za-z_][A-Za-z0-9_]*)-([A-Za-z_][A-Za-z0-9_]*)$/.exec(id);
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

/**
 * Follow-up after resolving a snapshot as semi. Always includes `[]`
 * (global snapshot). Never offers the entity primary key (`group_by: entity`
 * is vacuous_semi_additive_group_by).
 */
export function semiAdditiveGroupByAmbiguity(
  schema: DatabaseSchema,
  table: string,
  column: string,
): OpenAmbiguity {
  const info = schema.tables.find((item) => item.name === table);
  const pk = info?.columns.find((item) => item.name === "id")?.name ?? info?.columns[0]?.name;
  const candidates = [GLOBAL_SNAPSHOT_GROUP_BY];
  for (const item of info?.columns ?? []) {
    if (item.name === pk || item.name === column) continue;
    candidates.push(`${table}.${item.name}`);
  }
  return {
    id: semiAdditiveGroupById(table, column),
    kind: "semi_additive_group_by",
    question:
      `Which series key should ${quoteTableColumn(table, column)} use for additive: semi? ` +
      `Choose "${GLOBAL_SNAPSHOT_GROUP_BY}" for one snapshot for the whole result, or a column ` +
      `that is not the entity primary key. "entity" / the primary key is refused ` +
      `(vacuous_semi_additive_group_by). Grane will not guess.`,
    candidates,
  };
}

/** Parse a resolved group_by choice into the YAML list (`[]` or `${table.column}`). */
export function parseGroupByChoice(chosen: string): string[] {
  const trimmed = chosen.trim();
  if (trimmed === GLOBAL_SNAPSHOT_GROUP_BY || trimmed === "") return [];
  const parsed = parseColumnRef(trimmed);
  if (!parsed) return [];
  return [`\${${parsed.table}.${parsed.column}}`];
}

/**
 * Time dimension for a metric table: a unique temporal column, or a resolved
 * `date_columns` choice. Never the first of several — that is a guess.
 */
export function resolvedTimeColumn(
  session: { resolved_ambiguities: ReadonlyArray<Pick<ResolvedAmbiguity, "id" | "kind" | "chosen">> },
  schema: DatabaseSchema,
  table: string,
): string | undefined {
  const chosen = session.resolved_ambiguities.find(
    (item) => item.kind === "date_columns" && item.id === dateColumnsAmbiguityId(table),
  )?.chosen;
  if (chosen) {
    const parsed = parseColumnRef(chosen);
    if (parsed?.table === table) return parsed.column;
  }
  const info = schema.tables.find((item) => item.name === table);
  const dates = (info?.columns ?? []).filter((column) => looksTemporal(column.name, column.dataType));
  if (dates.length === 1) return dates[0]!.name;
  return undefined;
}

/**
 * Detect conflicting candidates from schema + inferred relationships.
 * Questions name tables/columns only — never sample values or tokens.
 */
export function detectAmbiguities(input: DetectAmbiguitiesInput): OpenAmbiguity[] {
  const found: OpenAmbiguity[] = [
    ...detectRevenueLike(input.schema),
    ...detectDateColumns(input.schema),
    ...detectNonAdditive(input.schema),
    ...detectFanoutJoins(input.relationships ?? {}),
  ];
  return found;
}

/** Keep existing open items; skip ids already open or resolved. */
export function mergeAmbiguities(
  existingOpen: OpenAmbiguity[],
  resolved: ReadonlyArray<{ id: string }>,
  detected: OpenAmbiguity[],
): OpenAmbiguity[] {
  const skip = new Set([...existingOpen.map((item) => item.id), ...resolved.map((item) => item.id)]);
  return [...existingOpen, ...detected.filter((item) => !skip.has(item.id))];
}

function detectRevenueLike(schema: DatabaseSchema): OpenAmbiguity[] {
  const out: OpenAmbiguity[] = [];
  for (const table of schema.tables) {
    const candidates = table.columns
      .filter((column) => looksRevenueLike(column.name, column.dataType))
      .map((column) => `${table.name}.${column.name}`);
    if (candidates.length < 2) continue;
    out.push({
      id: revenueLikeAmbiguityId(table.name),
      kind: "revenue_like_columns",
      question:
        `Which column on ${quoteIdent(table.name)} is governed revenue? ` +
        `Grane will not guess. Candidates are column names only.`,
      candidates,
    });
  }
  return out;
}

function detectDateColumns(schema: DatabaseSchema): OpenAmbiguity[] {
  const out: OpenAmbiguity[] = [];
  for (const table of schema.tables) {
    const candidates = table.columns
      .filter((column) => looksTemporal(column.name, column.dataType))
      .map((column) => `${table.name}.${column.name}`);
    if (candidates.length < 2) continue;
    out.push({
      id: dateColumnsAmbiguityId(table.name),
      kind: "date_columns",
      question:
        `Which column on ${quoteIdent(table.name)} is the time dimension for this entity? ` +
        `Several date/time columns exist. Grane will not pick one.`,
      candidates,
    });
  }
  return out;
}

function detectNonAdditive(schema: DatabaseSchema): OpenAmbiguity[] {
  const out: OpenAmbiguity[] = [];
  for (const table of schema.tables) {
    for (const column of table.columns) {
      if (!looksNonAdditive(column.name, column.dataType)) continue;
      out.push({
        id: nonAdditiveAmbiguityId(table.name, column.name),
        kind: "non_additive_measure",
        question:
          `${quoteTableColumn(table.name, column.name)} looks like a snapshot or balance (non-additive). ` +
          `Summing it across dates would be a false governed number. ` +
          `Choose "semi" (one snapshot per key; Grane will then ask for group_by) or "unsupported" ` +
          `(refuse additive:none, matching Grane 0.7.0). Grane will not default to SUM.`,
        candidates: [...NON_ADDITIVE_CANDIDATES],
      });
    }
  }
  return out;
}

function detectFanoutJoins(
  relationships: Record<string, { from: string; to: string; type: string }>,
): OpenAmbiguity[] {
  const names = Object.keys(relationships);
  if (names.length === 0) return [];
  const config: Record<string, RelationshipConfig> = {};
  for (const [name, rel] of Object.entries(relationships)) {
    if (rel.type !== "many_to_one" && rel.type !== "one_to_many" && rel.type !== "one_to_one") continue;
    config[name] = { from: rel.from, to: rel.to, type: rel.type };
  }
  if (Object.keys(config).length === 0) return [];

  const graph = new RelationshipGraph(config);
  const out: OpenAmbiguity[] = [];
  const seen = new Set<string>();

  for (const rel of Object.values(config)) {
    const from = parseColumnRef(rel.from);
    const to = parseColumnRef(rel.to);
    if (!from || !to) continue;

    const child = from.table;
    const parent = to.table;
    const towardParent = graph.findPath(child, parent);
    const towardChild = graph.findPath(parent, child);

    if (towardParent?.ambiguous) {
      const id = fanoutAmbiguityId(child, parent);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({
          id,
          kind: "fanout_join",
          question:
            `Multiple join paths exist from ${quoteIdent(child)} to ${quoteIdent(parent)}. ` +
            `YAML or BFS order is not a discriminator — guessing a path would change the numbers.`,
          candidates: towardParent.alternatives?.length
            ? towardParent.alternatives
            : [describeJoinPath(towardParent)],
        });
      }
    }

    if (towardChild?.fansOut || towardChild?.fanningAmbiguous) {
      const id = fanoutAmbiguityId(parent, child);
      if (!seen.has(id)) {
        seen.add(id);
        out.push({
          id,
          kind: "fanout_join",
          question:
            `Joining ${quoteIdent(parent)} to ${quoteIdent(child)} multiplies rows ` +
            `(one ${quoteIdent(parent)} row matches many ${quoteIdent(child)} rows). ` +
            `How should measures be combined? Choose "preaggregate" to keep the relationship ` +
            `(Grane pre-aggregates the many side at query time) or "do_not_join" to omit it ` +
            `from the draft. Unresolved fan-out is not written. Grane will not guess.`,
          candidates: [...FANOUT_CANDIDATES],
        });
      }
    }
  }
  return out;
}
