import type { SemanticModel, Metric } from "../model/model.js";
import type { ResolvedQuery, ResolvedFilter } from "../query/resolve.js";
import { timeAlias } from "../query/resolve.js";
import type { Edge } from "../model/graph.js";
import type { FilterOperator, Scalar, MetricFilterItem } from "../config/schema.js";
import { parseColumnRef, type ColumnRef } from "../model/refs.js";
import { exclusiveEnd } from "../query/time.js";
import { ambiguousQuery, invalidQuery, unsafeQuery } from "../errors.js";
import {
  classifyTemporalType,
  getDialect,
  postgresDialect,
  type SqlDialect,
  type TemporalKind,
} from "../connectors/dialect.js";
import { columnDataType, type DatabaseSchema } from "../connectors/types.js";
import { compilerNamespace } from "../connectors/create.js";

/**
 * The deterministic query compiler.
 *
 * Given a resolved semantic query, Grane — not the agent — chooses the joins
 * and generates the SQL. Measures that live across a one_to_many relationship
 * are pre-aggregated at the metric grain inside CTEs so fan-out can never
 * multiply rows and corrupt results.
 *
 * Joins from the base table to related tables (dimensions, filters, time)
 * follow declared many_to_one relationships and are LEFT OUTER joins: a fact
 * whose related row is missing (or whose foreign key is NULL) stays in the
 * population and lands in the NULL group, which is what MetricFlow does for
 * metric -> dimension traversal. Query filters on a joined column are applied
 * in WHERE after the join (also as MetricFlow does), so `= X` and `!= X` both
 * exclude unmatched facts: NULL compares to nothing.
 *
 * A many_to_one relationship is a declared contract that the right-hand key is
 * unique. Grane does not take that on faith at execution time: every joined
 * table carries a cardinality guard — a scalar in the same statement that
 * reports the largest number of rows sharing one key value — and the executor
 * refuses the result if a key is duplicated, rather than returning multiplied
 * facts.
 *
 * The guard is scoped, not global. Cardinality safety is metric-contribution-
 * specific and relationship-specific:
 *
 *   P0    = metric-contributing population: base rows inside the query's time
 *           bounds and base-table filters that can contribute to at least one
 *           requested metric (its own base-table filters / time window).
 *   P(n)  = rows of the n-th joined table referenced by a non-NULL FK of a row
 *           in P(n-1) — the same rule for every hop.
 *   guard = MAX(rows per key) over P(n).
 *
 * A duplicated key that no contributing fact reaches (unused, filtered out,
 * outside the time range, not snapshot-selected, behind a different branch of
 * an earlier hop) cannot multiply anything and does not refuse. A duplicated
 * key that a contributing fact reaches refuses, even if a joined-dimension
 * WHERE would later hide the multiplied rows: that predicate is evaluated
 * through the very join whose contract is broken.
 *
 * The same contract applies inside pre-aggregation CTEs. A many_to_one hop
 * taken while collapsing a one_to_many child (orders → order_items →
 * products) is still a participating relationship: its reachable keys are
 * guarded, with LEFT JOIN so unmatched / NULL foreign keys do not drop the
 * child fact. Compilation strategy must not change the governed relationship
 * contract.
 *
 * Time dimensions are not interchangeable warehouse types. A DATE is a civil
 * calendar value and is filtered/grouped as that date in every project
 * timezone. Timestamp-like columns are localized to project.timezone. If the
 * warehouse type is unknown and the project timezone is not UTC, compilation
 * refuses rather than guessing.
 */

export interface JoinStep {
  table: string;
  on: string;
  relationship: string;
  cardinality: string;
  /** Join type used in the generated SQL. */
  join: "LEFT JOIN";
  /** Hidden result column that verifies, in the same statement, that `keyColumn` is unique. */
  cardinalityGuard: string;
}

/**
 * A hidden scalar that measures the largest number of rows per key in the
 * *reachable* population of a joined table: the rows whose key is referenced
 * by the relevant population one hop earlier (see `keySource`). Any value
 * above 1 means the declared many_to_one contract is violated for a key that
 * a metric-contributing fact actually reaches, and the executor refuses the
 * result. NULL means no fact reaches the table at all (nothing to multiply).
 *
 * Every guard can answer: which metrics it protects (`protects`), which
 * relationship (`relationship`), through which path (`path`), and which
 * population emits the keys it checks (`keySource`).
 */
export interface CardinalityGuard {
  column: string;
  table: string;
  key: string;
  keyColumn: string;
  relationship: string;
  /** Table that holds the FK (base table, or an intermediate hop table). */
  fromTable: string;
  /** Column in fromTable that references `key` in `table`. */
  fromColumn: string;
  /** Relationship names from the base table to `table`, in traversal order. */
  path: string[];
  /** CTE whose rows emit the FK values this guard checks (P(n-1)). */
  keySource: string;
  /** CTE holding the reachable rows of `table` (P(n)); the guard aggregates over it. */
  reach: string;
  /** Metrics (and raw metric aliases) whose results this guard protects. */
  protects: string[];
  /** Outer analytical join, or a hop inside a pre-aggregation CTE. */
  scope: "join" | "preagg";
}

/** Prefix of hidden columns the executor strips from results. */
export const GUARD_PREFIX = "__grane_card_";
/** Analytical population: base rows after time bounds and base-table query filters. */
export const POP_CTE = "__grane_pop";
/** Metric-contributing population: rows of POP_CTE that can contribute to at least one metric. */
export const CONTRIB_CTE = "__grane_contrib";
const REACH_PREFIX = "__grane_reach_";

export interface PreAggregation {
  metric: string;
  cte: string;
  measureTable: string;
  keyColumn: string;
}

export interface QueryPlan {
  baseTable: string;
  joins: JoinStep[];
  preAggregations: PreAggregation[];
  columns: string[];
  /** Time bucket, dimension and raw dimension aliases (the GROUP BY keys). */
  groupColumns: string[];
  /** CTE names of the populations behind the guards; null when the query has no joins. */
  population: { analytical: string | null; contributing: string | null };
}

export interface CompiledQuery {
  sql: string;
  params: Scalar[];
  plan: QueryPlan;
  guards: CardinalityGuard[];
  metricVersions: Record<string, string>;
  metricSources: Record<string, { provider: string; path?: string }>;
  trust: ResolvedQuery["trust"];
  governed: string[];
  ungoverned: string[];
  warning: string | null;
}

/**
 * Bind parameters are collected during compilation and numbered in *textual*
 * order once the statement is assembled. Compilation order is not textual
 * order (metric FILTER clauses are compiled before the population CTE they end
 * up after), and `?`-style dialects bind strictly by position.
 */
