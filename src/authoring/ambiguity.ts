import {
  grainUniqueColumns,
  isCompositePrimaryKey,
  tablePrimaryKey,
  tablePrimaryKeyColumns,
  type DatabaseSchema,
  type TableInfo,
} from "../connectors/types.js";
import { isNumericType, looksTemporal } from "../connectors/dialect.js";
import { RelationshipGraph, describeJoinPath } from "../model/graph.js";
import { parseColumnRef } from "../model/refs.js";
import type { RelationshipConfig } from "../config/schema.js";
import type { OpenAmbiguity, ResolvedAmbiguity } from "./session.js";
import { compareOrdinal } from "./yaml-merge.js";

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
  "primary_key",
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
/** Decline to author a table that has no usable single-column grain. */
export const PRIMARY_KEY_SKIP = "skip";

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

/** Cross-table unique revenue-like columns — not a warehouse-specific table name. */
export const CROSS_TABLE_REVENUE_LIKE_ID = "amb-revenue-like";

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

export function primaryKeyAmbiguityId(table: string): string {
  return `amb-primary-key-${table}`;
}

export function looksRevenueLike(column: string, dataType: string): boolean {
  return isNumericType(dataType) && REVENUE_LIKE_NAME.test(column);
}

export function looksNonAdditive(column: string, dataType: string): boolean {
  return isNumericType(dataType) && NON_ADDITIVE_NAME.test(column);
}

export { looksTemporal } from "../connectors/dialect.js";

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
 * is vacuous_semi_additive_group_by) or a temporal / time_dimension column
 * (that keeps one row per timestamp and sums every snapshot).
 */
export function semiAdditiveGroupByAmbiguity(
  schema: DatabaseSchema,
  table: string,
  column: string,
  timeColumn?: string,
): OpenAmbiguity {
  const info = schema.tables.find((item) => item.name === table);
  const candidates = [GLOBAL_SNAPSHOT_GROUP_BY];
  for (const item of info?.columns ?? []) {
    if (isForbiddenSemiGroupByColumn(schema, table, column, item.name, timeColumn)) continue;
    candidates.push(`${table}.${item.name}`);
  }
  return {
    id: semiAdditiveGroupById(table, column),
    kind: "semi_additive_group_by",
    question:
      `Which series key should ${quoteTableColumn(table, column)} use for additive: semi? ` +
      `Choose "${GLOBAL_SNAPSHOT_GROUP_BY}" for one snapshot for the whole result, or a ` +
      `non-temporal column that is not the entity primary key. "entity" / the primary key ` +
      `is refused (vacuous_semi_additive_group_by). The time dimension is refused — grouping ` +
      `by it would sum every snapshot. Grane will not guess.`,
    candidates,
  };
}

export type SemiGroupByRefusal = "primary_key" | "temporal" | "measure";

/**
 * Why `groupColumn` must not be a semi-additive series key. Uses introspected
 * PRIMARY KEY metadata only — never guesses `id` or the first column.
 */
export function semiGroupByRefusalReason(
  schema: DatabaseSchema,
  table: string,
  measureColumn: string,
  groupColumn: string,
  timeColumn?: string,
): SemiGroupByRefusal | null {
  if (groupColumn === measureColumn) return "measure";
  if (timeColumn && groupColumn === timeColumn) return "temporal";
  const info = schema.tables.find((item) => item.name === table);
  if (tablePrimaryKey(info) === groupColumn) return "primary_key";
  const col = info?.columns.find((item) => item.name === groupColumn);
  if (col && looksTemporal(col.name, col.dataType)) return "temporal";
  if (!col && looksTemporal(groupColumn, "")) return "temporal";
  return null;
}

export function isForbiddenSemiGroupByColumn(
  schema: DatabaseSchema,
  table: string,
  measureColumn: string,
  groupColumn: string,
  timeColumn?: string,
): boolean {
  return semiGroupByRefusalReason(schema, table, measureColumn, groupColumn, timeColumn) !== null;
}

export function forbiddenSemiGroupByTemporalMessage(chosen: string): string {
  return (
    `"${chosen}" is a temporal column or the metric time dimension. ` +
    `Grouping by it keeps one row per timestamp and sums every snapshot — ` +
    `the double count additive: semi exists to prevent. ` +
    `Choose "${GLOBAL_SNAPSHOT_GROUP_BY}" or a non-temporal series key.`
  );
}

export function forbiddenSemiGroupByPrimaryKeyMessage(chosen: string): string {
  return (
    `"${chosen}" is the entity primary key (introspected grain). ` +
    `group_by on that key is vacuous_semi_additive_group_by: first/last cannot ` +
    `collapse history. Choose "${GLOBAL_SNAPSHOT_GROUP_BY}" or a non-key series column.`
  );
}

