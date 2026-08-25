import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { snowflakeDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery } from "../errors.js";

// snowflake-sdk is CommonJS; we load it dynamically so Postgres-only installs stay light.
type SnowflakeSdk = {
  createConnection: (opts: Record<string, unknown>) => SnowflakeConnection;
  default?: { createConnection: (opts: Record<string, unknown>) => SnowflakeConnection };
};
type SnowflakeConnection = {
  connect: (cb: (err: Error | null) => void) => void;
  execute: (opts: {
    sqlText: string;
    binds?: unknown[];
    complete: (err: Error | null, stmt: { getColumns?: () => { getName: () => string }[] }, rows?: Record<string, unknown>[]) => void;
  }) => void;
  destroy: (cb: (err: Error | null) => void) => void;
};

export class SnowflakeConnector implements WarehouseConnector {
  readonly type = "snowflake" as const;
  readonly dialect = snowflakeDialect;
  private conn: SnowflakeConnection | null = null;
  private readonly connection: ConnectionConfig;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig) {
    this.connection = connection;
    this.schemaName = connection.schema || "PUBLIC";
  }

  private async getConn(): Promise<SnowflakeConnection> {
    if (this.conn) return this.conn;
    const mod = await loadOptionalModule<SnowflakeSdk>("snowflake-sdk", "Snowflake");
    const create = mod.createConnection ?? mod.default?.createConnection;
    if (!create) throw configError("snowflake-sdk did not export createConnection.");
    const account = this.connection.account;
    if (!account && !this.connection.url) {
      throw configError("Snowflake connection requires connection.account (and user/password/warehouse/database).");
    }
    const conn = create({
      account,
      username: this.connection.user,
      password: this.connection.password,
      warehouse: this.connection.warehouse,
      database: this.connection.database,
      schema: this.schemaName,
      role: this.connection.role,
      application: "Grane",
    });
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });
    this.conn = conn;
    return conn;
  }

  private exec(sql: string, binds: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; columns: string[] }> {
    if (/^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|merge)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    return new Promise((resolve, reject) => {
      void this.getConn().then((conn) => {
        conn.execute({
          sqlText: sql,
          binds,
          complete: (err, stmt, rows) => {
            if (err) return reject(err);
            const columns = stmt.getColumns?.().map((c) => c.getName()) ?? Object.keys(rows?.[0] ?? {});
            resolve({ rows: (rows ?? []) as Record<string, unknown>[], columns });
          },
        });
      }, reject);
    });
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    const { rows, columns } = await this.exec(sql, params);
    return { columns, rows: rows.slice(0, limits.max_rows) };
  }

  async introspect(): Promise<DatabaseSchema> {
    const schemaName = this.schemaName.toUpperCase();
    const { rows } = await this.exec(
      `SELECT table_name AS TABLE_NAME, column_name AS COLUMN_NAME, data_type AS DATA_TYPE, is_nullable AS IS_NULLABLE
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [schemaName],
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      const tableName = String(row["TABLE_NAME"] ?? row["table_name"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: schemaName, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["COLUMN_NAME"] ?? row["column_name"]),
        dataType: String(row["DATA_TYPE"] ?? row["data_type"]),
        nullable: String(row["IS_NULLABLE"] ?? row["is_nullable"]).toUpperCase() === "YES",
      });
    }
    let foreignKeys: DatabaseSchema["foreignKeys"] = [];
    try {
      const fk = await this.exec(
        `SELECT fk.constraint_name AS CONSTRAINT_NAME, fk.table_name AS TABLE_NAME, fkc.column_name AS COLUMN_NAME,
                pk.table_name AS REF_TABLE, pkc.column_name AS REF_COLUMN
         FROM information_schema.table_constraints fk
         JOIN information_schema.referential_constraints rc ON fk.constraint_name = rc.constraint_name
         JOIN information_schema.table_constraints pk ON rc.unique_constraint_name = pk.constraint_name
         JOIN information_schema.key_column_usage fkc ON fk.constraint_name = fkc.constraint_name
         JOIN information_schema.key_column_usage pkc
           ON pk.constraint_name = pkc.constraint_name AND fkc.ordinal_position = pkc.ordinal_position
         WHERE fk.constraint_type = 'FOREIGN KEY' AND fk.table_schema = ?`,
        [schemaName],
      );
      foreignKeys = fk.rows.map((row) => ({
        constraintName: String(row["CONSTRAINT_NAME"] ?? row["constraint_name"]),
        table: String(row["TABLE_NAME"] ?? row["table_name"]),
        column: String(row["COLUMN_NAME"] ?? row["column_name"]),
        refTable: String(row["REF_TABLE"] ?? row["ref_table"]),
        refColumn: String(row["REF_COLUMN"] ?? row["ref_column"]),
      }));
    } catch {
      foreignKeys = [];
    }
    return { schemaName, tables: [...tablesByName.values()], foreignKeys };
  }

  async close(): Promise<void> {
    if (!this.conn) return;
    const conn = this.conn;
    this.conn = null;
    await new Promise<void>((resolve, reject) => {
      conn.destroy((err) => (err ? reject(err) : resolve()));
    });
  }
}