class Params {
  readonly values: Scalar[] = [];
  constructor(readonly dialect: SqlDialect) {}
  add(value: Scalar): string {
    this.values.push(value);
    return `${PARAM_SENTINEL}${this.values.length - 1}${PARAM_SENTINEL}`;
  }
  /** Replace sentinels with dialect placeholders numbered by textual position. */
  finalize(sql: string): { sql: string; values: Scalar[] } {
    const ordered: Scalar[] = [];
    const out = sql.replace(PARAM_PATTERN, (_match, index: string) => {
      const value = this.values[Number(index)]!;
      ordered.push(value);
      return this.dialect.placeholder(ordered.length, value);
    });
    return { sql: out, values: ordered };
  }
}

const PARAM_SENTINEL = "\u0001";
const PARAM_PATTERN = /\u0001(\d+)\u0001/g;

export function quoteIdent(name: string): string {
  return postgresDialect.ident(name);
}

export function compileQuery(
  model: SemanticModel,
  resolved: ResolvedQuery,
  warehouseSchema?: DatabaseSchema | null,
): CompiledQuery {
  const dialect = getDialect(model.config.connection.type);
  const schema = compilerNamespace(model.config.connection);
  const timezone = model.config.project.timezone;
  const params = new Params(dialect);
  const baseTable = resolved.baseTable;
  const ident = (name: string) => dialect.ident(name);
  const col = (ref: ColumnRef): string => `${ident(ref.table)}.${ident(ref.column)}`;
  /** Aggregation input: the measure column, or the literal 1 for row counts (COUNT(1)). */
  const measureSql = (metric: Metric): string => (metric.countsRows ? "1" : col(metric.measure!));
  const qualify = (table: string): string => dialect.qualifyTable(schema, table);

  const temporalKind = (ref: ColumnRef): TemporalKind => {
    const dataType = columnDataType(warehouseSchema, ref.table, ref.column);
    const kind = classifyTemporalType(dataType, model.config.connection.type);
    if (kind !== "unknown") return kind;
    if (!timezone || timezone === "UTC") return "unknown";
    throw unsafeQuery(
      `Time dimension "${ref.table}.${ref.column}" cannot be localized to ${timezone}: ` +
        (dataType
          ? `warehouse type "${dataType}" is not a known DATE or TIMESTAMP type. `
          : `its warehouse type is unknown at compile time. `) +
        `Grane will not assume timezone semantics for an unclassified column. ` +
        `Introspect the warehouse (so compilation can see the column type) or use a DATE / TIMESTAMP column.`,
      { table: ref.table, column: ref.column, data_type: dataType, timezone },
    );
  };

  /**
   * DATE columns stay civil dates. Timestamp-like columns are localized to
   * project.timezone (a no-op when the project timezone is UTC).
   */
  const timeExpr = (ref: ColumnRef): string => {
    const kind = temporalKind(ref);
    if (kind === "date") return col(ref);
    return dialect.localizeTime(col(ref), timezone);
  };

  const timeBound = (value: string, ref: ColumnRef): string =>
    temporalKind(ref) === "date"
      ? dialect.castDate(params.add(value))
      : dialect.castTimestamp(params.add(value));

  const truncTime = (grain: string, ref: ColumnRef): string =>
    dialect.dateTrunc(grain, timeExpr(ref), temporalKind(ref) === "date" ? "date" : undefined);

  // ---- Join planning for the outer query (dimensions, filters, time, direct measures) ----
  const joinedTables = new Set<string>([baseTable]);
  const joins: JoinStep[] = [];

  const joinPathTo = (targetTable: string, purpose: string): void => {
    if (joinedTables.has(targetTable)) return;
    const path = model.graph.findPath(baseTable, targetTable);
    if (!path) {
      throw invalidQuery(`No relationship path from "${baseTable}" to "${targetTable}" (${purpose}).`);
    }
    if (path.ambiguous) {
      throw ambiguousQuery(
        `Joining "${targetTable}" (${purpose}) is ambiguous: multiple fan-out-free paths from "${baseTable}" (${(path.alternatives ?? []).join("; ")}). Name the relationship you mean.`,
        { from: baseTable, to: targetTable, paths: path.alternatives },
      );
    }
    if (path.fansOut) {
      throw unsafeQuery(
        `Joining "${targetTable}" (${purpose}) would fan out rows at the "${baseTable}" grain.`,
      );
    }
    for (const edge of path.edges) {
      addJoinEdge(edge);
    }
  };

  const guards: CardinalityGuard[] = [];

  const addJoinEdge = (edge: Edge): void => {
    if (joinedTables.has(edge.toTable)) return;
    joinedTables.add(edge.toTable);
    const guard = `${GUARD_PREFIX}${edge.toTable}`;
    joins.push({
      table: edge.toTable,
      on: `${ident(edge.fromTable)}.${ident(edge.fromColumn)} = ${ident(edge.toTable)}.${ident(edge.toColumn)}`,
      relationship: edge.relationship,
      cardinality: edge.cardinality,
      join: "LEFT JOIN",
      cardinalityGuard: guard,
    });
    const previous = edge.fromTable === baseTable ? null : guards.find((g) => g.table === edge.fromTable);
    guards.push({
      column: guard,
      table: edge.toTable,
      key: edge.toColumn,
      keyColumn: `${edge.toTable}.${edge.toColumn}`,
      relationship: edge.relationship,
      fromTable: edge.fromTable,
      fromColumn: edge.fromColumn,
      path: [...(previous?.path ?? []), edge.relationship],
      // P0 is decided after metrics are compiled (contributing vs analytical
      // population); patched in `finalizeGuardSources` below.
      keySource: previous ? previous.reach : POP_CTE,
      reach: `${REACH_PREFIX}${edge.toTable}`,
      protects: [],
      scope: "join",
    });
  };

  const renderJoin = (join: JoinStep): string => `${join.join} ${qualify(join.table)} ON ${join.on}`;

  /**
   * P(n): the rows of the joined table whose key is referenced by a non-NULL
   * FK in P(n-1). Every hop is defined the same way; P0 is the
   * metric-contributing base population. A violated hop can only *add* rows
   * to P(n) (both duplicates are reachable), so a corrupted earlier hop makes
   * later guards stricter, never laxer — and its own guard refuses anyway.
   */
  const renderReach = (guard: CardinalityGuard): string => {
    const fk = `${ident(guard.fromTable)}.${ident(guard.fromColumn)}`;
    return [
      `${ident(guard.reach)} AS (`,
      `  SELECT *`,
      `  FROM ${qualify(guard.table)}`,
      `  WHERE ${ident(guard.table)}.${ident(guard.key)} IN (`,
      `    SELECT ${fk} FROM ${ident(guard.keySource)} AS ${ident(guard.fromTable)} WHERE ${fk} IS NOT NULL)`,
      `)`,
    ].join("\n");
  };

  /**
   * MAX(rows per key) over P(n). NULL when P(n) is empty: no contributing
   * fact reaches the table, so nothing can be multiplied — safe, not a
   * violation. Above 1: a reachable key is duplicated → refuse.
   */
  const renderGuard = (guard: CardinalityGuard): string => {
    const n = ident("_n");
    return (
      `(SELECT MAX(${n}) FROM ` +
      `(SELECT COUNT(*) AS ${n} FROM ${ident(guard.reach)} GROUP BY ${ident(guard.key)}) AS ${ident("_keys")})`
    );
  };

  // ---- Metric aggregation expressions (and pre-aggregation CTEs) ----
  const ctes: string[] = [];
  const cteJoins: string[] = [];
  const preAggregations: PreAggregation[] = [];
  const metricVersions: Record<string, string> = {};
  const metricSources: Record<string, { provider: string; path?: string }> = {};

  interface MetricExpr {
    expr: string;
  }

  const compiledScalars = new Map<string, MetricExpr>();

  const compileScalarMetric = (metric: Metric): MetricExpr => {
    const cached = compiledScalars.get(metric.name);
    if (cached) return cached;
    const compiled = compileScalarMetricUncached(metric);
    compiledScalars.set(metric.name, compiled);
    return compiled;
  };

  const compileScalarMetricUncached = (metric: Metric): MetricExpr => {
    const measure = metric.measure!;
    const path = model.graph.findPath(baseTable, measure.table);
    if (!path) {
      throw invalidQuery(
        `No relationship path from "${baseTable}" to measure table "${measure.table}" for metric "${metric.name}".`,
      );
    }

    if (path.ambiguous) {
      throw ambiguousQuery(
        `Metric "${metric.name}" has multiple fan-out-free paths from "${baseTable}" to "${measure.table}". Name the relationship you mean.`,
        { from: baseTable, to: measure.table, paths: path.alternatives },
      );
    }

    if (metric.semiAdditive) {
      return compileSemiAdditiveMetric(metric);
    }

    const perMetricTime = perMetricTimeFilter(metric);

    if (!path.fansOut) {
      // Measure is on the base table or safely reachable: aggregate directly.
      joinPathTo(measure.table, `measure of metric "${metric.name}"`);
      const filterClause = andFilters(compileMetricFilters(metric.filters, params, col), perMetricTime);
      const fn = aggregateFn(metric);
      return {
        expr: filterClause
          ? dialect.filteredAggregate(fn, measureSql(metric), filterClause)
          : directAggregate(metric, measureSql(metric)),
      };
    }

    // Fan-out path: deterministic pre-aggregation at the metric grain.
    return compilePreAggregatedMetric(metric, path.edges, perMetricTime);
  };

  /**
   * Semi-additive metrics keep one snapshot row per key tuple (or one snapshot
   * date overall when the key set is empty) within the requested time range —
   * and within each time bucket when a grain is requested — then aggregate.
   * Filters are applied before the snapshot is chosen, matching MetricFlow's
   * non_additive_dimension semantics.
   *
   * The snapshot selection is an inner join on the base table, so it applies
   * to every metric in the query. The caller has already refused queries that
   * mix semi-additive metrics with anything whose row selection differs; the
   * one shared CTE is built on first use.
   */
  let sharedSnapshotCte: { signature: string; name: string } | null = null;

  const compileSemiAdditiveMetric = (metric: Metric): MetricExpr => {
    const measure = metric.measure!;
    const spec = metric.semiAdditive!;
    const timeRef = metric.timeDimension;
    if (!timeRef) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" requires a time_dimension so Grane can take one snapshot per key rather than summing across dates.`,
      );
    }
    if (measure.table !== baseTable || timeRef.table !== baseTable) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" must measure a column and time on the entity table ("${baseTable}"); snapshot selection across a join is not supported.`,
      );
    }
    if (metric.countsRows || (metric.config.type !== "sum" && metric.config.type !== "min" && metric.config.type !== "max")) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" of type "${metric.config.type}" is not supported; use sum, min, or max of a column.`,
      );
    }
    for (const key of spec.keys) {
      if (key.table !== baseTable || !key.column) {
        throw unsafeQuery(
          `Semi-additive metric "${metric.name}": semi_additive.group_by "${key.table ? `${key.table}.${key.column}` : key.column}" must be a column on "${baseTable}".`,
        );
      }
    }
    for (const filter of metric.filters) {
      const ref = parseColumnRef(filter.field);
      if (!ref || ref.table !== baseTable) {
        throw unsafeQuery(
          `Semi-additive metric "${metric.name}": filter "${filter.field}" must be a column on "${baseTable}" so it can be applied before the snapshot is chosen.`,
        );
      }
    }

    const signature = semiAdditiveSignature(metric);
    if (sharedSnapshotCte && sharedSnapshotCte.signature !== signature) {
      // Guarded upstream; kept as a hard stop so a refactor cannot silently intersect two selections.
      throw unsafeQuery(`Semi-additive metric "${metric.name}" has a different snapshot selection from another metric in this query.`);
    }
    if (
      resolved.time &&
      (resolved.time.column.table !== timeRef.table || resolved.time.column.column !== timeRef.column)
    ) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" chooses its snapshot on its own time dimension ` +
          `("${timeRef.table}.${timeRef.column}"); the requested time.dimension "${resolved.time.qualified}" cannot be applied to it.`,
      );
    }
    if (spec.granularity && resolved.time?.grain && GRAIN_ORDER[resolved.time.grain] < GRAIN_ORDER[spec.granularity]) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" chooses its snapshot at ${spec.granularity} granularity; ` +
          `a ${resolved.time.grain} grain would split one snapshot period across buckets. Use ${spec.granularity} or coarser.`,
      );
    }
    if (!sharedSnapshotCte) {
      const cteName = `last_${metric.name}`;
      // Snapshot dates are compared at the declared granularity (every row in the last period is kept).
      const snapshotTime = spec.granularity ? truncTime(spec.granularity, timeRef) : col(timeRef);
      const keyExprs = spec.keys.map((key) => col(key));
      const whereParts: string[] = [];
      if (resolved.time) {
        whereParts.push(timeBoundsSql(timeRef));
      }
      const cteMetricWhere = compileMetricFilters(metric.filters, params, col);
      if (cteMetricWhere) whereParts.push(cteMetricWhere);
      let needsJoins = false;
      for (const filter of resolved.filters) {
        whereParts.push(compileQueryFilter(filter, params, col));
        if (filter.column.table !== baseTable) needsJoins = true;
      }
      const grainExpr = resolved.time?.grain ? truncTime(resolved.time.grain, timeRef) : null;
      const groupBy = [...keyExprs, ...(grainExpr ? [grainExpr] : [])];
      const agg = spec.window === "first" ? "MIN" : "MAX";
      const selects = [
        ...keyExprs.map((expr, i) => `${expr} AS ${ident(`_key${i}`)}`),
        `${agg}(${snapshotTime}) AS ${ident("_as_of")}`,
        ...(grainExpr ? [`${grainExpr} AS ${ident("_period")}`] : []),
      ];
      const cteSql = [
        `${ident(cteName)} AS (`,
        `  SELECT ${selects.join(", ")}`,
        `  FROM ${qualify(baseTable)}`,
        ...(needsJoins ? joins.map((join) => `  ${renderJoin(join)}`) : []),
        ...(whereParts.length > 0 ? [`  WHERE ${whereParts.join(" AND ")}`] : []),
        ...(groupBy.length > 0 ? [`  GROUP BY ${groupBy.join(", ")}`] : []),
        `)`,
      ].join("\n");
      ctes.push(cteSql);
      const onParts = [
        ...keyExprs.map((expr, i) => `${ident(cteName)}.${ident(`_key${i}`)} = ${expr}`),
        `${ident(cteName)}.${ident("_as_of")} = ${snapshotTime}`,
      ];
      cteJoins.push(`JOIN ${ident(cteName)} ON ${onParts.join(" AND ")}`);
      sharedSnapshotCte = { signature, name: cteName };
    }
    // Rows at the chosen snapshot date that fail the metric filter must not be aggregated.
    const metricWhere = compileMetricFilters(metric.filters, params, col);
    preAggregations.push({
      metric: metric.name,
      cte: sharedSnapshotCte.name,
      measureTable: measure.table,
      keyColumn: spec.keys.map((key) => `${key.table}.${key.column}`).join(", ") || "(single snapshot date)",
    });
    const fn = aggregateFn(metric);
    return {
      expr: metricWhere ? dialect.filteredAggregate(fn, col(measure), metricWhere) : `${fn}(${col(measure)})`,
    };
  };

  const timeBoundsSql = (ref: ColumnRef): string => {
    const expr = timeExpr(ref);
    const from = resolved.time!.from;
    const toExclusive = exclusiveEnd(resolved.time!.to);
    return `${expr} >= ${timeBound(from, ref)} AND ${expr} < ${timeBound(toExclusive, ref)}`;
  };

  const perMetricTimeFilter = (metric: Metric): string | null => {
    if (!resolved.time || resolved.time.shared) return null;
    if (!metric.timeDimension) return null;
    return timeBoundsSql(metric.timeDimension);
  };

  const components = expandComponents(model, resolved.metrics);
  const semiComponents = components.filter((metric) => metric.semiAdditive);
  const anySemiAdditive = semiComponents.length > 0;
  if (anySemiAdditive) {
    const other = components.find((metric) => !metric.semiAdditive);
    const first = semiComponents[0]!;
    const conflicting = semiComponents.find(
      (metric) => semiAdditiveSignature(metric) !== semiAdditiveSignature(first),
    );
    const clash = other ?? conflicting;
    if (clash) {
      throw unsafeQuery(
        `Semi-additive metric "${first.name}" keeps one snapshot row per key within the time range; ` +
          `combining it with "${clash.name}" in one query would apply that row selection to both and corrupt at least one number. ` +
          `Query them separately.`,
      );
    }
  }
  const skipOuterTime = Boolean(resolved.time && (!resolved.time.shared || anySemiAdditive));

  /**
   * many_to_one hops taken inside a pre-aggregation CTE. Guards are emitted
   * after P0 is known so they can scope to this metric's contributing rows.
   */
  interface PreAggHopPlan {
    metric: Metric;
    childTable: string;
    childKey: string;
    parentKey: string;
    firstRelationship: string;
    hops: Edge[];
    childFilters: MetricFilterItem[];
  }
  const preAggHopPlans: PreAggHopPlan[] = [];
  const preAggReachCtes: string[] = [];

  const compilePreAggregatedMetric = (metric: Metric, edges: Edge[], extraTimeFilter: string | null): MetricExpr => {
    if (metric.config.type === "count_distinct") {
      throw unsafeQuery(
        `Metric "${metric.name}" is a count_distinct across a one_to_many relationship; it cannot be safely pre-aggregated in V0.1.`,
      );
    }
    const measure = metric.measure!;
    const cteName = `m_${metric.name}`;
    const firstEdge = edges[0]!;
    // The CTE starts at the child side of the first fan-out hop; its key is
    // the child column that references the base table.
    const keyExpr = `${ident(firstEdge.toTable)}.${ident(firstEdge.toColumn)}`;
    const baseKeyExpr = `${ident(firstEdge.fromTable)}.${ident(firstEdge.fromColumn)}`;
    if (firstEdge.fromTable !== baseTable) {
      // Multi-hop before the fan-out would need intermediate joins from base;
      // out of scope for V0.1's deterministic guarantees.
      throw unsafeQuery(
        `Metric "${metric.name}" measures "${measure.table}" via an indirect fan-out path; Grane currently supports pre-aggregation only for direct children of the metric's entity table ("${baseTable}").`,
      );
    }

    const cteJoinClauses: string[] = [];
    const cteTables = new Set<string>([firstEdge.toTable]);
    const laterHops: Edge[] = [];
    for (const edge of edges.slice(1)) {
      if (cteTables.has(edge.toTable)) continue;
      cteTables.add(edge.toTable);
      laterHops.push(edge);
      // LEFT JOIN: a missing / NULL target must not drop the child fact.
      // For SUM/COUNT/AVG/MIN/MAX of the joined measure column this agrees
      // with INNER JOIN (aggregates skip NULLs) but preserves the child row
      // in the CTE population, matching ordinary many_to_one traversal.
      cteJoinClauses.push(
        `  LEFT JOIN ${qualify(edge.toTable)} ON ${ident(edge.fromTable)}.${ident(edge.fromColumn)} = ${ident(edge.toTable)}.${ident(edge.toColumn)}`,
      );
    }

    // Metric filters: path-table filters go inside the CTE; base-table filters
    // become a FILTER clause on the outer aggregate.
    const insideFilters: MetricFilterItem[] = [];
    const outerFilters: MetricFilterItem[] = [];
    for (const filter of metric.filters) {
      const ref = parseColumnRef(filter.field)!;
      (ref.table === baseTable ? outerFilters : insideFilters).push(filter);
    }
    const insideWhere = compileMetricFilters(insideFilters, params, col);
    const childFilters = insideFilters.filter((filter) => parseColumnRef(filter.field)?.table === firstEdge.toTable);
    if (laterHops.some((edge) => edge.cardinality !== "one_to_many")) {
      preAggHopPlans.push({
        metric,
        childTable: firstEdge.toTable,
        childKey: firstEdge.toColumn,
        parentKey: firstEdge.fromColumn,
        firstRelationship: firstEdge.relationship,
        hops: laterHops.filter((edge) => edge.cardinality !== "one_to_many"),
        childFilters,
      });
    }

    const valueColumns: string[] = [];
    let outerExpr: string;
    const measureCol = measureSql(metric);
    switch (metric.config.type) {
      case "sum":
        valueColumns.push(`SUM(${measureCol}) AS ${ident("value")}`);
        outerExpr = `SUM(${ident(cteName)}.${ident("value")})`;
        break;
      case "count":
        valueColumns.push(`COUNT(${measureCol}) AS ${ident("value")}`);
        outerExpr = `COALESCE(SUM(${ident(cteName)}.${ident("value")}), 0)`;
        break;
      case "min":
        valueColumns.push(`MIN(${measureCol}) AS ${ident("value")}`);
        outerExpr = `MIN(${ident(cteName)}.${ident("value")})`;
        break;
      case "max":
        valueColumns.push(`MAX(${measureCol}) AS ${ident("value")}`);
        outerExpr = `MAX(${ident(cteName)}.${ident("value")})`;
        break;
      case "avg":
        valueColumns.push(`SUM(${measureCol}) AS ${ident("value_sum")}`, `COUNT(${measureCol}) AS ${ident("value_count")}`);
        outerExpr = `SUM(${ident(cteName)}.${ident("value_sum")}) / NULLIF(SUM(${ident(cteName)}.${ident("value_count")}), 0)`;
        break;
      default:
        throw unsafeQuery(`Unsupported pre-aggregated metric type "${metric.config.type}".`);
    }

    const cteSql = [
      `${ident(cteName)} AS (`,
      `  SELECT ${keyExpr} AS ${ident("_key")}, ${valueColumns.join(", ")}`,
      `  FROM ${qualify(firstEdge.toTable)}`,
      ...cteJoinClauses,
      ...(insideWhere ? [`  WHERE ${insideWhere}`] : []),
      `  GROUP BY ${keyExpr}`,
      `)`,
    ].join("\n");
    ctes.push(cteSql);
    cteJoins.push(
      `LEFT JOIN ${ident(cteName)} ON ${ident(cteName)}.${ident("_key")} = ${baseKeyExpr}`,
    );
    preAggregations.push({
      metric: metric.name,
      cte: cteName,
      measureTable: measure.table,
      keyColumn: `${firstEdge.toTable}.${firstEdge.toColumn}`,
    });

    const outerFilterClause = andFilters(compileMetricFilters(outerFilters, params, col), extraTimeFilter);
    if (outerFilterClause) {
      const cteVal = `${ident(cteName)}.${ident("value")}`;
      if (metric.config.type === "avg") {
        outerExpr =
          `SUM(CASE WHEN ${outerFilterClause} THEN ${ident(cteName)}.${ident("value_sum")} END) / ` +
          `NULLIF(SUM(CASE WHEN ${outerFilterClause} THEN ${ident(cteName)}.${ident("value_count")} END), 0)`;
      } else if (metric.config.type === "count") {
        outerExpr = `COALESCE(${dialect.filteredAggregate("SUM", cteVal, outerFilterClause)}, 0)`;
      } else {
        const fn = aggregateFn(metric);
        outerExpr = dialect.filteredAggregate(fn, cteVal, outerFilterClause);
      }
    }
    return { expr: outerExpr };
  };

  /**
   * `fill_nulls_with` is applied after aggregation (COALESCE over the
   * aggregate), exactly where MetricFlow applies it. It cannot invent rows: a
   * metric declared `join_to_timespine` expects a row per period even when the
   * period has no data, and Grane has no time spine to draw those rows from, so
   * a per-period breakdown is refused instead of returned sparse.
   *
   * TODO(follow-up, product decision): metric-definition filters are FILTER
   * clauses over the analytical population, so a group with no contributing
   * rows still appears (NULL, or the fill value). MetricFlow filters the rows
   * first and omits such groups. Aggregates agree; row sets (and therefore
   * ORDER BY/LIMIT over them) can differ. Not to be changed casually.
   */
  const fillNulls = (metric: Metric, expr: string): string => {
    if (metric.config.join_to_timespine && resolved.time?.grain) {
      throw unsafeQuery(
        `Metric "${metric.name}" is declared join_to_timespine: a per-${resolved.time.grain} breakdown must include periods with no rows, ` +
          `and Grane does not generate empty periods. Query the total for the time range, or group by a non-time dimension.`,
      );
    }
    const fill = metric.config.fill_nulls_with;
    return fill === undefined ? expr : `COALESCE(${expr}, ${fill})`;
  };

  const compileMetricExpr = (metric: Metric): string => {
    metricVersions[metric.name] = metric.definitionVersion;
    if (metric.config.source) metricSources[metric.name] = metric.config.source;
    if (metric.config.type === "ratio") {
      const numerator = model.metrics.get(metric.config.numerator!);
      const denominator = model.metrics.get(metric.config.denominator!);
      if (!numerator || !denominator) {
        throw invalidQuery(
          `Ratio metric "${metric.name}" references undefined component metrics. Run "grane validate".`,
        );
      }
      for (const [role, component] of [
        ["numerator", numerator],
        ["denominator", denominator],
      ] as const) {
        if (component.config.entity !== metric.config.entity) {
          throw unsafeQuery(
            `Ratio "${metric.name}" mixes grains: ${role} "${component.name}" is defined at entity "${component.config.entity}" ` +
              `but the ratio is at "${metric.config.entity}". Aggregating "${component.name}" at the "${baseTable}" grain would change its meaning. ` +
              `Ratio components must share one entity.`,
          );
        }
      }
      metricVersions[numerator.name] = numerator.definitionVersion;
      metricVersions[denominator.name] = denominator.definitionVersion;
      if (numerator.config.source) metricSources[numerator.name] = numerator.config.source;
      if (denominator.config.source) metricSources[denominator.name] = denominator.config.source;
      const num = fillNulls(numerator, compileScalarMetric(numerator).expr);
      const den = fillNulls(denominator, compileScalarMetric(denominator).expr);
      return fillNulls(metric, `${dialect.castNumeric(num)} / NULLIF(${dialect.castNumeric(den)}, 0)`);
    }
    return fillNulls(metric, compileScalarMetric(metric).expr);
  };

  // Pre-plan joins for dimensions/filters/time before metric CTE joins so the
  // outer FROM clause reads naturally (plain joins first, then CTE joins).
  for (const dimension of resolved.dimensions) {
    joinPathTo(dimension.column.table, `dimension "${dimension.name}"`);
  }
  for (const raw of resolved.rawDimensions) {
    joinPathTo(raw.ref.table, `raw dimension "${raw.qualified}"`);
  }
  for (const filter of resolved.filters) {
    joinPathTo(filter.column.table, `filter on "${filter.field}"`);
  }
  for (const metric of components) {
    for (const filter of metric.filters) {
      const ref = parseColumnRef(filter.field);
      if (!ref || ref.table === baseTable) continue;
      const path = model.graph.findPath(baseTable, ref.table);
      // Filters on a one_to_many path belong inside the pre-aggregation CTE,
      // not as an outer join that would fan out the grain.
      if (path && !path.fansOut && !path.ambiguous) {
        joinPathTo(ref.table, `metric filter "${filter.field}" of "${metric.name}"`);
      }
    }
  }
  if (resolved.time) {
    joinPathTo(resolved.time.column.table, "time range");
  }

  const metricSelects = resolved.metrics.map(
    (metric) => `${compileMetricExpr(metric)} AS ${ident(metric.name)}`,
  );
  const rawMetricSelects = resolved.rawMetrics.map((metric) => {
    const measureExpr = col(metric.field);
    const expr =
      metric.type === "count_distinct"
        ? `COUNT(DISTINCT ${measureExpr})`
        : `${rawAggregateFn(metric.type)}(${measureExpr})`;
    return `${expr} AS ${ident(metric.alias)}`;
  });

  // ---- SELECT list and GROUP BY ----
  const selects: string[] = [];
  const selectAliases: string[] = [];
  const groupColumns: string[] = [];
  const groupBy: string[] = [];

  if (resolved.time?.grain) {
    const alias = timeAlias(resolved.time.grain);
    const expr = truncTime(resolved.time.grain, resolved.time.column);
    selects.push(`${expr} AS ${ident(alias)}`);
    selectAliases.push(alias);
    groupColumns.push(alias);
    groupBy.push(String(selects.length));
  }
  for (const dimension of resolved.dimensions) {
    selects.push(`${col(dimension.column)} AS ${ident(dimension.name)}`);
    selectAliases.push(dimension.name);
    groupColumns.push(dimension.name);
    groupBy.push(String(selects.length));
  }
  for (const raw of resolved.rawDimensions) {
    selects.push(`${col(raw.ref)} AS ${ident(raw.alias)}`);
    selectAliases.push(raw.alias);
    groupColumns.push(raw.alias);
    groupBy.push(String(selects.length));
  }
  selects.push(...metricSelects);
  selectAliases.push(...resolved.metrics.map((m) => m.name));
  selects.push(...rawMetricSelects);
  selectAliases.push(...resolved.rawMetrics.map((m) => m.alias));
  // Guards are emitted separately (in __grane_card CTE) when joins exist.

  // ---- Metric-contributing population ----
  // A base row can contribute to metric M only if it passes M's own
  // base-table filters (and M's own time window when the query's time range is
  // applied per metric). Filters on joined tables are relationship
  // traversals, not contribution predicates: they are evaluated *through* the
  // join and must not hide a violation of that join (see C1/C2/C3 in
  // tests/unit/query-cardinality.test.ts). Every join in this statement sits in
  // the one shared FROM, so a duplicated key multiplies the facts feeding
  // *every* metric that row contributes to; the population a guard protects is
  // therefore the union over all requested metrics. null = unfiltered = TRUE.
  const contributionPredicate = (metric: Metric): string | null => {
    const baseFilters = metric.filters.filter((filter) => parseColumnRef(filter.field)?.table === baseTable);
    return andFilters(compileMetricFilters(baseFilters, params, col), perMetricTimeFilter(metric));
  };
  const contributions = components.map(contributionPredicate);
  const everyRowContributes = resolved.rawMetrics.length > 0 || contributions.some((predicate) => predicate === null);
  const contributionWhere = everyRowContributes
    ? null
    : contributions.map((predicate) => `(${predicate})`).join("\n     OR ");
  const p0 = contributionWhere ? CONTRIB_CTE : POP_CTE;
  const protectedMetrics = [...resolved.metrics.map((m) => m.name), ...resolved.rawMetrics.map((m) => m.alias)];
  for (const guard of guards) {
    if (guard.scope === "join" && guard.fromTable === baseTable) guard.keySource = p0;
    if (guard.scope === "join") guard.protects = protectedMetrics;
  }

  // Pre-aggregation many_to_one hops: same guard contract, scoped to the
  // child rows that this metric's contributing base rows actually reach.
  for (const plan of preAggHopPlans) {
    const metricPred = contributionPredicate(plan.metric);
    const childCte = `${REACH_PREFIX}pre_${plan.metric.name}_${plan.childTable}`;
    const parentIn = `${ident(plan.childTable)}.${ident(plan.childKey)} IN (SELECT ${ident(baseTable)}.${ident(plan.parentKey)} FROM ${ident(POP_CTE)} AS ${ident(baseTable)}${metricPred ? ` WHERE ${metricPred}` : ""})`;
    const childFilterSql = compileMetricFilters(plan.childFilters, params, col);
    const childWhere = childFilterSql ? `${parentIn}\n    AND ${childFilterSql}` : parentIn;
    preAggReachCtes.push(
      [
        `${ident(childCte)} AS (`,
        `  SELECT *`,
        `  FROM ${qualify(plan.childTable)}`,
        `  WHERE ${childWhere}`,
        `)`,
      ].join("\n"),
    );
    const protects = [
      ...new Set([
        plan.metric.name,
        ...resolved.metrics
          .filter(
            (requested) =>
              requested.name === plan.metric.name ||
              requested.config.numerator === plan.metric.name ||
              requested.config.denominator === plan.metric.name,
          )
          .map((requested) => requested.name),
      ]),
    ];
    let previousSource = childCte;
    let previousPath = [plan.firstRelationship];
    for (const edge of plan.hops) {
      const guard: CardinalityGuard = {
        column: `${GUARD_PREFIX}pre_${plan.metric.name}_${edge.toTable}`,
        table: edge.toTable,
        key: edge.toColumn,
        keyColumn: `${edge.toTable}.${edge.toColumn}`,
        relationship: edge.relationship,
        fromTable: edge.fromTable,
        fromColumn: edge.fromColumn,
        path: [...previousPath, edge.relationship],
        keySource: previousSource,
        reach: `${REACH_PREFIX}pre_${plan.metric.name}_${edge.toTable}`,
        protects,
        scope: "preagg",
      };
      guards.push(guard);
      previousSource = guard.reach;
      previousPath = guard.path;
    }
  }

  // ---- WHERE ----
  // Fact-side filters: time bounds (when not already inside a snapshot CTE) +
  // filters on the base table itself. These define the analytical population.
  // Joined-dimension filters go only in the analytical result query, not in
  // the population used for cardinality scoping.
  const factSideWhere: string[] = [];
  if (resolved.time && !skipOuterTime) {
    const expr = timeExpr(resolved.time.column);
    const from = resolved.time.from;
    const toExclusive = exclusiveEnd(resolved.time.to);
    factSideWhere.push(`${expr} >= ${timeBound(from, resolved.time.column)}`);
    factSideWhere.push(`${expr} < ${timeBound(toExclusive, resolved.time.column)}`);
  }
  const joinedDimFilters: string[] = [];
  for (const filter of resolved.filters) {
    const clause = compileQueryFilter(filter, params, col);
    if (filter.column.table === baseTable) {
      factSideWhere.push(clause);
    } else {
      joinedDimFilters.push(clause);
    }
  }

  // ---- ORDER BY ----
  const orderClauses: string[] = [];
  for (const order of resolved.order) {
    orderClauses.push(`${ident(order.field)} ${order.direction === "desc" ? "DESC" : "ASC"}`);
  }
  if (orderClauses.length === 0) {
    if (resolved.time?.grain) {
      orderClauses.push(`${ident(timeAlias(resolved.time.grain))} ASC`);
    } else if (
      (resolved.dimensions.length > 0 || resolved.rawDimensions.length > 0) &&
      (resolved.metrics.length > 0 || resolved.rawMetrics.length > 0)
    ) {
      const first = resolved.metrics[0]?.name ?? resolved.rawMetrics[0]!.alias;
      orderClauses.push(`${ident(first)} DESC`);
    }
  }

  // ---- Assemble ----
  // No joins → no guards → the plain statement. With joins, the statement is
  // layered so validation and execution read one snapshot:
  //
  //   __grane_pop       analytical population (base rows after time bounds and
  //                     base-table query filters; snapshot rows for
  //                     semi-additive metrics)
  //   __grane_contrib   P0: rows of __grane_pop that can contribute to at least
  //                     one requested metric (omitted when every row can)
  //   __grane_reach_T   P(n): rows of T referenced by a non-NULL FK in P(n-1),
  //                     one per joined table, in traversal order
  //   __grane_card      one scalar per guard: MAX(rows per key) over P(n)
  //   __grane_result    the analytical SELECT over __grane_pop + joins
  //   outer SELECT      __grane_card LEFT JOIN __grane_result ON TRUE, so the
  //                     guard row exists even when GROUP BY yields no rows
  const lines: string[] = [];

  if (guards.length === 0) {
    if (ctes.length > 0) {
      lines.push(`WITH ${ctes.join(",\n")}`);
    }
    lines.push(`SELECT ${selects.join(",\n       ")}`);
    lines.push(`FROM ${qualify(baseTable)}`);
    for (const join of joins) {
      lines.push(renderJoin(join));
    }
    lines.push(...cteJoins);
    const allWhere = [...factSideWhere, ...joinedDimFilters];
    if (allWhere.length > 0) {
      lines.push(`WHERE ${allWhere.join("\n  AND ")}`);
    }
    if (groupBy.length > 0) {
      lines.push(`GROUP BY ${groupBy.join(", ")}`);
    }
    if (orderClauses.length > 0) {
      lines.push(`ORDER BY ${orderClauses.join(", ")}`);
    }
    lines.push(`LIMIT ${resolved.limit}`);
  } else {
    const snapshotJoin = sharedSnapshotCte
      ? cteJoins.find((j) => j.startsWith(`JOIN ${ident(sharedSnapshotCte!.name)} `))
      : undefined;

    // --- Analytical population ---
    // Semi-additive: the snapshot CTE applies time bounds, the metric filters
    // and the query filters before the snapshot is chosen (as MetricFlow
    // does). The chosen date only identifies the snapshot; base-table query
    // filters must be reapplied to the rows AT that date, otherwise a row that
    // fails the filter but shares the date would be aggregated (and could
    // reach a duplicate key it has no business reaching). Joined-dimension
    // filters stay in __grane_result by policy; metric filters stay in P0 and
    // the FILTER clause. Time bounds are implied by the snapshot date.
    const popCteLines = [`${ident(POP_CTE)} AS (`];
    if (snapshotJoin) {
      popCteLines.push(`  SELECT ${ident(baseTable)}.*`, `  FROM ${qualify(baseTable)}`, `  ${snapshotJoin}`);
    } else {
      popCteLines.push(`  SELECT *`, `  FROM ${qualify(baseTable)}`);
    }
    if (factSideWhere.length > 0) {
      popCteLines.push(`  WHERE ${factSideWhere.join("\n    AND ")}`);
    }
    popCteLines.push(`)`);

    // --- Metric-contributing population (P0) ---
    const contribCteLines = contributionWhere
      ? [
          `${ident(CONTRIB_CTE)} AS (`,
          `  SELECT *`,
          `  FROM ${ident(POP_CTE)} AS ${ident(baseTable)}`,
          `  WHERE ${contributionWhere}`,
          `)`,
        ]
      : [];

    // --- Reachable populations P(1..n) and guards ---
    // Pre-aggregation child populations first (they are keySources of later hops).
    const reachCtes = [...preAggReachCtes, ...guards.map(renderReach)];
    const cardCteLines = [
      `${ident("__grane_card")} AS (`,
      `  SELECT ${guards.map((g) => `${renderGuard(g)} AS ${ident(g.column)}`).join(",\n         ")}`,
      `)`,
    ];

    // --- Analytical result ---
    const resultCteLines = [`${ident("__grane_result")} AS (`];
    resultCteLines.push(`  SELECT ${selects.join(",\n         ")}`);
    resultCteLines.push(`  FROM ${ident(POP_CTE)} AS ${ident(baseTable)}`);
    for (const join of joins) {
      resultCteLines.push(`  ${renderJoin(join)}`);
    }
    // The snapshot join is already inside __grane_pop; pre-aggregation joins are not.
    for (const j of cteJoins) {
      if (j !== snapshotJoin) resultCteLines.push(`  ${j}`);
    }
    if (joinedDimFilters.length > 0) {
      resultCteLines.push(`  WHERE ${joinedDimFilters.join("\n    AND ")}`);
    }
    if (groupBy.length > 0) {
      resultCteLines.push(`  GROUP BY ${groupBy.join(", ")}`);
    }
    if (orderClauses.length > 0) {
      // TODO(follow-up): ORDER BY + LIMIT live inside this CTE (LIMIT needs
      // the ORDER BY here); the outer wrapper has no ORDER BY, and SQL does
      // not guarantee a CTE's order survives the outer join. Repeat the
      // ordering on the outer SELECT, with dialect NULL-placement parity.
      resultCteLines.push(`  ORDER BY ${orderClauses.join(", ")}`);
    }
    resultCteLines.push(`  LIMIT ${resolved.limit}`, `)`);

    const outerSelects = [
      ...selectAliases.map((alias) => `${ident("__grane_result")}.${ident(alias)}`),
      ...guards.map((g) => `${ident("__grane_card")}.${ident(g.column)}`),
    ];
    const allCtes = [
      ...ctes,
      popCteLines.join("\n"),
      ...(contribCteLines.length > 0 ? [contribCteLines.join("\n")] : []),
      ...reachCtes,
      cardCteLines.join("\n"),
      resultCteLines.join("\n"),
    ];
    lines.push(`WITH ${allCtes.join(",\n")}`);
    lines.push(`SELECT ${outerSelects.join(",\n       ")}`);
    lines.push(`FROM ${ident("__grane_card")}`);
    lines.push(`LEFT JOIN ${ident("__grane_result")} ON TRUE`);
  }

  const finalized = params.finalize(lines.join("\n"));

  return {
    sql: finalized.sql,
    params: finalized.values,
    plan: {
      baseTable,
      joins,
      preAggregations,
      columns: selectAliases,
      groupColumns,
      population: {
        analytical: guards.length > 0 ? POP_CTE : null,
        contributing: guards.length > 0 ? p0 : null,
      },
    },
    guards,
    metricVersions,
    metricSources,
    trust: resolved.trust,
    governed: resolved.governed,
    ungoverned: resolved.ungoverned,
    warning: resolved.warning,
  };
}

