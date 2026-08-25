import type { SemanticModel, Metric } from "../model/model.js";
import type { ResolvedQuery, ResolvedFilter } from "../query/resolve.js";
import { timeAlias } from "../query/resolve.js";
import type { Edge } from "../model/graph.js";
import type { FilterOperator, Scalar, MetricFilterItem } from "../config/schema.js";
import { parseColumnRef, type ColumnRef } from "../model/refs.js";
import { addDays, formatDate } from "../query/time.js";
import { invalidQuery, unsafeQuery } from "../errors.js";

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
}

class Params {
  readonly values: Scalar[] = [];
  add(value: Scalar): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteralString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function col(ref: ColumnRef): string {
  return `${quoteIdent(ref.table)}.${quoteIdent(ref.column)}`;
}

export function compileQuery(model: SemanticModel, resolved: ResolvedQuery): CompiledQuery {
  const schema = model.config.connection.schema;
  const timezone = model.config.project.timezone;
  const params = new Params();
  const baseTable = resolved.baseTable;

  const qualify = (table: string): string => `${quoteIdent(schema)}.${quoteIdent(table)}`;

  /**
   * Timestamp expression localized to the project timezone. The executor pins
   * the session timezone to UTC, so this is deterministic for both timestamp
   * and timestamptz columns.
   */
  const localTime = (ref: ColumnRef): string => {
    if (!timezone || timezone === "UTC") return col(ref);
    return `(${col(ref)}::timestamptz AT TIME ZONE ${quoteLiteralString(timezone)})`;
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
      on: `${quoteIdent(edge.fromTable)}.${quoteIdent(edge.fromColumn)} = ${quoteIdent(edge.toTable)}.${quoteIdent(edge.toColumn)}`,
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
      const filterClause = compileMetricFilters(metric.filters, params);
      const agg = directAggregate(metric, col(measure));
      return { expr: filterClause ? `${agg} FILTER (WHERE ${filterClause})` : agg };
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
    const keyExpr = `${quoteIdent(firstEdge.toTable)}.${quoteIdent(firstEdge.toColumn)}`;
    const baseKeyExpr = `${quoteIdent(firstEdge.fromTable)}.${quoteIdent(firstEdge.fromColumn)}`;
    if (firstEdge.fromTable !== baseTable) {
      // Multi-hop before the fan-out would need intermediate joins from base;
      // out of scope for V0.1's deterministic guarantees.
      throw unsafeQuery(
        `Metric "${metric.name}" measures "${measure.table}" via an indirect fan-out path; V0.1 supports pre-aggregation only for direct children of the metric's entity table ("${baseTable}").`,
      );
    }

    const cteJoinClauses: string[] = [];
    const cteTables = new Set<string>([firstEdge.toTable]);
    for (const edge of edges.slice(1)) {
      if (cteTables.has(edge.toTable)) continue;
      cteTables.add(edge.toTable);
      cteJoinClauses.push(
        `  JOIN ${qualify(edge.toTable)} ON ${quoteIdent(edge.fromTable)}.${quoteIdent(edge.fromColumn)} = ${quoteIdent(edge.toTable)}.${quoteIdent(edge.toColumn)}`,
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
    const insideWhere = compileMetricFilters(insideFilters, params);

    const valueColumns: string[] = [];
    let outerExpr: string;
    const measureCol = col(measure);
    switch (metric.config.type) {
      case "sum":
        valueColumns.push(`SUM(${measureCol}) AS value`);
        outerExpr = `SUM(${cteName}.value)`;
        break;
      case "count":
        valueColumns.push(`COUNT(${measureCol}) AS value`);
        outerExpr = `COALESCE(SUM(${cteName}.value), 0)`;
        break;
      case "min":
        valueColumns.push(`MIN(${measureCol}) AS value`);
        outerExpr = `MIN(${cteName}.value)`;
        break;
      case "max":
        valueColumns.push(`MAX(${measureCol}) AS value`);
        outerExpr = `MAX(${cteName}.value)`;
        break;
      case "avg":
        valueColumns.push(`SUM(${measureCol}) AS value_sum`, `COUNT(${measureCol}) AS value_count`);
        outerExpr = `SUM(${cteName}.value_sum) / NULLIF(SUM(${cteName}.value_count), 0)`;
        break;
      default:
        throw unsafeQuery(`Unsupported pre-aggregated metric type "${metric.config.type}".`);
    }

    const cteSql = [
      `${quoteIdent(cteName)} AS (`,
      `  SELECT ${keyExpr} AS _key, ${valueColumns.join(", ")}`,
      `  FROM ${qualify(firstEdge.toTable)}`,
      ...cteJoinClauses,
      ...(insideWhere ? [`  WHERE ${insideWhere}`] : []),
      `  GROUP BY ${keyExpr}`,
      `)`,
    ].join("\n");
    ctes.push(cteSql);
    cteJoins.push(
      `LEFT JOIN ${quoteIdent(cteName)} ON ${quoteIdent(cteName)}._key = ${baseKeyExpr}`,
    );
    preAggregations.push({
      metric: metric.name,
      cte: cteName,
      measureTable: measure.table,
      keyColumn: `${firstEdge.toTable}.${firstEdge.toColumn}`,
    });

    const outerFilterClause = compileMetricFilters(outerFilters, params);
    // FILTER applies cleanly to a plain aggregate; for composed expressions
    // (avg, coalesced count) fall back to CASE inside the aggregate arguments.
    if (outerFilterClause) {
      if (metric.config.type === "avg") {
        outerExpr =
          `SUM(CASE WHEN ${outerFilterClause} THEN ${cteName}.value_sum END) / ` +
          `NULLIF(SUM(CASE WHEN ${outerFilterClause} THEN ${cteName}.value_count END), 0)`;
      } else if (metric.config.type === "count") {
        outerExpr = `COALESCE(SUM(${cteName}.value) FILTER (WHERE ${outerFilterClause}), 0)`;
      } else {
        outerExpr = `${outerExpr} FILTER (WHERE ${outerFilterClause})`;
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
      return `(${num})::numeric / NULLIF((${den})::numeric, 0)`;
    }
    return compileScalarMetric(metric).expr;
  };

  // Pre-plan joins for dimensions/filters/time before metric CTE joins so the
  // outer FROM clause reads naturally (plain joins first, then CTE joins).
  for (const dimension of resolved.dimensions) {
    joinPathTo(dimension.column.table, `dimension "${dimension.name}"`);
  }
  for (const filter of resolved.filters) {
    joinPathTo(filter.dimension.column.table, `filter on "${filter.dimension.name}"`);
  }
  if (resolved.time) {
    joinPathTo(resolved.time.column.table, "time range");
  }

  const metricSelects = resolved.metrics.map(
    (metric) => `${compileMetricExpr(metric)} AS ${quoteIdent(metric.name)}`,
  );

  // ---- SELECT list and GROUP BY ----
  const selects: string[] = [];
  const groupBy: string[] = [];

  if (resolved.time?.grain) {
    const alias = timeAlias(resolved.time.grain);
    const expr = `date_trunc(${quoteLiteralString(resolved.time.grain)}, ${localTime(resolved.time.column)})`;
    selects.push(`${expr} AS ${quoteIdent(alias)}`);
    groupBy.push(String(selects.length));
  }
  for (const dimension of resolved.dimensions) {
    selects.push(`${col(dimension.column)} AS ${quoteIdent(dimension.name)}`);
    groupBy.push(String(selects.length));
  }
  selects.push(...metricSelects);

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
    where.push(`${expr} >= ${params.add(from)}::timestamp`);
    where.push(`${expr} < ${params.add(toExclusive)}::timestamp`);
  }
  for (const filter of resolved.filters) {
    where.push(compileQueryFilter(filter, params));
  }

  // ---- ORDER BY ----
  const orderClauses: string[] = [];
  for (const order of resolved.order) {
    orderClauses.push(`${quoteIdent(order.field)} ${order.direction === "desc" ? "DESC" : "ASC"}`);
  }
  if (orderClauses.length === 0) {
    if (resolved.time?.grain) {
      orderClauses.push(`${quoteIdent(timeAlias(resolved.time.grain))} ASC`);
    } else if (resolved.dimensions.length > 0 && resolved.metrics.length > 0) {
      orderClauses.push(`${quoteIdent(resolved.metrics[0]!.name)} DESC`);
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
        ...resolved.metrics.map((m) => m.name),
      ],
    },
    metricVersions,
  };
}

function directAggregate(metric: Metric, measureExpr: string): string {
  switch (metric.config.type) {
    case "sum":
      return `SUM(${measureExpr})`;
    case "count":
      return `COUNT(${measureExpr})`;
    case "count_distinct":
      return `COUNT(DISTINCT ${measureExpr})`;
    case "avg":
      return `AVG(${measureExpr})`;
    case "min":
      return `MIN(${measureExpr})`;
    case "max":
      return `MAX(${measureExpr})`;
    default:
      throw invalidQuery(`Unsupported metric type "${metric.config.type}".`);
  }
}

function compileMetricFilters(filters: MetricFilterItem[], params: Params): string | null {
  if (filters.length === 0) return null;
  const clauses = filters.map((filter) => {
    const ref = parseColumnRef(filter.field);
    if (!ref) {
      throw invalidQuery(`Metric filter field "${filter.field}" is not a table.column reference.`);
    }
    return compileOperator(col(ref), filter.operator, filter.value, params);
  });
  return clauses.join(" AND ");
}

function compileQueryFilter(filter: ResolvedFilter, params: Params): string {
  return compileOperator(col(filter.dimension.column), filter.operator, filter.value, params);
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
      return `${columnExpr} ILIKE '%' || ${params.add(value as Scalar)} || '%'`;
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
