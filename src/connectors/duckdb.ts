import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { duckdbDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery } from "../errors.js";

type DuckDbDatabase = {
  all: (sql: string, ...args: unknown[]) => void;
  close: (cb?: (err: Error | null) => void) => void;
};

export class DuckDbConnector implements WarehouseConnector {
  readonly type = "duckdb" as const;
  readonly dialect = duckdbDialect;
  private db: DuckDbDatabase | null = null;
  private readonly path: string;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig) {
    this.path = connection.path || connection.database || ":memory:";
    this.schemaName = connection.schema || "main";
  }

  private async getDb(): Promise<DuckDbDatabase> {
    if (this.db) return this.db;
    const mod = await loadOptionalModule<{ Database: new (path: string) => DuckDbDatabase } & { default?: { Database: new (path: string) => DuckDbDatabase } }>(
      "duckdb",
      "DuckDB",
    );
    const Database = mod.Database ?? mod.default?.Database;
    if (!Database) throw new Error("duckdb package did not export Database.");
    this.db = new Database(this.path);
    return this.db;
  }

  private async all(sql: string, params: Scalar[] = []): Promise<Record<string, unknown>[]> {
    const db = await this.getDb();
    return new Promise((resolve, reject) => {
      const cb = (err: Error | null, rows: Record<string, unknown>[]) => {
        if (err) reject(err);
        else resolve(rows ?? []);
      };
      if (params.length > 0) db.all(sql, ...params, cb);
      else db.all(sql, cb);
    });
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (/^\s*(insert|update|delete|drop|alter|create|truncate|copy)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const rows = (await this.all(sql, params)).slice(0, limits.max_rows);
    return { columns: Object.keys(rows[0] ?? {}), rows };
  }

  async introspect(): Promise<DatabaseSchema> {
    const rows = await this.all(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [this.schemaName],
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      const tableName = String(row["table_name"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: this.schemaName, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["column_name"]),
        dataType: String(row["data_type"]),
        nullable: String(row["is_nullable"]).toUpperCase() === "YES",
      });
    }
    return { schemaName: this.schemaName, tables: [...tablesByName.values()], foreignKeys: [] };
  }

  async close(): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    this.db = null;
    await new Promise<void>((resolve, reject) => {
      db.close((err) => (err ? reject(err) : resolve()));
    });
  }
}
