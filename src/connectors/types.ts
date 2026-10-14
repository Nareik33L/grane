import type { Scalar, LimitsConfig } from "../config/schema.js";
import type { SqlDialect, WarehouseType } from "./dialect.js";

export interface ColumnInfo {
  name: string;
  dataType: string;
  nullable: boolean;
}

export interface TableInfo {
  schema: string;
  name: string;
  columns: ColumnInfo[];
  /**
   * Single-column warehouse PRIMARY KEY, when introspected.
   * Composite keys leave this unset — using the first column would be a false grain.
   * Authoring never guesses `id` or the first column.
   */
  primaryKey?: string;
  /** All PRIMARY KEY columns in ordinal order. Length > 1 is composite. */
  primaryKeyColumns?: string[];
  /** Columns that each have their own single-column UNIQUE constraint. */
  uniqueColumns?: string[];
}

/** Apply introspected PRIMARY KEY columns. Composite keys are recorded, not truncated. */
export function applyPrimaryKeys(
  tables: Iterable<TableInfo>,
  keys: ReadonlyArray<{ table: string; column: string }>,
): void {
  const grouped = new Map<string, string[]>();
  for (const key of keys) {
    const list = grouped.get(key.table) ?? [];
    if (!list.includes(key.column)) list.push(key.column);
    grouped.set(key.table, list);
  }
  for (const table of tables) {
    const cols = grouped.get(table.name);
    if (!cols || cols.length === 0) continue;
    table.primaryKeyColumns = cols;
    table.primaryKey = cols.length === 1 ? cols[0] : undefined;
  }
}

/** Introspected single-column grain only — never `id`, columns[0], or a composite first column. */
export function tablePrimaryKey(table: TableInfo | undefined): string | undefined {
  return table?.primaryKey;
}

/** All introspected PRIMARY KEY columns in ordinal order. */
export function tablePrimaryKeyColumns(table: TableInfo | undefined): string[] {
  if (table?.primaryKeyColumns && table.primaryKeyColumns.length > 0) return table.primaryKeyColumns;
  return table?.primaryKey ? [table.primaryKey] : [];
}

export function isCompositePrimaryKey(table: TableInfo | undefined): boolean {
  return tablePrimaryKeyColumns(table).length > 1;
}

/**
 * Single-column UNIQUE constraints that can be a Grane grain.
 * Nullable UNIQUE columns are not grain — PostgreSQL UNIQUE allows multiple NULLs.
 */
export function grainUniqueColumns(table: TableInfo | undefined): string[] {
  if (!table?.uniqueColumns?.length) return [];
  return table.uniqueColumns.filter((name) => {
    const col = table.columns.find((item) => item.name === name);
    return Boolean(col && !col.nullable);
  });
}

/**
 * Record columns that appear in a single-column UNIQUE constraint.
 * Composite UNIQUE indexes are ignored — they are not a Grane grain.
 */
export function applySingleColumnUniques(
  tables: Iterable<TableInfo>,
  keys: ReadonlyArray<{ table: string; column: string; constraint: string }>,
): void {
  const byConstraint = new Map<string, { table: string; columns: string[] }>();
  for (const key of keys) {
    const id = `${key.table}\0${key.constraint}`;
    const entry = byConstraint.get(id) ?? { table: key.table, columns: [] };
    if (!entry.columns.includes(key.column)) entry.columns.push(key.column);
    byConstraint.set(id, entry);
  }
  const byTable = new Map<string, string[]>();
  for (const { table, columns } of byConstraint.values()) {
    if (columns.length !== 1) continue;
    const list = byTable.get(table) ?? [];
    if (!list.includes(columns[0]!)) list.push(columns[0]!);
    byTable.set(table, list);
  }
  for (const table of tables) {
    const cols = byTable.get(table.name);
    if (cols && cols.length > 0) table.uniqueColumns = cols;
  }
}

export interface ForeignKeyInfo {
  constraintName: string;
  table: string;
  column: string;
  refTable: string;
  refColumn: string;
}

export interface DatabaseSchema {
  schemaName: string;
  tables: TableInfo[];
  foreignKeys: ForeignKeyInfo[];
}

