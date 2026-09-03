import type { SemanticModel } from "../model/model.js";
import { parseColumnRef, formatColumnRef, type ColumnRef } from "../model/refs.js";
import type { DatabaseSchema } from "../connectors/types.js";
import { isNumericType } from "../connectors/dialect.js";
import {
  columnNotPermitted,
  explorationDisabled,
  invalidQuery,
  undefinedColumn,
} from "../errors.js";
import {
  explorationPolicy,
  isExcluded,
  isSchemaAllowed,
  type ExplorationPolicy,
} from "./policy.js";
import type { MetricType } from "../config/schema.js";

export type RawMetricType = Exclude<MetricType, "ratio">;

export interface RawColumn {
  ref: ColumnRef;
  qualified: string;
  /** SQL result alias; table.column for dimensions. */
  alias: string;
  dataType: string | null;
  schemaName: string | null;
}

export interface ExplorableColumn {
  table: string;
  column: string;
  data_type: string;
  schema: string;
}

function similar(requested: string, candidates: string[], max = 5): string[] {
  const lower = requested.toLowerCase();
  return candidates
    .filter((name) => {
      const candidate = name.toLowerCase();
      return candidate.includes(lower) || lower.includes(candidate) || candidate === lower;
    })
    .slice(0, max);
}

function columnIndex(schema: DatabaseSchema): Map<string, { dataType: string; schema: string }> {
  const index = new Map<string, { dataType: string; schema: string }>();
  for (const table of schema.tables) {
    for (const column of table.columns) {
      index.set(`${table.name}.${column.name}`.toLowerCase(), {
        dataType: column.dataType,
        schema: table.schema,
      });
    }
  }
  return index;
}

export function schemaColumnNames(schema: DatabaseSchema): string[] {
  return schema.tables.flatMap((table) => table.columns.map((c) => `${table.name}.${c.name}`));
}

export function resolveRawColumn(
  requested: string,
  options: {
    model: SemanticModel;
    policy?: ExplorationPolicy;
    schema?: DatabaseSchema | null;
    purpose?: string;
  },
): RawColumn {
  const policy = options.policy ?? explorationPolicy(options.model.config);
  const ref = parseColumnRef(requested);
  if (!ref) {
    throw invalidQuery(
      `${options.purpose ?? "Raw field"} "${requested}" must be a table.column reference.`,
    );
  }
  const qualified = formatColumnRef(ref);

  if (!policy.enabled) {
    throw explorationDisabled(qualified);
  }
  if (isExcluded(policy, ref.table, ref.column)) {
    throw columnNotPermitted(qualified);
  }

  let dataType: string | null = null;
  let schemaName: string | null = null;

  if (options.schema) {
    const index = columnIndex(options.schema);
    const found = index.get(qualified.toLowerCase());
    if (!found) {
      throw undefinedColumn(qualified, similar(qualified, schemaColumnNames(options.schema)));
    }
    if (!isSchemaAllowed(policy, found.schema)) {
      throw columnNotPermitted(
        `${qualified} (schema "${found.schema}" is not in exploration.schemas)`,
      );
    }
    dataType = found.dataType;
    schemaName = found.schema;
  }

  return {
    ref,
    qualified,
    alias: qualified,
    dataType,
    schemaName,
  };
}

export function assertNumericRawMetric(raw: RawColumn, type: RawMetricType): void {
  if ((type === "sum" || type === "avg") && raw.dataType && !isNumericType(raw.dataType)) {
    throw invalidQuery(
      `Raw metric type "${type}" requires a numeric column but "${raw.qualified}" has type ${raw.dataType}.`,
    );
  }
}

export function defaultRawMetricAlias(type: RawMetricType, ref: ColumnRef): string {
  return `${type}_${ref.table}_${ref.column}`;
}

/** Columns that already have a governed metric or dimension definition. */
export function governedColumnKeys(model: SemanticModel): Set<string> {
  const keys = new Set<string>();
  for (const dimension of model.dimensions.values()) {
    if (dimension.column.table) keys.add(formatColumnRef(dimension.column).toLowerCase());
  }
  for (const metric of model.metrics.values()) {
    if (metric.measure && !metric.countsRows) keys.add(formatColumnRef(metric.measure).toLowerCase());
    if (metric.timeDimension) keys.add(formatColumnRef(metric.timeDimension).toLowerCase());
  }
  return keys;
}

export function listExplorableColumns(
  model: SemanticModel,
  schema: DatabaseSchema,
  search?: string,
): ExplorableColumn[] {
  const policy = explorationPolicy(model.config);
  if (!policy.enabled) return [];
  const governed = governedColumnKeys(model);
  const q = search?.toLowerCase();
  const columns: ExplorableColumn[] = [];
  for (const table of schema.tables) {
    if (!isSchemaAllowed(policy, table.schema)) continue;
    for (const column of table.columns) {
      const qualified = `${table.name}.${column.name}`;
      if (isExcluded(policy, table.name, column.name)) continue;
      if (governed.has(qualified.toLowerCase())) continue;
      if (q && !qualified.toLowerCase().includes(q) && !column.dataType.toLowerCase().includes(q)) {
        continue;
      }
      columns.push({
        table: table.name,
        column: column.name,
        data_type: column.dataType,
        schema: table.schema,
      });
    }
  }
  return columns;
}

export function suggestRawColumnsForName(
  schema: DatabaseSchema,
  name: string,
  policy: ExplorationPolicy,
): string[] {
  const lower = name.toLowerCase();
  const matches: string[] = [];
  for (const table of schema.tables) {
    if (!isSchemaAllowed(policy, table.schema)) continue;
    for (const column of table.columns) {
      if (isExcluded(policy, table.name, column.name)) continue;
      if (column.name.toLowerCase() === lower || column.name.toLowerCase().includes(lower)) {
        matches.push(`${table.name}.${column.name}`);
      }
    }
  }
  return matches.slice(0, 5);
}

export function hintUngovernedDimension(
  requested: string,
  similarDims: string[],
  model: SemanticModel,
  schema: DatabaseSchema | null | undefined,
): void {
  const policy = explorationPolicy(model.config);
  const rawMatches = schema ? suggestRawColumnsForName(schema, requested, policy) : [];
  if (policy.enabled && rawMatches.length > 0) {
    throw invalidQuery(
      `"${requested}" is not a governed dimension. It matches warehouse column(s) ${rawMatches.join(", ")}. ` +
        `Request it as raw_dimensions: ${JSON.stringify(rawMatches)} if exploration is permitted.`,
      { similar: [...similarDims, ...rawMatches] },
    );
  }
}
