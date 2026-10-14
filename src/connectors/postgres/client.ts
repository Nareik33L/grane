import pg from "pg";
import type { ConnectionConfig, LimitsConfig, Scalar } from "../../config/schema.js";
import { configError } from "../../errors.js";
import { postgresDialect, redshiftDialect, type WarehouseType } from "../dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "../types.js";
import {
  applyPrimaryKeys,
  applySingleColumnUniques,
  isWriteSql,
  warehouseSslOptions,
  connectionPoolSize,
} from "../types.js";
import { unsafeQuery } from "../../errors.js";

export const POSTGRES_READ_ONLY_BEGIN = "BEGIN TRANSACTION READ ONLY";
export const POSTGRES_SESSION_UTC = "SET LOCAL TIME ZONE 'UTC'";
/** Force extended protocol so multi-statement SQL cannot COMMIT out of READ ONLY. */
export const POSTGRES_USER_QUERY_MODE = "extended" as const;

export function postgresStatementTimeoutSql(timeoutMs: number): string {
  return `SET LOCAL statement_timeout = ${Math.floor(timeoutMs)}`;
}

const { Pool } = pg;

export function createPgPool(connection: ConnectionConfig): pg.Pool {
  const ssl = warehouseSslOptions(connection);
  const max = connectionPoolSize(connection);
  if (connection.url) {
    if (connection.url.includes("${")) {
      throw configError(
        `Connection URL contains an unresolved environment variable: ${connection.url.replace(/:[^:@/]+@/, ":***@")}`,
      );
    }
    return new Pool({
      connectionString: connection.url,
      ssl,
      max,
    });
  }
  if (!connection.host && !connection.database && !process.env.PGHOST && !process.env.PGDATABASE) {
    throw configError(
      "No database connection configured. Set connection.url in grane.yml (environment variables like ${DATABASE_URL} are supported) or standard PG* environment variables.",
    );
  }
  return new Pool({
    host: connection.host,
    port: connection.port,
    database: connection.database,
    user: connection.user,
    password: connection.password,
    ssl,
    max,
  });
}

export class PostgresConnector implements WarehouseConnector {
  readonly type: WarehouseType;
  readonly dialect: typeof postgresDialect | typeof redshiftDialect;
  private readonly pool: pg.Pool;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig, redshift = false) {
    this.type = redshift ? "redshift" : "postgres";
    this.dialect = redshift ? redshiftDialect : postgresDialect;
    this.pool = createPgPool(connection);
    this.schemaName = connection.schema || (redshift ? "public" : "public");
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (isWriteSql(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const client = await this.pool.connect();
    try {
      await client.query(POSTGRES_READ_ONLY_BEGIN);
      await client.query(postgresStatementTimeoutSql(limits.timeout_ms));
      await client.query(POSTGRES_SESSION_UTC);
      const result = await client.query<Record<string, unknown>>({
        text: sql,
        values: params,
        queryMode: POSTGRES_USER_QUERY_MODE,
      } as pg.QueryConfig & { queryMode: typeof POSTGRES_USER_QUERY_MODE });
      await client.query("COMMIT");
      return {
        columns: result.fields.map((f) => f.name),
        rows: result.rows.slice(0, limits.max_rows),
      };
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async introspect(): Promise<DatabaseSchema> {
    return introspectPostgres(this.pool, this.schemaName);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export async function introspectPostgres(pool: pg.Pool, schemaName: string): Promise<DatabaseSchema> {
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

  let foreignKeys: DatabaseSchema["foreignKeys"] = [];
  try {
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
    foreignKeys = fkResult.rows.map((row) => ({
      constraintName: row.constraint_name,
      table: row.table_name,
      column: row.column_name,
      refTable: row.ref_table,
      refColumn: row.ref_column,
    }));
  } catch {
    // Redshift and some Postgres-compatible engines lack pg_constraint details.
    foreignKeys = [];
  }

  try {
    // pg_constraint is visible to SELECT-only roles; information_schema.table_constraints is not
    // (it requires INSERT/UPDATE/REFERENCES, so grane_readonly would silently get no PKs).
    const pkResult = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT
         src.relname AS table_name,
         src_col.attname AS column_name
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = src.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) ON true
       JOIN pg_attribute src_col ON src_col.attrelid = src.oid AND src_col.attnum = sk.attnum
       WHERE con.contype = 'p'
         AND ns.nspname = $1
         AND src.relkind IN ('r', 'p')
         AND NOT src_col.attisdropped
       ORDER BY src.relname, sk.ord`,
      [schemaName],
    );
    applyPrimaryKeys(
      tablesByName.values(),
      pkResult.rows.map((row) => ({ table: row.table_name, column: row.column_name })),
    );
    const uniqueResult = await pool.query<{ table_name: string; column_name: string; constraint_name: string }>(
      `SELECT
         src.relname AS table_name,
         src_col.attname AS column_name,
         con.conname AS constraint_name
       FROM pg_constraint con
       JOIN pg_class src ON src.oid = con.conrelid
       JOIN pg_namespace ns ON ns.oid = src.relnamespace
       JOIN unnest(con.conkey) WITH ORDINALITY AS sk(attnum, ord) ON true
       JOIN pg_attribute src_col ON src_col.attrelid = src.oid AND src_col.attnum = sk.attnum
       WHERE con.contype = 'u'
         AND ns.nspname = $1
         AND src.relkind IN ('r', 'p')
         AND NOT src_col.attisdropped
       ORDER BY src.relname, con.conname, sk.ord`,
      [schemaName],
    );
    applySingleColumnUniques(
      tablesByName.values(),
      uniqueResult.rows.map((row) => ({
        table: row.table_name,
        column: row.column_name,
        constraint: row.constraint_name,
      })),
    );
  } catch {
    /* PRIMARY KEY metadata is optional; authoring will not guess a grain. */
  }

  return { schemaName, tables: [...tablesByName.values()], foreignKeys };
}
