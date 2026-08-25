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
    const name = `${fk.table}_to_${fk.refTable}`;
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
