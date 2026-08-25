import type pg from "pg";

/** A snapshot of the live database schema used for validation and discovery. */

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

const NUMERIC_TYPES = new Set([
  "smallint",
  "integer",
  "bigint",
  "numeric",
  "real",
  "double precision",
  "money",
]);

const TEMPORAL_TYPES = new Set([
  "timestamp without time zone",
  "timestamp with time zone",
  "date",
]);

export function isNumericType(dataType: string): boolean {
  return NUMERIC_TYPES.has(dataType);
}

export function isTemporalType(dataType: string): boolean {
  return TEMPORAL_TYPES.has(dataType);
}

export async function introspect(pool: pg.Pool, schemaName: string): Promise<DatabaseSchema> {
  const columnsResult = await pool.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    `SELECT c.table_name, c.column_name, c.data_type, c.is_nullable
     FROM information_schema.columns c
     JOIN information_schema.tables t
       ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
     ORDER BY c.table_name, c.ordinal_position`,
    [schemaName],
  );

  const tablesByName = new Map<string, TableInfo>();
  for (const row of columnsResult.rows) {
    let table = tablesByName.get(row.table_name);
    if (!table) {
      table = { schema: schemaName, name: row.table_name, columns: [] };
      tablesByName.set(row.table_name, table);
    }
    table.columns.push({
      name: row.column_name,
      dataType: row.data_type,
      nullable: row.is_nullable === "YES",
    });
  }

  const fkResult = await pool.query<{
    constraint_name: string;
    table_name: string;
    column_name: string;
    ref_table: string;
    ref_column: string;
  }>(
    `SELECT
       con.conname AS constraint_name,
       src.relname AS table_name,
       src_col.attname AS column_name,
       ref.relname AS ref_table,
       ref_col.attname AS ref_column
     FROM pg_constraint con
     JOIN pg_class src ON src.oid = con.conrelid
     JOIN pg_class ref ON ref.oid = con.confrelid
     JOIN pg_namespace ns ON ns.oid = src.relnamespace
     JOIN unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) ON true
     JOIN unnest(con.confkey) WITH ORDINALITY AS rk(attnum, ord) ON rk.ord = sk.ord
     JOIN pg_attribute src_col ON src_col.attrelid = src.oid AND src_col.attnum = sk.attnum
     JOIN pg_attribute ref_col ON ref_col.attrelid = ref.oid AND ref_col.attnum = rk.attnum
     WHERE con.contype = 'f' AND ns.nspname = $1
     ORDER BY con.conname, sk.ord`,
    [schemaName],
  );

  const foreignKeys: ForeignKeyInfo[] = fkResult.rows.map((row) => ({
    constraintName: row.constraint_name,
    table: row.table_name,
    column: row.column_name,
    refTable: row.ref_table,
    refColumn: row.ref_column,
  }));

  return {
    schemaName,
    tables: [...tablesByName.values()],
    foreignKeys,
  };
}

/**
 * Infer relationship definitions from foreign keys, for `grane discover`.
 * FK columns are assumed many_to_one (child -> parent) unless the FK column
 * carries a unique constraint, which V0.1 does not detect; users can adjust.
 */
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