function aggregateFn(metric: Metric): "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" {
  switch (metric.config.type) {
    case "sum":
      return "SUM";
    case "count":
    case "count_distinct":
      return "COUNT";
    case "avg":
      return "AVG";
    case "min":
      return "MIN";
    case "max":
      return "MAX";
    default:
      throw invalidQuery(`Unsupported metric type "${metric.config.type}".`);
  }
}

function directAggregate(metric: Metric, measureExpr: string): string {
  if (metric.config.type === "count_distinct") return `COUNT(DISTINCT ${measureExpr})`;
  return `${aggregateFn(metric)}(${measureExpr})`;
}

function andFilters(...parts: Array<string | null | undefined>): string | null {
  const ok = parts.filter((part): part is string => Boolean(part && part.length > 0));
  return ok.length > 0 ? ok.join(" AND ") : null;
}

/** Scalar metrics behind the requested metrics (ratios contribute their components). */
function expandComponents(model: SemanticModel, metrics: Metric[]): Metric[] {
  const out: Metric[] = [];
  for (const metric of metrics) {
    if (metric.config.type === "ratio") {
      const numerator = model.metrics.get(metric.config.numerator!);
      const denominator = model.metrics.get(metric.config.denominator!);
      if (numerator) out.push(numerator);
      if (denominator) out.push(denominator);
    } else {
      out.push(metric);
    }
  }
  return out;
}

