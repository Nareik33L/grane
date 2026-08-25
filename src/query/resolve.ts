import type { SemanticModel, Metric, Dimension } from "../model/model.js";
import { parseColumnRef, type ColumnRef } from "../model/refs.js";
import {
  semanticQuerySchema,
  type SemanticQuery,
  type SemanticQueryInput,
  type TimeGrain,
} from "./model.js";
import type { FilterOperator, Scalar } from "../config/schema.js";
import { invalidQuery, unsafeQuery } from "../errors.js";

/**
 * Resolution turns a semantic query (names) into model objects, applying the
 * deterministic-refusal rules: unknown names, mixed grains and fan-out joins
 * are rejected with structured errors rather than guessed at.
 */

export interface ResolvedFilter {
  dimension: Dimension;
  operator: FilterOperator;
  value: Scalar | Scalar[] | undefined;
}

export interface ResolvedTime {
  column: ColumnRef;
  from: string;
  to: string;
  grain: TimeGrain | null;
}

export interface ResolvedQuery {
  query: SemanticQuery;
  metrics: Metric[];
  dimensions: Dimension[];
  filters: ResolvedFilter[];
  time: ResolvedTime | null;
  order: { field: string; direction: "asc" | "desc" }[];
  limit: number;
  /** Base entity shared by all metrics in the query. */
  entity: string;
  baseTable: string;
  notes: string[];
}

export function resolveQuery(
  model: SemanticModel,
  input: SemanticQueryInput,
  defaults: { defaultRows: number; maxRows: number },
): ResolvedQuery {
  const parsed = semanticQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw invalidQuery(
      `Query does not match Grane Query Model v1:\n${parsed.error.issues
        .map((i) => `  ${i.path.join(".")}: ${i.message}`)
        .join("\n")}`,
      parsed.error.issues,
    );
  }
  const query = parsed.data;
  const notes: string[] = [];

  // --- Metrics (synonyms resolve; unknown names refuse) ---
  const metrics = query.metrics.map((name) => {
    const metric = model.resolveMetric(name);
    if (metric.name !== name) notes.push(`"${name}" resolved to metric "${metric.name}".`);
    if (metric.config.status === "deprecated") {
      notes.push(`Metric "${metric.name}" is deprecated.`);
    } else if (metric.config.status === "experimental") {
      notes.push(`Metric "${metric.name}" is experimental (not an approved definition).`);
    }
    return metric;
  });

  const entities = new Set(metrics.map((m) => m.config.entity));
  if (entities.size > 1) {
    throw invalidQuery(
      `All metrics in a query must share the same entity/grain. Requested metrics span: ${[...entities].join(", ")}. Run separate queries per entity.`,
    );
  }
  const entity = metrics[0]!.config.entity;
  const baseTable = model.entityTable(entity);
  if (!baseTable) {
    throw invalidQuery(`Entity "${entity}" is not defined in the semantic model.`);
  }

  // --- Dimensions (must join without fan-out) ---
  const dimensions = query.dimensions.map((name) => {
    const dimension = model.resolveDimension(name);
    assertSafeDimension(model, baseTable, dimension);
    return dimension;
  });

  // --- Filters reference dimensions ---
  const filters: ResolvedFilter[] = query.filters.map((filter) => {
    const dimension = model.resolveDimension(filter.field);
    assertSafeDimension(model, baseTable, dimension);
    if (
      filter.value === undefined &&
      filter.operator !== "is_null" &&
      filter.operator !== "is_not_null"
    ) {
      throw invalidQuery(`Filter on "${filter.field}" with operator "${filter.operator}" requires a value.`);
    }
    return { dimension, operator: filter.operator, value: filter.value ?? undefined };
  });

  // --- Time ---
  let time: ResolvedTime | null = null;
  if (query.time) {
    const column = resolveTimeColumn(model, metrics, query.time.dimension);
    if (query.time.from > query.time.to) {
      throw invalidQuery(`time.from (${query.time.from}) is after time.to (${query.time.to}).`);
    }
    const path = model.graph.findPath(baseTable, column.table);
    if (!path) {
      throw invalidQuery(
        `No relationship path from "${baseTable}" to time column "${column.table}.${column.column}".`,
      );
    }
    if (path.fansOut) {
      throw unsafeQuery(
        `Time column "${column.table}.${column.column}" would fan out rows of "${baseTable}".`,
      );
    }
    time = {
      column,
      from: query.time.from,
      to: query.time.to,
      grain: query.time.grain ?? null,
    };
  }

  // --- Ordering references selected fields ---
  const selectable = new Set<string>([
    ...metrics.map((m) => m.name),
    ...dimensions.map((d) => d.name),
    ...(time?.grain ? [timeAlias(time.grain)] : []),
  ]);
  for (const order of query.order) {
    if (!selectable.has(order.field)) {
      throw invalidQuery(
        `Cannot order by "${order.field}"; it is not among the selected metrics/dimensions (${[...selectable].join(", ")}).`,
      );
    }
  }

  const limit = Math.min(query.limit ?? defaults.defaultRows, defaults.maxRows);

  return {
    query,
    metrics,
    dimensions,
    filters,
    time,
    order: query.order,
    limit,
    entity,
    baseTable,
    notes,
  };
}

export function timeAlias(grain: TimeGrain): string {
  return `period_${grain}`;
}

function assertSafeDimension(model: SemanticModel, baseTable: string, dimension: Dimension): void {
  const path = model.graph.findPath(baseTable, dimension.column.table);
  if (!path) {
    throw invalidQuery(
      `Dimension "${dimension.name}" (${dimension.column.table}.${dimension.column.column}) is not reachable from "${baseTable}". Add the relationship to relationships.yml.`,
    );
  }
  if (path.fansOut) {
    const hop = path.edges.find((e) => e.cardinality === "one_to_many")!;
    throw unsafeQuery(
      `Joining dimension "${dimension.name}" requires traversing "${hop.fromTable}" -> "${hop.toTable}" (one_to_many), ` +
        `which would multiply rows at the metric grain ("${baseTable}") and corrupt aggregation. ` +
        `Grane refuses this query as governed. Define a metric at the "${dimension.column.table}" grain instead.`,
    );
  }
}

function resolveTimeColumn(
  model: SemanticModel,
  metrics: Metric[],
  requested: string | undefined,
): ColumnRef {
  if (requested) {
    // A dimension name, or a direct table.column reference.
    try {
      const dimension = model.resolveDimension(requested);
      return dimension.column;
    } catch {
      const ref = parseColumnRef(requested);
      if (ref) return ref;
      throw invalidQuery(
        `time.dimension "${requested}" is neither a defined dimension nor a table.column reference.`,
      );
    }
  }
  const withTime = metrics.filter((m) => m.timeDimension);
  if (withTime.length === 0) {
    throw invalidQuery(
      `A time range was requested but none of the metrics define a time_dimension, and no time.dimension was provided.`,
    );
  }
  const first = withTime[0]!.timeDimension!;
  for (const metric of withTime.slice(1)) {
    const other = metric.timeDimension!;
    if (other.table !== first.table || other.column !== first.column) {
      throw invalidQuery(
        `Metrics disagree on their canonical time dimension (${withTime[0]!.name}: ${first.table}.${first.column}, ${metric.name}: ${other.table}.${other.column}). Specify time.dimension explicitly.`,
      );
    }
  }
  return first;
}
