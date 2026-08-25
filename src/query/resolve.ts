import type { SemanticModel, Metric, Dimension } from "../model/model.js";
import { parseColumnRef, formatColumnRef, type ColumnRef } from "../model/refs.js";
import {
  semanticQuerySchema,
  type SemanticQuery,
  type SemanticQueryInput,
  type TimeGrain,
  type TrustLevel,
  type RawMetricType,
} from "./model.js";
import type { FilterOperator, Scalar } from "../config/schema.js";
import type { DatabaseSchema } from "../connectors/types.js";
import { invalidQuery, unsafeQuery, GraneError } from "../errors.js";
import { explorationPolicy, type ExplorationPolicy } from "../explore/policy.js";
import {
  resolveRawColumn,
  assertNumericRawMetric,
  defaultRawMetricAlias,
  hintUngovernedDimension,
  type RawColumn,
} from "../explore/raw.js";

/**
 * Resolution turns a semantic query (names) into model objects, applying the
 * deterministic-refusal rules: unknown names, mixed grains and fan-out joins
 * are rejected with structured errors rather than guessed at.
 *
 * Raw warehouse fields are allowed when exploration is enabled. They still
 * pass existence, policy, type, join and fan-out checks — they are simply
 * not treated as governed definitions.
 */

export interface ResolvedFilter {
  column: ColumnRef;
  /** Dimension name, or table.column for raw filters. */
  field: string;
  governed: boolean;
  operator: FilterOperator;
  value: Scalar | Scalar[] | undefined;
}

export interface ResolvedTime {
  column: ColumnRef;
  from: string;
  to: string;
  grain: TimeGrain | null;
  governed: boolean;
  qualified: string;
}

export interface ResolvedRawMetric {
  field: ColumnRef;
  qualified: string;
  type: RawMetricType;
  alias: string;
  dataType: string | null;
}

export interface ResolvedQuery {
  query: SemanticQuery;
  metrics: Metric[];
  dimensions: Dimension[];
  rawDimensions: RawColumn[];
  rawMetrics: ResolvedRawMetric[];
  filters: ResolvedFilter[];
  time: ResolvedTime | null;
  order: { field: string; direction: "asc" | "desc" }[];
  limit: number;
  /** Base entity shared by governed metrics, or null for exploratory queries. */
  entity: string | null;
  baseTable: string;
  notes: string[];
  trust: TrustLevel;
  governed: string[];
  ungoverned: string[];
  warning: string | null;
}

export interface ResolveOptions {
  defaultRows: number;
  maxRows: number;
  schema?: DatabaseSchema | null;
}