/** Look up a column's warehouse type from an introspected schema snapshot. */
export function columnDataType(
  schema: DatabaseSchema | null | undefined,
  table: string,
  column: string,
): string | null {
  if (!schema) return null;
  const tbl =
    schema.tables.find((item) => item.name === table) ??
    schema.tables.find((item) => item.name.toLowerCase() === table.toLowerCase());
  if (!tbl) return null;
  const col =
    tbl.columns.find((item) => item.name === column) ??
    tbl.columns.find((item) => item.name.toLowerCase() === column.toLowerCase());
  return col?.dataType ?? null;
}

export interface ExecutedRows {
  columns: string[];
  rows: Record<string, unknown>[];
}

/**
 * A warehouse connector. Grane compiles SQL using the dialect, then the
 * connector executes it read-only against the customer's database.
 *
 * `query` must call {@link isWriteSql} and refuse before touching the driver.
 */
export interface WarehouseConnector {
  readonly type: WarehouseType;
  readonly dialect: SqlDialect;
  query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows>;
  introspect(): Promise<DatabaseSchema>;
  close(): Promise<void>;
}

/**
 * Non-SELECT statement heads Grane will not execute. One list for the kernel
 * and every warehouse connector. Compiled SQL is still SELECT; this is a
 * last-line guard, not the security boundary.
 */
export const WRITE_KEYWORDS =
  /^(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do|optimize|execute)\b/i;

/** Strip leading block comments and `--` line comments so write detection sees the real head. */
export function stripLeadingSqlComments(sql: string): string {
  let rest = sql;
  for (;;) {
    const next = rest.replace(/^\s+/, "");
    if (next.startsWith("/*")) {
      const end = next.indexOf("*/");
      if (end === -1) return next;
      rest = next.slice(end + 2);
      continue;
    }
    if (next.startsWith("--")) {
      const nl = next.indexOf("\n");
      if (nl === -1) return "";
      rest = next.slice(nl + 1);
      continue;
    }
    return next;
  }
}

export function isWriteSql(sql: string): boolean {
  return WRITE_KEYWORDS.test(stripLeadingSqlComments(sql));
}

/** TLS options when `connection.ssl` is enabled. Verify certificates by default. */
export function warehouseSslOptions(connection: {
  ssl?: boolean;
  ssl_verify?: boolean;
}): { rejectUnauthorized: boolean } | undefined {
  if (!connection.ssl) return undefined;
  return { rejectUnauthorized: connection.ssl_verify !== false };
}

export function timeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/** Postgres/MySQL pool size. Default 5 when the field is omitted. */
export function connectionPoolSize(connection: { pool_size?: number }): number {
  return connection.pool_size && connection.pool_size > 0 ? connection.pool_size : 5;
}

/** Honour limits.timeout_ms when the driver has no native deadline. */
export async function runWithTimeout<T>(
  work: Promise<T>,
  timeoutMs: number,
  interrupt?: () => void,
  label = "Warehouse query",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try {
        interrupt?.();
      } catch {
        /* interrupt is best-effort */
      }
      reject(new Error(`${label} exceeded limits.timeout_ms (${timeoutMs}).`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function inferRelationships(schema: DatabaseSchema): Record<
  string,
  { from: string; to: string; type: "many_to_one" }
> {
  const relationships: Record<string, { from: string; to: string; type: "many_to_one" }> = {};
  for (const fk of schema.foreignKeys) {
    const base = `${fk.table}_to_${fk.refTable}`;
    let name = base;
    let n = 2;
    while (name in relationships) {
      name = `${base}_${n++}`;
    }
    relationships[name] = {
      from: `${fk.table}.${fk.column}`,
      to: `${fk.refTable}.${fk.refColumn}`,
      type: "many_to_one",
    };
  }
  return relationships;
}

export async function loadOptionalModule<T>(pkg: string, warehouse: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch {
    throw new Error(
      `The ${warehouse} connector requires the "${pkg}" package. Install it in the same project as Grane:\n  npm install ${pkg}`,
    );
  }
}