const GRAIN_ORDER = { day: 0, week: 1, month: 2, quarter: 3, year: 4 } as const;

/** Everything that decides which snapshot rows a semi-additive metric keeps. */
function semiAdditiveSignature(metric: Metric): string {
  const spec = metric.semiAdditive!;
  return JSON.stringify({
    table: metric.measure?.table,
    time: metric.timeDimension,
    window: spec.window,
    granularity: spec.granularity,
    keys: spec.keys,
    filters: metric.filters.map((filter) => JSON.stringify(filter)).sort(),
  });
}

function compileMetricFilters(
  filters: MetricFilterItem[],
  params: Params,
  formatCol: (ref: ColumnRef) => string,
): string | null {
  if (filters.length === 0) return null;
  const clauses = filters.map((filter) => {
    const ref = parseColumnRef(filter.field);
    if (!ref) {
      throw invalidQuery(`Metric filter field "${filter.field}" is not a table.column reference.`);
    }
    return compileOperator(formatCol(ref), filter.operator, filter.value, params);
  });
  return clauses.join(" AND ");
}

function compileQueryFilter(
  filter: ResolvedFilter,
  params: Params,
  formatCol: (ref: ColumnRef) => string,
): string {
  return compileOperator(formatCol(filter.column), filter.operator, filter.value, params);
}