export function resolveQuery(
  model: SemanticModel,
  input: SemanticQueryInput,
  defaults: ResolveOptions,
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
  const policy = explorationPolicy(model.config);
  const schema = defaults.schema ?? null;

  if (query.metrics.length === 0 && query.raw_metrics.length === 0) {
    throw invalidQuery("Provide at least one governed metric or one raw_metric.");
  }

  if (query.metrics.length > 0 && query.raw_metrics.length > 0) {
    throw invalidQuery(
      "Cannot mix governed metrics with raw_metrics. Slice a governed metric with raw_dimensions, or run a separate exploratory query.",
    );
  }

  // --- Governed metrics (synonyms resolve; unknown names refuse) ---
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

  let entity: string | null = null;
  let baseTable: string;

  if (metrics.length > 0) {
    const entities = new Set(metrics.map((m) => m.config.entity));
    if (entities.size > 1) {
      throw invalidQuery(
        `All metrics in a query must share the same entity/grain. Requested metrics span: ${[...entities].join(", ")}. Run separate queries per entity.`,
      );
    }
    entity = metrics[0]!.config.entity;
    const table = model.entityTable(entity);
    if (!table) {
      throw invalidQuery(`Entity "${entity}" is not defined in the semantic model.`);
    }
    baseTable = table;
  } else {
    const first = parseColumnRef(query.raw_metrics[0]!.field);
    if (!first) {
      throw invalidQuery(
        `raw_metrics[0].field "${query.raw_metrics[0]!.field}" must be a table.column reference.`,
      );
    }
    baseTable = first.table;
    for (const entityDef of model.entities.values()) {
      if (entityDef.config.table === baseTable) {
        entity = entityDef.name;
        break;
      }
    }
  }

  const resolveRaw = (requested: string, purpose: string): RawColumn =>
    resolveRawColumn(requested, { model, policy, schema, purpose });

  // --- Raw metrics (exploratory aggregations) ---
  const rawMetrics: ResolvedRawMetric[] = query.raw_metrics.map((raw, index) => {
    const column = resolveRaw(raw.field, `raw_metrics[${index}]`);
    if (column.ref.table !== baseTable) {
      throw invalidQuery(
        `All raw_metrics must share the same table (the exploratory grain). ` +
          `"${column.qualified}" is on "${column.ref.table}" but the query grain is "${baseTable}".`,
      );
    }
    assertNumericRawMetric(column, raw.type);
    return {
      field: column.ref,
      qualified: column.qualified,
      type: raw.type,
      alias: raw.alias ?? defaultRawMetricAlias(raw.type, column.ref),
      dataType: column.dataType,
    };
  });

  // --- Governed dimensions (must join without fan-out) ---
  const dimensions = query.dimensions.map((name) => {
    const dimension = resolveGovernedDimension(model, name, schema);
    assertSafeJoin(model, baseTable, dimension.column, `dimension "${dimension.name}"`);
    return dimension;
  });

  // --- Raw dimensions ---
  const rawDimensions = query.raw_dimensions.map((requested) => {
    const column = resolveRaw(requested, "raw_dimension");
    assertSafeJoin(model, baseTable, column.ref, `raw dimension "${column.qualified}"`);
    notes.push(`"${column.qualified}" is not defined in the Grane semantic model.`);
    return column;
  });

  // --- Filters: governed dimension or raw table.column ---
  const filters: ResolvedFilter[] = query.filters.map((filter) => {
    const resolved = resolveFilterField(model, filter.field, schema, policy);
    assertSafeJoin(
      model,
      baseTable,
      resolved.column,
      `${resolved.governed ? "filter" : "raw filter"} on "${resolved.field}"`,
    );
    if (
      filter.value === undefined &&
      filter.operator !== "is_null" &&
      filter.operator !== "is_not_null"
    ) {
      throw invalidQuery(`Filter on "${filter.field}" with operator "${filter.operator}" requires a value.`);
    }
    if (!resolved.governed) {
      notes.push(`Filter field "${resolved.field}" is not defined in the Grane semantic model.`);
    }
    return {
      column: resolved.column,
      field: resolved.field,
      governed: resolved.governed,
      operator: filter.operator,
      value: filter.value ?? undefined,
    };
  });

  // --- Time ---
  let time: ResolvedTime | null = null;
  if (query.time) {
    const resolvedTime = resolveTimeColumn(model, metrics, query.time.dimension, schema, policy);
    if (query.time.from > query.time.to) {
      throw invalidQuery(`time.from (${query.time.from}) is after time.to (${query.time.to}).`);
    }
    assertSafeJoin(
      model,
      baseTable,
      resolvedTime.column,
      `time column "${resolvedTime.qualified}"`,
    );
    time = {
      column: resolvedTime.column,
      from: query.time.from,
      to: query.time.to,
      grain: query.time.grain ?? null,
      governed: resolvedTime.governed,
      qualified: resolvedTime.qualified,
    };
  }

  // --- Ordering references selected fields ---
  const selectable = new Set<string>([
    ...metrics.map((m) => m.name),
    ...dimensions.map((d) => d.name),
    ...rawDimensions.map((d) => d.alias),
    ...rawMetrics.map((m) => m.alias),
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

  const governedNames = [
    ...metrics.map((m) => m.name),
    ...dimensions.map((d) => d.name),
    ...filters.filter((f) => f.governed).map((f) => f.field),
    ...(query.time?.dimension && time?.governed ? [time.qualified] : []),
  ];
  const ungovernedNames = [
    ...rawDimensions.map((d) => d.qualified),
    ...rawMetrics.map((m) => m.qualified),
    ...filters.filter((f) => !f.governed).map((f) => f.field),
    ...(query.time?.dimension && time && !time.governed ? [time.qualified] : []),
  ];
  const unique = (values: string[]) => [...new Set(values)];
  const governed = unique(governedNames);
  const ungoverned = unique(ungovernedNames);
  const trust = computeTrust(governed, ungoverned);
  const warning = warningFor(ungoverned);

  return {
    query,
    metrics,
    dimensions,
    rawDimensions,
    rawMetrics,
    filters,
    time,
    order: query.order,
    limit,
    entity,
    baseTable,
    notes,
    trust,
    governed,
    ungoverned,
    warning,
  };
}

export function timeAlias(grain: TimeGrain): string {
  return `period_${grain}`;
}

export function computeTrust(governed: string[], ungoverned: string[]): TrustLevel {
  if (ungoverned.length === 0) return "governed";
  if (governed.length === 0) return "exploratory";
  return "mixed";
}

function warningFor(ungoverned: string[]): string | null {
  if (ungoverned.length === 0) return null;
  if (ungoverned.length === 1) {
    return `${ungoverned[0]} is not defined in the Grane semantic model`;
  }
  return `${ungoverned.join(", ")} are not defined in the Grane semantic model`;
}

function resolveGovernedDimension(
  model: SemanticModel,
  name: string,
  schema: DatabaseSchema | null,
): Dimension {
  try {
    return model.resolveDimension(name);
  } catch (err) {
    if (err instanceof GraneError && err.refusal.status === "undefined_dimension") {
      hintUngovernedDimension(name, err.refusal.similar ?? [], model, schema);
    }
    throw err;
  }
}

function resolveFilterField(
  model: SemanticModel,
  field: string,
  schema: DatabaseSchema | null,
  policy: ExplorationPolicy,
): { column: ColumnRef; field: string; governed: boolean } {
  try {
    const dimension = model.resolveDimension(field);
    return { column: dimension.column, field: dimension.name, governed: true };
  } catch (err) {
    if (!(err instanceof GraneError) || err.refusal.status !== "undefined_dimension") throw err;
    const ref = parseColumnRef(field);
    if (ref) {
      const raw = resolveRawColumn(field, { model, policy, schema, purpose: "filter" });
      return { column: raw.ref, field: raw.qualified, governed: false };
    }
    hintUngovernedDimension(field, err.refusal.similar ?? [], model, schema);
  }
}

function assertSafeJoin(model: SemanticModel, baseTable: string, column: ColumnRef, purpose: string): void {
  const path = model.graph.findPath(baseTable, column.table);
  if (!path) {
    throw invalidQuery(
      `${purpose} (${column.table}.${column.column}) is not reachable from "${baseTable}". Add the relationship to relationships.yml.`,
    );
  }
  if (path.fansOut) {
    const hop = path.edges.find((e) => e.cardinality === "one_to_many")!;
    throw unsafeQuery(
      `Joining ${purpose} requires traversing "${hop.fromTable}" -> "${hop.toTable}" (one_to_many), ` +
        `which would multiply rows at the metric grain ("${baseTable}") and corrupt aggregation. ` +
        `Grane refuses this query. Define a metric at the "${column.table}" grain instead.`,
    );
  }
}

function resolveTimeColumn(
  model: SemanticModel,
  metrics: Metric[],
  requested: string | undefined,
  schema: DatabaseSchema | null,
  policy: ExplorationPolicy,
): { column: ColumnRef; governed: boolean; qualified: string } {
  if (requested) {
    try {
      const dimension = model.resolveDimension(requested);
      return {
        column: dimension.column,
        governed: true,
        qualified: dimension.name,
      };
    } catch {
      const ref = parseColumnRef(requested);
      if (ref) {
        const raw = resolveRawColumn(requested, { model, policy, schema, purpose: "time.dimension" });
        return { column: raw.ref, governed: false, qualified: raw.qualified };
      }
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
  return { column: first, governed: true, qualified: formatColumnRef(first) };
}

export function queryNeedsSchema(input: SemanticQueryInput, model: SemanticModel): boolean {
  if (!model.config.exploration.enabled) return false;
  if ((input.raw_dimensions?.length ?? 0) > 0) return true;
  if ((input.raw_metrics?.length ?? 0) > 0) return true;
  for (const filter of input.filters ?? []) {
    try {
      model.resolveDimension(filter.field);
    } catch {
      if (parseColumnRef(filter.field)) return true;
    }
  }
  if (input.time?.dimension) {
    try {
      model.resolveDimension(input.time.dimension);
    } catch {
      if (parseColumnRef(input.time.dimension)) return true;
    }
  }
  return false;
}
