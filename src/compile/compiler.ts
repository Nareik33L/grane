import type { SemanticModel, Metric } from "../model/model.js";
import type { ResolvedQuery, ResolvedFilter } from "../query/resolve.js";
import { timeAlias } from "../query/resolve.js";
import type { Edge } from "../model/graph.js";
import type { FilterOperator, Scalar, MetricFilterItem } from "../config/schema.js";
import { parseColumnRef, type ColumnRef } from "../model/refs.js";
import { exclusiveEnd } from "../query/time.js";
import { ambiguousQuery, invalidQuery, unsafeQuery } from "../errors.js";
import { getDialect, postgresDialect, type SqlDialect } from "../connectors/dialect.js";
import { compilerNamespace } from "../connectors/create.js";
import type { DatabaseSchema } from "../connectors/types.js";

/**
 * The deterministic query compiler.
 *
 * Given a resolved semantic query, Grane — not the agent — chooses the joins
 * and generates the SQL. Measures that live across a one_to_many relationship
 * are pre-aggregated at the metric grain inside CTEs so fan-out can never
 * multiply rows and corrupt results.
 */

export interface JoinStep {
  table: string;
  on: string;
  relationship: string;
  cardinality: string;
}

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
}

export interface CompiledQuery {
  sql: string;
  params: Scalar[];
  plan: QueryPlan;
  metricVersions: Record<string, string>;
  metricSources: Record<string, { provider: string; path?: string }>;
  trust: ResolvedQuery["trust"];
  governed: string[];
  ungoverned: string[];
  warning: string | null;
}