/** @deprecated Use forbiddenSemiGroupByTemporalMessage — kept as the temporal wording. */
export function forbiddenSemiGroupByMessage(chosen: string): string {
  return forbiddenSemiGroupByTemporalMessage(chosen);
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
 * Entity grain: a resolved `primary_key` choice, or an introspected
 * single-column PRIMARY KEY. Never a composite-key column (false grain)
 * unless that column has its own single-column UNIQUE constraint. `skip`
 * means do not author the table.
 */
export function resolvedEntityPrimaryKey(
  session: { resolved_ambiguities: ReadonlyArray<Pick<ResolvedAmbiguity, "id" | "kind" | "chosen">> },
  schema: DatabaseSchema,
  table: string,
): string | undefined {
  const info = schema.tables.find((item) => item.name === table);
  const chosen = session.resolved_ambiguities.find(
    (item) => item.kind === "primary_key" && item.id === primaryKeyAmbiguityId(table),
  )?.chosen;
  if (chosen === PRIMARY_KEY_SKIP) return undefined;
  if (chosen) {
    const parsed = parseColumnRef(chosen);
    if (parsed?.table === table) {
      if (isCompositePrimaryKey(info) && !grainUniqueColumns(info).includes(parsed.column)) {
        return undefined;
      }
      if ((info?.uniqueColumns ?? []).includes(parsed.column) && !grainUniqueColumns(info).includes(parsed.column)) {
        return undefined;
      }
      return parsed.column;
    }
  }
  return tablePrimaryKey(info);
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
    ...detectPrimaryKeys(input.schema),
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

function primaryKeyAmbiguity(table: TableInfo): OpenAmbiguity | null {
  const pkCols = tablePrimaryKeyColumns(table);
  if (pkCols.length === 1) return null;
  if (isCompositePrimaryKey(table)) {
    const unique = grainUniqueColumns(table);
    if (unique.length === 0) return null;
    return {
      id: primaryKeyAmbiguityId(table.name),
      kind: "primary_key",
      question:
        `Table ${quoteIdent(table.name)} has a composite PRIMARY KEY ` +
        `(${pkCols.map(quoteIdent).join(", ")}). Picking one key column would be a false grain. ` +
        `Choose a column that has its own single-column UNIQUE constraint, or "${PRIMARY_KEY_SKIP}". ` +
        `Grane will not guess.`,
      candidates: [...unique.map((column) => `${table.name}.${column}`), PRIMARY_KEY_SKIP],
    };
  }
  const hasMeasure = table.columns.some((column) => isNumericType(column.dataType));
  if (!hasMeasure) return null;
  const candidates = table.columns.map((column) => `${table.name}.${column.name}`);
  if (candidates.length === 0) return null;
  return {
    id: primaryKeyAmbiguityId(table.name),
    kind: "primary_key",
    question:
      `No PRIMARY KEY was introspected on ${quoteIdent(table.name)}. ` +
      `Which column is the entity grain? Choose "${PRIMARY_KEY_SKIP}" to omit this table. ` +
      `Grane will not guess id or the first column.`,
    candidates: [...candidates, PRIMARY_KEY_SKIP],
  };
}

function detectPrimaryKeys(schema: DatabaseSchema): OpenAmbiguity[] {
  const out: OpenAmbiguity[] = [];
  for (const table of schema.tables) {
    const item = primaryKeyAmbiguity(table);
    if (item) out.push(item);
  }
  return out;
}

function detectRevenueLike(schema: DatabaseSchema): OpenAmbiguity[] {
  const out: OpenAmbiguity[] = [];
  const uniqueSources: string[] = [];
  for (const table of schema.tables) {
    const revenueCols = table.columns.filter((column) => looksRevenueLike(column.name, column.dataType));
    const candidates = revenueCols.map((column) => `${table.name}.${column.name}`);
    if (candidates.length >= 2) {
      out.push({
        id: revenueLikeAmbiguityId(table.name),
        kind: "revenue_like_columns",
        question:
          `Which column on ${quoteIdent(table.name)} is governed revenue? ` +
          `Grane will not guess. Candidates are column names only.`,
        candidates,
      });
      continue;
    }
    const unique = revenueCols.filter((column) => !looksNonAdditive(column.name, column.dataType));
    if (unique.length === 1 && tablePrimaryKey(table)) {
      uniqueSources.push(`${table.name}.${unique[0]!.name}`);
    }
  }
  if (uniqueSources.length >= 2) {
    out.push({
      id: CROSS_TABLE_REVENUE_LIKE_ID,
      kind: "revenue_like_columns",
      question:
        "Which column is governed revenue? Several tables have a single revenue-like column. " +
        "Grane will not guess.",
      candidates: [...uniqueSources].sort(compareOrdinal),
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
            `Joining ${quoteIdent(parent)} to ${quoteIdent(child)} multiplies rows: ` +
            `one ${quoteIdent(parent)} row matches many ${quoteIdent(child)} rows, so measures ` +
            `would be counted more than once. Choose "preaggregate" to keep the relationship — ` +
            `Grane totals the many side first, then joins, so ${quoteIdent(parent)} measures are ` +
            `not double-counted. Choose "do_not_join" to leave this relationship out of the draft. ` +
            `Unresolved fan-out is not written. Grane will not guess.`,
          candidates: [...FANOUT_CANDIDATES],
        });
      }
    }
  }
  return out;
}
