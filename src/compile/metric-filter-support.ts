import type { Metric, SemanticModel } from "../model/model.js";
import { ambiguousRelationshipMessage, describeJoinPath, type JoinPath } from "../model/graph.js";
import { parseColumnRef } from "../model/refs.js";
import {
  GraneError,
  ambiguousQuery,
  invalidQuery,
  unsafeQuery,
  type Refusal,
} from "../errors.js";
import { assertNoJsonNullFilterValue } from "../query/filter-null.js";

/**
 * Where a metric-definition `table.column` filter is compiled.
 *
 * Query-level filters never land here: they resolve as dimensions or raw
 * `table.column` predicates, not as HAVING on a metric result.
 */
export type MetricFilterPlacement = "grain" | "outer_join" | "preagg_cte";

export type MetricFilterBind =
  | { ok: true; placement: MetricFilterPlacement; table: string }
  | { ok: false; refusal: Refusal };

/**
 * Tables that appear in the pre-aggregation CTE for a fan-out measure path
 * (the child of the first hop plus every later hop's target).
 *
 * Indirect fan-out (first hop not from the grain) is not a V0.1 preagg
 * shape; callers treat those filters as unbound unless they sit on the grain.
 */
export function preaggCteTables(path: JoinPath, grainTable: string): Set<string> | null {
  if (!path.fansOut || path.ambiguous || path.fanningAmbiguous) return null;
  const first = path.edges[0];
  if (!first || first.fromTable !== grainTable) return null;
  return new Set(path.edges.map((edge) => edge.toTable));
}

/**
 * Decide whether compiler SQL will actually bind `filterTable` for this metric
 * at `grainTable`.
 *
 * Supported:
 *   - the metric grain (FROM / outer FILTER)
 *   - a fan-out-free join from the grain (outer LEFT JOIN + FILTER)
 *   - a table inside the measure's pre-aggregation CTE
 *
 * Semi-additive metrics only accept grain-table filters (snapshot selection).
 * Anything else is refused before SQL, never left as an unbound identifier
 * for the warehouse binder.
 */
export function classifyMetricFilterTable(
  model: SemanticModel,
  metric: Metric,
  grainTable: string,
  filterTable: string,
): MetricFilterBind {
  if (filterTable === grainTable) {
    return { ok: true, placement: "grain", table: filterTable };
  }

  if (metric.semiAdditive) {
    return {
      ok: false,
      refusal: unsafeQuery(
        `Semi-additive metric "${metric.name}": filter on "${filterTable}" must be a column on "${grainTable}" so it can be applied before the snapshot is chosen.`,
        { metric: metric.name, table: filterTable, grain: grainTable },
      ).refusal,
    };
  }

  const measureTable = metric.measure?.table ?? grainTable;
  const measurePath = model.graph.findPath(grainTable, measureTable);
  const cteTables = measurePath ? preaggCteTables(measurePath, grainTable) : null;
  if (cteTables?.has(filterTable)) {
    return { ok: true, placement: "preagg_cte", table: filterTable };
  }

  const path = model.graph.findPath(grainTable, filterTable);
  if (!path) {
    return {
      ok: false,
      refusal: invalidQuery(
        `Metric "${metric.name}" filter references "${filterTable}", which is not reachable from the metric grain "${grainTable}". ` +
          `Grane will not emit an unbound FILTER clause.`,
        { metric: metric.name, table: filterTable, grain: grainTable },
      ).refusal,
    };
  }
  if (path.ambiguous) {
    return {
      ok: false,
      refusal: ambiguousQuery(
        `Metric "${metric.name}" filter on "${filterTable}" has ${ambiguousRelationshipMessage(grainTable, filterTable, path.alternatives)}`,
        {
          metric: metric.name,
          table: filterTable,
          grain: grainTable,
          from: grainTable,
          to: filterTable,
          paths: path.alternatives,
        },
      ).refusal,
    };
  }
  if (path.fansOut) {
    const hop = path.edges.find((edge) => edge.cardinality === "one_to_many");
    const via = hop ? `"${hop.fromTable}" -> "${hop.toTable}"` : describeJoinPath(path);
    return {
      ok: false,
      refusal: unsafeQuery(
        `Metric "${metric.name}" filter on "${filterTable}" is only reachable from "${grainTable}" through a one_to_many relationship ` +
          `(${via}). Applying it would fan out the grain or bind an unbound table. ` +
          `Grane refuses this filter. Put the predicate on a table at the metric grain, or define the metric at the "${filterTable}" grain.`,
        { metric: metric.name, table: filterTable, grain: grainTable },
      ).refusal,
    };
  }
  return { ok: true, placement: "outer_join", table: filterTable };
}

export function classifyMetricFilterField(
  model: SemanticModel,
  metric: Metric,
  grainTable: string,
  field: string,
): MetricFilterBind {
  const ref = parseColumnRef(field);
  if (!ref) {
    return {
      ok: false,
      refusal: invalidQuery(
        `Metric "${metric.name}" filter field "${field}" is not a table.column reference.`,
        { metric: metric.name, field },
      ).refusal,
    };
  }
  const bound = classifyMetricFilterTable(model, metric, grainTable, ref.table);
  if (!bound.ok) {
    const details =
      bound.refusal.details && typeof bound.refusal.details === "object"
        ? { ...(bound.refusal.details as Record<string, unknown>), field }
        : { field, metric: metric.name };
    return { ok: false, refusal: { ...bound.refusal, details } };
  }
  return bound;
}

/**
 * Measure-table reachability for a scalar metric at `grainTable`.
 * Ambiguous fanning (and safe) routes refuse here so resolve / compile /
 * explain / query never BFS-pick a path.
 */
export function assertMeasurePath(model: SemanticModel, metric: Metric, grainTable: string): void {
  if (metric.config.type === "ratio" || !metric.measure) return;
  const measureTable = metric.measure.table;
  const path = model.graph.findPath(grainTable, measureTable);
  if (!path) {
    throw invalidQuery(
      `No relationship path from "${grainTable}" to measure table "${measureTable}" for metric "${metric.name}".`,
    );
  }
  if (path.ambiguous) {
    throw ambiguousQuery(
      `Metric "${metric.name}" has ${ambiguousRelationshipMessage(grainTable, measureTable, path.alternatives)}`,
      { metric: metric.name, from: grainTable, to: measureTable, paths: path.alternatives },
    );
  }
  if (path.fanningAmbiguous) {
    throw ambiguousQuery(
      `Metric "${metric.name}" has ${ambiguousRelationshipMessage(grainTable, measureTable, path.alternatives)}`,
      { metric: metric.name, from: grainTable, to: measureTable, paths: path.alternatives },
    );
  }
}

/** Refuse every metric-definition filter that would compile to an unbound identifier. */
export function assertMetricFiltersBound(model: SemanticModel, metric: Metric, grainTable: string): void {
  if (metric.config.type === "ratio" && metric.filters.length > 0) {
    throw invalidQuery(
      `Ratio metric "${metric.name}" cannot carry its own metric filters; they are not applied to the ratio result. ` +
        `Put table.column predicates on the numerator and denominator metrics instead.`,
      { metric: metric.name },
    );
  }
  for (const filter of metric.filters) {
    assertNoJsonNullFilterValue(filter.operator, filter.field, filter.value);
    const bound = classifyMetricFilterField(model, metric, grainTable, filter.field);
    if (!bound.ok) throw new GraneError(bound.refusal);
  }
}
