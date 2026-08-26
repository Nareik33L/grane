import type { SemanticModel, Metric } from "../model/model.js";
import type { ResolvedQuery, ResolvedFilter } from "../query/resolve.js";
import { timeAlias } from "../query/resolve.js";
import type { Edge } from "../model/graph.js";
import type { FilterOperator, Scalar, MetricFilterItem } from "../config/schema.js";
import { parseColumnRef, type ColumnRef } from "../model/refs.js";
import { addDays, formatDate } from "../query/time.js";
import { invalidQuery, unsafeQuery } from "../errors.js";
import { getDialect, postgresDialect, type SqlDialect } from "../connectors/dialect.js";
import { compilerNamespace } from "../connectors/create.js";

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

export function compileQuery(model: SemanticModel, resolved: ResolvedQuery): CompiledQuery {
  const dialect = getDialect(model.config.connection.type);
  const schema = compilerNamespace(model.config.connection);
  const timezone = model.config.project.timezone;
  const params = new Params(dialect);
  const baseTable = resolved.baseTable;
  const ident = (name: string) => dialect.ident(name);
  const col = (ref: ColumnRef): string => `${ident(ref.table)}.${ident(ref.column)}`;
  const qualify = (table: string): string => dialect.qualifyTable(schema, table);

  const localTime = (ref: ColumnRef): string => dialect.localizeTime(col(ref), timezone);

  // ---- Join planning for the outer query (dimensions, filters, time, direct measures) ----
  const joinedTables = new Set<string>([baseTable]);
  const joins: JoinStep[] = [];

  const joinPathTo = (targetTable: string, purpose: string): void => {
    if (joinedTables.has(targetTable)) return;
    const path = model.graph.findPath(baseTable, targetTable);
    if (!path) {
      throw invalidQuery(`No relationship path from "${baseTable}" to "${targetTable}" (${purpose}).`);
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

    if (!path.fansOut) {
      // Measure is on the base table or safely reachable: aggregate directly.
      joinPathTo(measure.table, `measure of metric "${metric.name}"`);
      const filterClause = compileMetricFilters(metric.filters, params, col);
      const fn = aggregateFn(metric);
      return {
        expr: filterClause
          ? dialect.filteredAggregate(fn, col(measure), filterClause)
          : directAggregate(metric, col(measure)),
      };
    }

    // Fan-out path: deterministic pre-aggregation at the metric grain.
    return compilePreAggregatedMetric(metric, path.edges);
  };

  const compilePreAggregatedMetric = (metric: Metric, edges: Edge[]): MetricExpr => {
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
        `Metric "${metric.name}" measures "${measure.table}" via an indirect fan-out path; currently supports pre-aggregation only for direct children of the metric's entity table ("${baseTable}").`,
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

    const outerFilterClause = compileMetricFilters(outerFilters, params, col);
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
    const expr = dialect.dateTrunc(resolved.time.grain, localTime(resolved.time.column));
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
  if (resolved.time) {
    const expr = localTime(resolved.time.column);
    const from = resolved.time.from;
    const toExclusive = formatDate(
      addDays(
        {
          year: Number(resolved.time.to.slice(0, 4)),
          month: Number(resolved.time.to.slice(5, 7)),
          day: Number(resolved.time.to.slice(8, 10)),
        },
        1,
      ),
    );
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
