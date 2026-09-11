import type { WarehouseType } from "../../src/config/schema.js";
import { CERT_TABLES, SEED, type CertColumn, type CertColumnType } from "./data.js";

type Dialect = WarehouseType;

function quoteIdent(dialect: Dialect, name: string): string {
  if (
    dialect === "mysql" ||
    dialect === "clickhouse" ||
    dialect === "bigquery" ||
    dialect === "databricks"
  ) {
    return `\`${name.replace(/`/g, "``")}\``;
  }
  return `"${name.replace(/"/g, '""')}"`;
}

export const SQL_TYPE: Record<Dialect, Record<CertColumnType, string>> = {
  postgres: {
    integer: "INTEGER",
    bigint: "BIGINT",
    text: "TEXT",
    numeric: "NUMERIC(18, 2)",
    date: "DATE",
    timestamp_naive: "TIMESTAMP",
    timestamptz: "TIMESTAMPTZ",
    boolean: "BOOLEAN",
  },
  duckdb: {
    integer: "INTEGER",
    bigint: "BIGINT",
    text: "VARCHAR",
    numeric: "DECIMAL(18, 2)",
    date: "DATE",
    timestamp_naive: "TIMESTAMP",
    timestamptz: "TIMESTAMPTZ",
    boolean: "BOOLEAN",
  },
  mysql: {
    integer: "INT",
    bigint: "BIGINT",
    text: "VARCHAR(255)",
    numeric: "DECIMAL(18, 2)",
    date: "DATE",
    timestamp_naive: "DATETIME",
    timestamptz: "TIMESTAMP",
    boolean: "BOOLEAN",
  },
  clickhouse: {
    integer: "Int32",
    bigint: "Int64",
    text: "String",
    numeric: "Decimal(18, 2)",
    date: "Date",
    timestamp_naive: "DateTime",
    timestamptz: "DateTime64(6, 'UTC')",
    boolean: "Bool",
  },
  snowflake: {
    integer: "INTEGER",
    bigint: "BIGINT",
    text: "VARCHAR",
    numeric: "NUMBER(18, 2)",
    date: "DATE",
    timestamp_naive: "TIMESTAMP_NTZ",
    timestamptz: "TIMESTAMP_TZ",
    boolean: "BOOLEAN",
  },
  bigquery: {
    integer: "INT64",
    bigint: "INT64",
    text: "STRING",
    numeric: "NUMERIC",
    date: "DATE",
    timestamp_naive: "DATETIME",
    timestamptz: "TIMESTAMP",
    boolean: "BOOL",
  },
  redshift: {
    integer: "INTEGER",
    bigint: "BIGINT",
    text: "VARCHAR(65535)",
    numeric: "NUMERIC(18, 2)",
    date: "DATE",
    timestamp_naive: "TIMESTAMP",
    timestamptz: "TIMESTAMPTZ",
    boolean: "BOOLEAN",
  },
  databricks: {
    integer: "INT",
    bigint: "BIGINT",
    text: "STRING",
    numeric: "DECIMAL(18, 2)",
    date: "DATE",
    timestamp_naive: "TIMESTAMP_NTZ",
    timestamptz: "TIMESTAMP",
    boolean: "BOOLEAN",
  },
};

function columnSql(dialect: Dialect, col: CertColumn): string {
  const ty = SQL_TYPE[dialect][col.type];
  if (dialect === "clickhouse") {
    return `${quoteIdent(dialect, col.name)} Nullable(${ty})`;
  }
  return `${quoteIdent(dialect, col.name)} ${ty}`;
}

function escapeString(dialect: Dialect, value: string): string {
  let s = value;
  // MySQL / ClickHouse C-escape string literals: `\B` is stored as `B` unless doubled.
  if (dialect === "mysql" || dialect === "clickhouse") s = s.replaceAll("\\", "\\\\");
  return `'${s.replaceAll("'", "''")}'`;
}

function wallClock(iso: string): string {
  return iso.replace("T", " ").replace(/Z$/, "").replace(/\+00:00$/, "");
}

function literal(dialect: Dialect, col: CertColumn, value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  switch (col.type) {
    case "integer":
    case "bigint":
      return typeof value === "bigint" ? value.toString() : String(value);
    case "numeric":
      return String(value);
    case "boolean":
      if (dialect === "mysql") return value ? "1" : "0";
      return value ? "TRUE" : "FALSE";
    case "text":
      return escapeString(dialect, String(value));
    case "date":
      if (dialect === "clickhouse") return `toDate('${String(value)}')`;
      return `DATE '${String(value)}'`;
    case "timestamp_naive":
      if (dialect === "mysql") return `'${wallClock(String(value))}'`;
      if (dialect === "clickhouse") return `parseDateTimeBestEffort('${wallClock(String(value))}')`;
      if (dialect === "bigquery") return `DATETIME '${wallClock(String(value))}'`;
      if (dialect === "databricks") return `TIMESTAMP_NTZ '${wallClock(String(value))}'`;
      if (dialect === "snowflake") return `TIMESTAMP_NTZ '${wallClock(String(value))}'`;
      return `TIMESTAMP '${wallClock(String(value))}'`;
    case "timestamptz": {
      const clock = wallClock(String(value));
      if (dialect === "postgres" || dialect === "duckdb" || dialect === "redshift") {
        return `'${clock}+00'`;
      }
      if (dialect === "mysql") return `'${clock}'`;
      if (dialect === "clickhouse") return `toDateTime64('${clock}', 6, 'UTC')`;
      if (dialect === "bigquery") return `TIMESTAMP '${clock}+00'`;
      if (dialect === "snowflake") return `'${clock}+00'`;
      return `'${clock}+00'`;
    }
    default:
      return escapeString(dialect, String(value));
  }
}

function createTable(dialect: Dialect, table: (typeof CERT_TABLES)[number]): string {
  const cols = table.columns.map((c) => `  ${columnSql(dialect, c)}`).join(",\n");
  const name = quoteIdent(dialect, table.name);
  if (dialect === "clickhouse") {
    return `CREATE TABLE ${name} (\n${cols}\n) ENGINE = MergeTree ORDER BY tuple()`;
  }
  return `CREATE TABLE ${name} (\n${cols}\n)`;
}

function insertRows(
  dialect: Dialect,
  table: (typeof CERT_TABLES)[number],
  rows: Record<string, unknown>[],
): string[] {
  if (rows.length === 0) return [];
  const cols = table.columns.map((c) => quoteIdent(dialect, c.name)).join(", ");
  return rows.map((row) => {
    const values = table.columns.map((c) => literal(dialect, c, row[c.name])).join(", ");
    return `INSERT INTO ${quoteIdent(dialect, table.name)} (${cols}) VALUES (${values})`;
  });
}

/**
 * Dialect-specific CREATE + INSERT statements for the shared certification corpus.
 * Table names are unqualified; Postgres live setup sets `search_path`.
 */
export function ddl(dialect: Dialect): string[] {
  const statements: string[] = [];
  for (const table of CERT_TABLES) {
    statements.push(createTable(dialect, table));
    const rows = SEED[table.name] as Record<string, unknown>[];
    statements.push(...insertRows(dialect, table, rows ?? []));
  }
  return statements;
}

export const PG_CERT_DDL: string[] = ddl("postgres");

export { quoteIdent };
