import type { Scalar, WeekStarts } from "../config/schema.js";

export type WarehouseType =
  | "postgres"
  | "mysql"
  | "snowflake"
  | "bigquery"
  | "duckdb"
  | "clickhouse"
  | "redshift"
  | "databricks";

export const WAREHOUSE_TYPES: WarehouseType[] = [
  "postgres",
  "mysql",
  "snowflake",
  "bigquery",
  "duckdb",
  "clickhouse",
  "redshift",
  "databricks",
];

export interface SqlDialect {
  readonly type: WarehouseType;
  /** Whether FILTER (WHERE ...) on aggregates is supported. */
  readonly supportsFilterClause: boolean;
  ident(name: string): string;
  /** Qualify a table with the configured schema/dataset/database, if any. */
  qualifyTable(schema: string | undefined, table: string): string;
  placeholder(index: number, value: Scalar): string;
  /**
   * Truncate a (already localized, or civil DATE) time expression.
   * `weekStarts` is required for grain `week`; ignored for other grains.
   */
  dateTrunc(grain: string, expr: string, kind?: TemporalKind, weekStarts?: WeekStarts): string;
  localizeTime(expr: string, timezone: string): string;
  castTimestamp(placeholder: string): string;
  /** Bind a civil YYYY-MM-DD as a DATE, never as a timestamp. */
  castDate(placeholder: string): string;
  castNumeric(expr: string): string;
  contains(columnExpr: string, placeholder: string): string;
  filteredAggregate(fn: "SUM" | "COUNT" | "AVG" | "MIN" | "MAX", expr: string, filterSql: string): string;
}