function rawAggregateFn(type: "sum" | "count" | "count_distinct" | "avg" | "min" | "max"): "SUM" | "COUNT" | "AVG" | "MIN" | "MAX" {
  switch (type) {
    case "sum":
      return "SUM";
    case "count":
    case "count_distinct":
      return "COUNT";
    case "avg":
      return "AVG";
    case "min":
      return "MIN";
    case "max":
      return "MAX";
  }
}

function compileOperator(
  columnExpr: string,
  operator: FilterOperator,
  value: Scalar | Scalar[] | undefined,
  params: Params,
): string {
  switch (operator) {
    case "is_null":
      return `${columnExpr} IS NULL`;
    case "is_not_null":
      return `${columnExpr} IS NOT NULL`;
    case "in":
    case "not_in": {
      const values = Array.isArray(value) ? value : [value as Scalar];
      if (values.length === 0) {
        throw invalidQuery(`Operator "${operator}" requires a non-empty array value.`);
      }
      const placeholders = values.map((v) => params.add(v)).join(", ");
      return `${columnExpr} ${operator === "in" ? "IN" : "NOT IN"} (${placeholders})`;
    }
    case "contains":
      return params.dialect.contains(columnExpr, params.add(value as Scalar));
    case "=":
    case "!=":
    case ">":
    case ">=":
    case "<":
    case "<=": {
      if (Array.isArray(value)) {
        throw invalidQuery(`Operator "${operator}" does not accept an array value.`);
      }
      const op = operator === "!=" ? "<>" : operator;
      return `${columnExpr} ${op} ${params.add(value as Scalar)}`;
    }
  }
}
