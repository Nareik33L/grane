import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { mysqlDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery } from "../errors.js";

type MysqlPool = {
  query: (opts: unknown, values?: unknown) => Promise<[unknown, { name: string }[] | undefined]>;
  end: () => Promise<void>;
};

export class MysqlConnector implements WarehouseConnector {
  readonly type = "mysql" as const;
  readonly dialect = mysqlDialect;
  private pool: MysqlPool | null = null;
  private readonly connection: ConnectionConfig;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig) {
    this.connection = connection;
    this.schemaName = connection.schema || connection.database || "";
  }

  private async getPool(): Promise<MysqlPool> {
    if (this.pool) return this.pool;
    const mysql = (await loadOptionalModule<{ createPool: (opts: Record<string, unknown>) => MysqlPool }>(
      "mysql2/promise",
      "MySQL",
    ));
    if (this.connection.url) {
      this.pool = mysql.createPool({ uri: this.connection.url, connectionLimit: 5 });
    } else {
      if (!this.connection.host && !this.connection.database) {
        throw configError("MySQL connection requires connection.url or host + database.");
      }
      this.pool = mysql.createPool({
        host: this.connection.host,
        port: this.connection.port ?? 3306,
        user: this.connection.user,
        password: this.connection.password,
        database: this.connection.database,
        ssl: this.connection.ssl ? {} : undefined,
        connectionLimit: 5,
      });
    }
    return this.pool;
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (/^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const pool = await this.getPool();
    const [rows, fields] = await pool.query({ sql, values: params, timeout: limits.timeout_ms });
    const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
    return {
      columns: Array.isArray(fields) ? fields.map((f) => String(f.name)) : Object.keys(list[0] ?? {}),
      rows: list.slice(0, limits.max_rows),
    };
  }

  async introspect(): Promise<DatabaseSchema> {
    const schemaName = this.schemaName;
    if (!schemaName) {
      throw configError("MySQL introspection requires connection.schema or connection.database.");
    }
    const pool = await this.getPool();
    const [colRows] = await pool.query(
      `SELECT table_name AS table_name, column_name AS column_name, data_type AS data_type, is_nullable AS is_nullable
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schemaName],
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of colRows as { table_name: string; column_name: string; data_type: string; is_nullable: string }[]) {
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
    const [fkRows] = await pool.query(
      `SELECT constraint_name AS constraint_name, table_name AS table_name, column_name AS column_name,
              referenced_table_name AS ref_table, referenced_column_name AS ref_column
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL`,
      [schemaName],
    );
    const foreignKeys = (
      fkRows as {
        constraint_name: string;
        table_name: string;
        column_name: string;
        ref_table: string;
        ref_column: string;
      }[]
    ).map((row) => ({
      constraintName: row.constraint_name,
      table: row.table_name,
      column: row.column_name,
      refTable: row.ref_table,
      refColumn: row.ref_column,
    }));
    return { schemaName, tables: [...tablesByName.values()], foreignKeys };
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
    this.pool = null;
  }
}