class Params {
  readonly values: Scalar[] = [];
  constructor(readonly dialect: SqlDialect) {}
  add(value: Scalar): string {
    this.values.push(value);
    return this.dialect.placeholder(this.values.length, value);
  }
}

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
  const qualify = (table: string): string => dialect.qualifyTable(schema, table);

  const localTime = (ref: ColumnRef): string => {
    if (isCivilDateColumn(warehouseSchema, ref)) return col(ref);
    return dialect.localizeTime(col(ref), timezone);
  };

  const weekStarts = model.config.project.week.starts;
  const trunc = (grain: string, expr: string): string => {
    if (grain === "week" && weekStarts === "sunday") {
      if (dialect.type === "clickhouse") return `toStartOfWeek(${expr}, 0)`;
      if (dialect.type === "mysql") {
        return `DATE_SUB(DATE(${expr}), INTERVAL DAYOFWEEK(${expr}) - 1 DAY)`;
      }
      return `(${dialect.dateTrunc("week", `(${expr} + INTERVAL '1 day')`)} - INTERVAL '1 day')`;
    }
    return dialect.dateTrunc(grain, expr);
  };

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

  const addJoinEdge = (edge: Edge): void => {
    if (joinedTables.has(edge.toTable)) return;
    joinedTables.add(edge.toTable);
    joins.push({
      table: edge.toTable,
      on: `${ident(edge.fromTable)}.${ident(edge.fromColumn)} = ${ident(edge.toTable)}.${ident(edge.toColumn)}`,
      relationship: edge.relationship,
      cardinality: edge.cardinality,
    });
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

  const compileScalarMetric = (metric: Metric): MetricExpr => {
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

    if (metric.config.additive === "semi") {
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
          ? dialect.filteredAggregate(fn, col(measure), filterClause)
          : directAggregate(metric, col(measure)),
      };
    }

    // Fan-out path: deterministic pre-aggregation at the metric grain.
    return compilePreAggregatedMetric(metric, path.edges, perMetricTime);
  };

  const compileSemiAdditiveMetric = (metric: Metric): MetricExpr => {
    const measure = metric.measure!;
    const entity = model.entities.get(metric.config.entity);
    if (!entity) {
      throw invalidQuery(`Entity "${metric.config.entity}" is not defined.`);
    }
    const pk = entity.config.primary_key;
    const timeRef = metric.timeDimension;
    if (!timeRef) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" requires a time_dimension so Grane can take last-as-of rather than summing across dates.`,
      );
    }
    if (measure.table !== baseTable) {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" must measure a column on the entity table ("${baseTable}"); last-as-of across a join is not supported.`,
      );
    }
    if (metric.config.type !== "sum" && metric.config.type !== "min" && metric.config.type !== "max") {
      throw unsafeQuery(
        `Semi-additive metric "${metric.name}" of type "${metric.config.type}" is not supported; use sum, min, or max.`,
      );
    }

    joinPathTo(measure.table, `measure of metric "${metric.name}"`);
    const cteName = `last_${metric.name}`;
    const pkExpr = `${ident(measure.table)}.${ident(pk)}`;
    const timeExpr = col(timeRef);
    const whereParts: string[] = [];
    if (resolved.time) {
      const toExclusive = exclusiveEnd(resolved.time.to);
      whereParts.push(`${localTime(timeRef)} < ${dialect.castTimestamp(params.add(toExclusive))}`);
      if (resolved.time.grain) {
        whereParts.push(`${localTime(timeRef)} >= ${dialect.castTimestamp(params.add(resolved.time.from))}`);
      }
    }
    const metricWhere = compileMetricFilters(metric.filters, params, col);
    if (metricWhere) whereParts.push(metricWhere);

    const grainExpr = resolved.time?.grain
      ? trunc(resolved.time.grain, localTime(timeRef))
      : null;
    const cteSql = [
      `${ident(cteName)} AS (`,
      `  SELECT ${pkExpr} AS ${ident("_key")}, MAX(${timeExpr}) AS ${ident("_as_of")}` +
        (grainExpr ? `, ${grainExpr} AS ${ident("_period")}` : ""),
      `  FROM ${qualify(measure.table)}`,
      ...(whereParts.length > 0 ? [`  WHERE ${whereParts.join(" AND ")}`] : []),
      `  GROUP BY ${pkExpr}` + (grainExpr ? `, ${grainExpr}` : ""),
      `)`,
    ].join("\n");
    ctes.push(cteSql);
    cteJoins.push(
      `JOIN ${ident(cteName)} ON ${ident(cteName)}.${ident("_key")} = ${pkExpr} AND ${ident(cteName)}.${ident("_as_of")} = ${timeExpr}`,
    );
    preAggregations.push({
      metric: metric.name,
      cte: cteName,
      measureTable: measure.table,
      keyColumn: `${measure.table}.${pk}`,
    });
    return { expr: `${aggregateFn(metric)}(${col(measure)})` };
  };

  const timeBoundsSql = (ref: ColumnRef): string => {
    const expr = localTime(ref);
    const from = resolved.time!.from;
    const toExclusive = exclusiveEnd(resolved.time!.to);
    return `${expr} >= ${dialect.castTimestamp(params.add(from))} AND ${expr} < ${dialect.castTimestamp(params.add(toExclusive))}`;
  };

  const perMetricTimeFilter = (metric: Metric): string | null => {
    if (!resolved.time || resolved.time.shared) return null;
    if (!metric.timeDimension) return null;
    return timeBoundsSql(metric.timeDimension);
  };

  const anySemiAdditive = resolved.metrics.some((metric) => isSemiAdditive(model, metric));
  const skipOuterTime = Boolean(resolved.time && (!resolved.time.shared || anySemiAdditive));

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
    for (const edge of edges.slice(1)) {
      if (cteTables.has(edge.toTable)) continue;
      cteTables.add(edge.toTable);
      cteJoinClauses.push(
        `  JOIN ${qualify(edge.toTable)} ON ${ident(edge.fromTable)}.${ident(edge.fromColumn)} = ${ident(edge.toTable)}.${ident(edge.toColumn)}`,
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

    const valueColumns: string[] = [];
    let outerExpr: string;
    const measureCol = col(measure);
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
      metricVersions[numerator.name] = numerator.definitionVersion;
      metricVersions[denominator.name] = denominator.definitionVersion;
      if (numerator.config.source) metricSources[numerator.name] = numerator.config.source;
      if (denominator.config.source) metricSources[denominator.name] = denominator.config.source;
      const num = compileScalarMetric(numerator).expr;
      const den = compileScalarMetric(denominator).expr;
      return `${dialect.castNumeric(num)} / NULLIF(${dialect.castNumeric(den)}, 0)`;
    }
    return compileScalarMetric(metric).expr;
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
  const groupBy: string[] = [];

  if (resolved.time?.grain) {
    const alias = timeAlias(resolved.time.grain);
    const expr = trunc(resolved.time.grain, localTime(resolved.time.column));
    selects.push(`${expr} AS ${ident(alias)}`);
    groupBy.push(String(selects.length));
  }
  for (const dimension of resolved.dimensions) {
    selects.push(`${col(dimension.column)} AS ${ident(dimension.name)}`);
    groupBy.push(String(selects.length));
  }
  for (const raw of resolved.rawDimensions) {
    selects.push(`${col(raw.ref)} AS ${ident(raw.alias)}`);
    groupBy.push(String(selects.length));
  }
  selects.push(...metricSelects);
  selects.push(...rawMetricSelects);

  // ---- WHERE ----
  const where: string[] = [];
  if (resolved.time && !skipOuterTime) {
    const expr = localTime(resolved.time.column);
    const from = resolved.time.from;
    const toExclusive = exclusiveEnd(resolved.time.to);
    where.push(`${expr} >= ${dialect.castTimestamp(params.add(from))}`);
    where.push(`${expr} < ${dialect.castTimestamp(params.add(toExclusive))}`);
  }
  for (const filter of resolved.filters) {
    where.push(compileQueryFilter(filter, params, col));
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
  const lines: string[] = [];
  if (ctes.length > 0) {
    lines.push(`WITH ${ctes.join(",\n")}`);
  }
  lines.push(`SELECT ${selects.join(",\n       ")}`);
  lines.push(`FROM ${qualify(baseTable)}`);
  for (const join of joins) {
    lines.push(`JOIN ${qualify(join.table)} ON ${join.on}`);
  }
  lines.push(...cteJoins);
  if (where.length > 0) {
    lines.push(`WHERE ${where.join("\n  AND ")}`);
  }
  if (groupBy.length > 0) {
    lines.push(`GROUP BY ${groupBy.join(", ")}`);
  }
  if (orderClauses.length > 0) {
    lines.push(`ORDER BY ${orderClauses.join(", ")}`);
  }
  lines.push(`LIMIT ${resolved.limit}`);

  return {
    sql: lines.join("\n"),
    params: params.values,
    plan: {
      baseTable,
      joins,
      preAggregations,
      columns: [
        ...(resolved.time?.grain ? [timeAlias(resolved.time.grain)] : []),
        ...resolved.dimensions.map((d) => d.name),
        ...resolved.rawDimensions.map((d) => d.alias),
        ...resolved.metrics.map((m) => m.name),
        ...resolved.rawMetrics.map((m) => m.alias),
      ],
    },
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

function isSemiAdditive(model: SemanticModel, metric: Metric): boolean {
  if (metric.config.additive === "semi") return true;
  if (metric.config.type === "ratio") {
    const numerator = model.metrics.get(metric.config.numerator!);
    const denominator = model.metrics.get(metric.config.denominator!);
    return Boolean(
      (numerator && isSemiAdditive(model, numerator)) || (denominator && isSemiAdditive(model, denominator)),
    );
  }
  return false;
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

/** Civil DATE columns must not be timezone-shifted; last-as-of is a calendar date. */
function isCivilDateColumn(schema: DatabaseSchema | null | undefined, ref: ColumnRef): boolean {
  if (!schema) return false;
  const table = schema.tables.find((item) => item.name === ref.table);
  const column = table?.columns.find((item) => item.name === ref.column);
  if (!column) return false;
  const type = column.dataType.toLowerCase();
  if (type.includes("timestamp") || type.includes("datetime") || type.includes("time")) return false;
  return type === "date" || /\bdate\b/.test(type);
}
