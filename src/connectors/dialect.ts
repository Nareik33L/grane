import type { Scalar } from "../config/schema.js";

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
  dateTrunc(grain: string, expr: string): string;
  localizeTime(expr: string, timezone: string): string;
  castTimestamp(placeholder: string): string;
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
  dateTrunc(grain, expr) {
    return `date_trunc(${lit(grain)}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `(${expr}::timestamptz AT TIME ZONE ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `${placeholder}::timestamp`;
  },
  castNumeric(expr) {
    return `(${expr})::numeric`;
  },
  contains(columnExpr, placeholder) {
    return `${columnExpr} ILIKE '%' || ${placeholder} || '%'`;
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
  dateTrunc(grain, expr) {
    switch (grain) {
      case "day":
        return `DATE(${expr})`;
      case "week":
        return `DATE_SUB(DATE(${expr}), INTERVAL WEEKDAY(${expr}) DAY)`;
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
  castNumeric(expr) {
    return `CAST((${expr}) AS DECIMAL(38, 12))`;
  },
  contains(columnExpr, placeholder) {
    return `LOWER(${columnExpr}) LIKE CONCAT('%', LOWER(${placeholder}), '%')`;
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
  dateTrunc(grain, expr) {
    return `DATE_TRUNC(${lit(grain.toUpperCase())}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `CONVERT_TIMEZONE(${lit("UTC")}, ${lit(timezone)}, ${expr})`;
  },
  castTimestamp(placeholder) {
    return `TO_TIMESTAMP(${placeholder})`;
  },
  castNumeric(expr) {
    return `TO_NUMBER(${expr})`;
  },
  contains(columnExpr, placeholder) {
    return `${columnExpr} ILIKE '%' || ${placeholder} || '%'`;
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
  dateTrunc(grain, expr) {
    const g = grain.toUpperCase();
    return `TIMESTAMP_TRUNC(${expr}, ${g})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `DATETIME(${expr}, ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `TIMESTAMP(${placeholder})`;
  },
  castNumeric(expr) {
    return `CAST((${expr}) AS NUMERIC)`;
  },
  contains(columnExpr, placeholder) {
    return `LOWER(CAST(${columnExpr} AS STRING)) LIKE CONCAT('%', LOWER(${placeholder}), '%')`;
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
  dateTrunc(grain, expr) {
    return `DATE_TRUNC(${lit(grain.toUpperCase())}, ${expr})`;
  },
  localizeTime(expr, timezone) {
    if (!timezone || timezone === "UTC") return expr;
    return `from_utc_timestamp(${expr}, ${lit(timezone)})`;
  },
  castTimestamp(placeholder) {
    return `CAST(${placeholder} AS TIMESTAMP)`;
  },
  castNumeric(expr) {
    return `CAST((${expr}) AS DOUBLE)`;
  },
  contains(columnExpr, placeholder) {
    return `LOWER(CAST(${columnExpr} AS STRING)) LIKE CONCAT('%', LOWER(${placeholder}), '%')`;
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
  dateTrunc(grain, expr) {
    switch (grain) {
      case "day":
        return `toStartOfDay(${expr})`;
      case "week":
        return `toStartOfWeek(${expr}, 1)`;
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
  castNumeric(expr) {
    return `toFloat64(${expr})`;
  },
  contains(columnExpr, placeholder) {
    return `${columnExpr} ILIKE concat('%', ${placeholder}, '%')`;
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