function quoteDouble(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteBacktick(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

function lit(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function asDate(expr: string, kind?: TemporalKind): string {
  return kind === "date" ? expr : `CAST(${expr} AS DATE)`;
}

/**
 * Civil week-start DATE. EXTRACT(DOW) is Sunday=0 on Postgres, DuckDB, and
 * Redshift and is not a session setting. Used instead of date_trunc('week')
 * so sunday/monday cannot collapse to the warehouse default.
 */
function ansiCivilWeekStart(expr: string, kind: TemporalKind | undefined, starts: WeekStarts = "monday"): string {
  const d = asDate(expr, kind);
  const offset =
    starts === "sunday"
      ? `EXTRACT(DOW FROM ${d})::integer`
      : `((EXTRACT(DOW FROM ${d})::integer + 6) % 7)`;
  return `(${d} - ${offset})`;
}

/**
 * LIKE / ILIKE escape character. Chosen as `!` so the ESCAPE clause is a
 * single-quoted ASCII literal on every dialect (backslash string escapes
 * differ between Postgres, MySQL, and BigQuery).
 */
export const LIKE_ESCAPE_CHAR = "!";

/**
 * Escape a user string so it is a literal LIKE pattern under
 * {@link LIKE_ESCAPE_CHAR}. `%`, `_`, and the escape character itself lose
 * metacharacter meaning. Used by tests; SQL generation applies the same
 * replacements to the bound placeholder so the parameter stays the raw
 * user value.
 */
export function escapeLikeLiteral(value: string): string {
  const e = LIKE_ESCAPE_CHAR;
  return value.replaceAll(e, e + e).replaceAll("%", `${e}%`).replaceAll("_", `${e}_`);
}

/** SQL expression that escapes LIKE metacharacters in `expr` (a placeholder). */
function escapeLikeExpr(expr: string, replaceFn = "replace"): string {
  const e = lit(LIKE_ESCAPE_CHAR);
  const ee = lit(LIKE_ESCAPE_CHAR + LIKE_ESCAPE_CHAR);
  return `${replaceFn}(${replaceFn}(${replaceFn}(${expr}, ${e}, ${ee}), ${lit("%")}, ${lit(`${LIKE_ESCAPE_CHAR}%`)}), ${lit("_")}, ${lit(`${LIKE_ESCAPE_CHAR}_`)})`;
}

function likeContains(
  columnExpr: string,
  patternExpr: string,
  concat: "pipe" | "concat",
  predicate: "ilike" | "like",
): string {
  const wrapped =
    concat === "pipe"
      ? `'%' || ${patternExpr} || '%'`
      : `CONCAT('%', ${patternExpr}, '%')`;
  return `${columnExpr} ${predicate === "ilike" ? "ILIKE" : "LIKE"} ${wrapped} ESCAPE ${lit(LIKE_ESCAPE_CHAR)}`;
}

function filteredWithCase(
  fn: "SUM" | "COUNT" | "AVG" | "MIN" | "MAX",
  expr: string,
  filterSql: string,
): string {
  return `${fn}(CASE WHEN ${filterSql} THEN ${expr} END)`;
}

function filteredWithFilter(
  fn: "SUM" | "COUNT" | "AVG" | "MIN" | "MAX",
  expr: string,
  filterSql: string,
): string {
  return `${fn}(${expr}) FILTER (WHERE ${filterSql})`;
}

const ansiPostgresLike: Omit<SqlDialect, "type"> = {
  supportsFilterClause: true,
  ident: quoteDouble,
  qualifyTable(schema, table) {
    return schema ? `${quoteDouble(schema)}.${quoteDouble(table)}` : quoteDouble(table);
  },
  placeholder(index) {
    return `$${index}`;
  },
  dateTrunc(grain, expr, kind, weekStarts) {
    if (grain === "week") return ansiCivilWeekStart(expr, kind, weekStarts ?? "monday");
    return `date_trunc(${lit(grain)}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `(${expr}::timestamptz AT TIME ZONE ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `${placeholder}::timestamp`;
  },
  castDate(placeholder) {
    return `${placeholder}::date`;
  },
  castNumeric(expr) {
    return `(${expr})::numeric`;
  },
  contains(columnExpr, placeholder) {
    return likeContains(columnExpr, escapeLikeExpr(placeholder), "pipe", "ilike");
  },
  filteredAggregate: filteredWithFilter,
};

export const postgresDialect: SqlDialect = { type: "postgres", ...ansiPostgresLike };

export const redshiftDialect: SqlDialect = {
  type: "redshift",
  ...ansiPostgresLike,
  supportsFilterClause: false,
  filteredAggregate: filteredWithCase,
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `CONVERT_TIMEZONE(${lit("UTC")}, ${lit(timezone)}, ${expr})`;
  },
};

export const duckdbDialect: SqlDialect = {
  type: "duckdb",
  ...ansiPostgresLike,
  qualifyTable(schema, table) {
    return schema && schema !== "main" ? `${quoteDouble(schema)}.${quoteDouble(table)}` : quoteDouble(table);
  },
};

export const mysqlDialect: SqlDialect = {
  type: "mysql",
  supportsFilterClause: false,
  ident: quoteBacktick,
  qualifyTable(schema, table) {
    return schema ? `${quoteBacktick(schema)}.${quoteBacktick(table)}` : quoteBacktick(table);
  },
  placeholder() {
    return "?";
  },
  dateTrunc(grain, expr, _kind, weekStarts) {
    switch (grain) {
      case "day":
        return `DATE(${expr})`;
      case "week":
        return (weekStarts ?? "monday") === "sunday"
          ? `DATE_SUB(DATE(${expr}), INTERVAL (DAYOFWEEK(${expr}) - 1) DAY)`
          : `DATE_SUB(DATE(${expr}), INTERVAL WEEKDAY(${expr}) DAY)`;
      case "month":
        return `DATE_FORMAT(${expr}, '%Y-%m-01')`;
      case "quarter":
        return `MAKEDATE(YEAR(${expr}), 1) + INTERVAL (QUARTER(${expr}) - 1) QUARTER`;
      case "year":
        return `MAKEDATE(YEAR(${expr}), 1)`;
      default:
        return `DATE(${expr})`;
    }
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `CONVERT_TZ(${expr}, 'UTC', ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `CAST(${placeholder} AS DATETIME)`;
  },
  castDate(placeholder) {
    return `CAST(${placeholder} AS DATE)`;
  },
  castNumeric(expr) {
    return `CAST((${expr}) AS DECIMAL(38, 12))`;
  },
  contains(columnExpr, placeholder) {
    return likeContains(
      `LOWER(${columnExpr})`,
      escapeLikeExpr(`LOWER(${placeholder})`),
      "concat",
      "like",
    );
  },
  filteredAggregate: filteredWithCase,
};

export const snowflakeDialect: SqlDialect = {
  type: "snowflake",
  supportsFilterClause: true,
  ident: quoteDouble,
  qualifyTable(schema, table) {
    return schema ? `${quoteDouble(schema)}.${quoteDouble(table)}` : quoteDouble(table);
  },
  placeholder() {
    return "?";
  },
  dateTrunc(grain, expr, kind, weekStarts) {
    if (grain === "week") {
      const d = asDate(expr, kind);
      return (weekStarts ?? "monday") === "sunday"
        ? `DATEADD('day', -MOD(DAYOFWEEKISO(${d}), 7), ${d})`
        : `DATEADD('day', 1 - DAYOFWEEKISO(${d}), ${d})`;
    }
    return `DATE_TRUNC(${lit(grain.toUpperCase())}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `CONVERT_TIMEZONE(${lit("UTC")}, ${lit(timezone)}, ${expr})`;
  },
  castTimestamp(placeholder) {
    return `TO_TIMESTAMP(${placeholder})`;
  },
  castDate(placeholder) {
    return `TO_DATE(${placeholder})`;
  },
  castNumeric(expr) {
    return `TO_NUMBER(${expr})`;
  },
  contains(columnExpr, placeholder) {
    return likeContains(columnExpr, escapeLikeExpr(placeholder), "pipe", "ilike");
  },
  filteredAggregate: filteredWithFilter,
};

export const bigqueryDialect: SqlDialect = {
  type: "bigquery",
  supportsFilterClause: false,
  ident: quoteBacktick,
  qualifyTable(schema, table) {
    if (!schema) return quoteBacktick(table);
    const parts = schema.split(".").filter(Boolean);
    return [...parts.map(quoteBacktick), quoteBacktick(table)].join(".");
  },
  placeholder(index) {
    return `@p${index}`;
  },
  dateTrunc(grain, expr, kind, weekStarts) {
    if (grain === "week") {
      const week = (weekStarts ?? "monday") === "sunday" ? "WEEK(SUNDAY)" : "WEEK(MONDAY)";
      if (kind === "date") return `DATE_TRUNC(${expr}, ${week})`;
      return `TIMESTAMP_TRUNC(${expr}, ${week})`;
    }
    const g = grain.toUpperCase();
    if (kind === "date") return `DATE_TRUNC(${expr}, ${g})`;
    return `TIMESTAMP_TRUNC(${expr}, ${g})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `DATETIME(${expr}, ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `TIMESTAMP(${placeholder})`;
  },
  castDate(placeholder) {
    return `DATE(${placeholder})`;
  },
  castNumeric(expr) {
    return `CAST((${expr}) AS NUMERIC)`;
  },
  contains(columnExpr, placeholder) {
    return likeContains(
      `LOWER(CAST(${columnExpr} AS STRING))`,
      escapeLikeExpr(`LOWER(${placeholder})`),
      "concat",
      "like",
    );
  },
  filteredAggregate: filteredWithCase,
};

export const databricksDialect: SqlDialect = {
  type: "databricks",
  supportsFilterClause: true,
  ident: quoteBacktick,
  qualifyTable(schema, table) {
    if (!schema) return quoteBacktick(table);
    const parts = schema.split(".").filter(Boolean);
    return [...parts.map(quoteBacktick), quoteBacktick(table)].join(".");
  },
  placeholder() {
    return "?";
  },
  dateTrunc(grain, expr, kind, weekStarts) {
    if (grain === "week") {
      const d = asDate(expr, kind);
      return (weekStarts ?? "monday") === "sunday"
        ? `date_sub(${d}, dayofweek(${d}) - 1)`
        : `date_sub(${d}, (dayofweek(${d}) + 5) % 7)`;
    }
    return `DATE_TRUNC(${lit(grain.toUpperCase())}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `from_utc_timestamp(${expr}, ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `CAST(${placeholder} AS TIMESTAMP)`;
  },
  castDate(placeholder) {
    return `CAST(${placeholder} AS DATE)`;
  },
  castNumeric(expr) {
    return `CAST((${expr}) AS DOUBLE)`;
  },
  contains(columnExpr, placeholder) {
    return likeContains(
      `LOWER(CAST(${columnExpr} AS STRING))`,
      escapeLikeExpr(`LOWER(${placeholder})`),
      "concat",
      "like",
    );
  },
  filteredAggregate: filteredWithFilter,
};

export const clickhouseDialect: SqlDialect = {
  type: "clickhouse",
  supportsFilterClause: false,
  ident: quoteBacktick,
  qualifyTable(schema, table) {
    return schema ? `${quoteBacktick(schema)}.${quoteBacktick(table)}` : quoteBacktick(table);
  },
  placeholder(index, value) {
    const chType =
      typeof value === "number"
        ? Number.isInteger(value)
          ? "Int64"
          : "Float64"
        : typeof value === "boolean"
          ? "UInt8"
          : "String";
    return `{p${index}:${chType}}`;
  },
  dateTrunc(grain, expr, _kind, weekStarts) {
    switch (grain) {
      case "day":
        return `toStartOfDay(${expr})`;
      case "week":
        return `toStartOfWeek(${expr}, ${(weekStarts ?? "monday") === "sunday" ? 0 : 1})`;
      case "month":
        return `toStartOfMonth(${expr})`;
      case "quarter":
        return `toStartOfQuarter(${expr})`;
      case "year":
        return `toStartOfYear(${expr})`;
      default:
        return `toStartOfDay(${expr})`;
    }
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `toTimeZone(${expr}, ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `parseDateTimeBestEffort(${placeholder})`;
  },
  castDate(placeholder) {
    return `toDate(${placeholder})`;
  },
  castNumeric(expr) {
    return `toFloat64(${expr})`;
  },
  contains(columnExpr, placeholder) {
    return `${columnExpr} ILIKE concat('%', ${escapeLikeExpr(placeholder, "replaceAll")}, '%') ESCAPE ${lit(LIKE_ESCAPE_CHAR)}`;
  },
  filteredAggregate: filteredWithCase,
};

export function getDialect(type: WarehouseType): SqlDialect {
  switch (type) {
    case "postgres":
      return postgresDialect;
    case "mysql":
      return mysqlDialect;
    case "snowflake":
      return snowflakeDialect;
    case "bigquery":
      return bigqueryDialect;
    case "duckdb":
      return duckdbDialect;
    case "clickhouse":
      return clickhouseDialect;
    case "redshift":
      return redshiftDialect;
    case "databricks":
      return databricksDialect;
  }
}

export function isNumericType(dataType: string): boolean {
  return /int|numeric|decimal|number|float|double|real|money|bignumeric|uint|int64|float64/i.test(
    dataType,
  );
}

export function isTemporalType(dataType: string): boolean {
  return /timestamp|timestamptz|datetime|date|time/i.test(dataType);
}

/**
 * Warehouse temporal kinds compilation can distinguish.
 *
 *   date               civil calendar value (DATE / Date32). Project timezone
 *                      must not shift it to another civil date.
 *   timestamp_naive    timestamp without time zone / DATETIME. Treated as a
 *                      UTC wall-clock instant once the session timezone is
 *                      pinned to UTC, then localized to project.timezone.
 *   timestamp_instant  timestamptz / TIMESTAMP WITH TIME ZONE / BigQuery
 *                      TIMESTAMP. An instant; localized to project.timezone.
 *   unknown            not a recognised date/timestamp type (or missing).
 */
export type TemporalKind = "date" | "timestamp_naive" | "timestamp_instant" | "unknown";

/**
 * Classify a warehouse column type. More specific forms (timestamptz,
 * datetime) are matched before the civil DATE token so `datetime` is never
 * treated as a date. `TIMESTAMP` without a zone qualifier is an instant on
 * BigQuery and a naive timestamp elsewhere — that is warehouse type-system
 * knowledge, not a column-name heuristic.
 */
export function classifyTemporalType(
  dataType: string | null | undefined,
  warehouse?: WarehouseType,
): TemporalKind {
  if (!dataType) return "unknown";
  const t = dataType
    .trim()
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return "unknown";

  if (
    t.includes("with time zone") ||
    t.includes("with timezone") ||
    t.includes("timestamptz") ||
    t.includes("timestamp tz") ||
    t.includes("timestamp ltz")
  ) {
    return "timestamp_instant";
  }

  if (t.includes("timestamp") || t.includes("datetime")) {
    return warehouse === "bigquery" && !t.includes("datetime") ? "timestamp_instant" : "timestamp_naive";
  }

  if (t === "date" || t === "date32" || /(^|\s)date(\s|$)/.test(t)) {
    return "date";
  }

  return "unknown";
}
