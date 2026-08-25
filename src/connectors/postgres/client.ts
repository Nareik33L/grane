import pg from "pg";
import type { ConnectionConfig, LimitsConfig, Scalar } from "../../config/schema.js";
import { configError } from "../../errors.js";
import { postgresDialect, redshiftDialect, type WarehouseType } from "../dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "../types.js";
import { unsafeQuery } from "../../errors.js";

const { Pool } = pg;

const WRITE_KEYWORDS =
  /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do)\b/i;

export function createPgPool(connection: ConnectionConfig): pg.Pool {
  if (connection.url) {
    if (connection.url.includes("${")) {
      throw configError(
        `Connection URL contains an unresolved environment variable: ${connection.url.replace(/:[^:@/]+@/, ":***@")}`,
      );
    }
    return new Pool({
      connectionString: connection.url,
      ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
      max: 5,
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
    ssl: connection.ssl ? { rejectUnauthorized: false } : undefined,
    max: 5,
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
    if (WRITE_KEYWORDS.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL statement_timeout = ${Math.floor(limits.timeout_ms)}`);
      await client.query("SET LOCAL TIME ZONE 'UTC'");
      const result = await client.query<Record<string, unknown>>(sql, params);
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

  return { schemaName, tables: [...tablesByName.values()], foreignKeys };
}
