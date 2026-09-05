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
 */
export interface WarehouseConnector {
  readonly type: WarehouseType;
  readonly dialect: SqlDialect;
  query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows>;
  introspect(): Promise<DatabaseSchema>;
  close(): Promise<void>;
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

/** npm package name to install. Subpath imports (mysql2/promise) are not packages. */
export function npmInstallName(pkg: string): string {
  if (pkg === "mysql2/promise") return "mysql2";
  return pkg;
}

export async function loadOptionalModule<T>(pkg: string, warehouse: string): Promise<T> {
  try {
    return (await import(pkg)) as T;
  } catch {
    const install = npmInstallName(pkg);
    throw new Error(
      `The ${warehouse} connector requires the "${install}" package. Install it in the same project as Grane:\n  npm install ${install}`,
    );
  }
}
