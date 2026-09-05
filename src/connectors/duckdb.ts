import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { duckdbDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery, warehouseUnreachable } from "../errors.js";

type DuckDbReader = {
  columnNames?: () => string[];
  getRowObjectsJS?: () => Record<string, unknown>[];
  getRowObjects?: () => Record<string, unknown>[];
};

type DuckDbConnection = {
  runAndReadAll: (sql: string, values?: unknown[]) => Promise<DuckDbReader>;
  closeSync?: () => void;
  disconnectSync?: () => void;
};

type DuckDbInstance = {
  connect: () => Promise<DuckDbConnection>;
};

type DuckDbMod = {
  DuckDBInstance: {
    create: (path?: string, opts?: Record<string, string>) => Promise<DuckDbInstance>;
  };
};

export class DuckDbConnector implements WarehouseConnector {
  readonly type = "duckdb" as const;
  readonly dialect = duckdbDialect;
  private instance: DuckDbInstance | null = null;
  private conn: DuckDbConnection | null = null;
  private readonly path: string;
  private readonly schemaName: string;
  private readonly token?: string;

  constructor(connection: ConnectionConfig) {
    this.path = connection.path || connection.database || ":memory:";
    this.schemaName = connection.schema || "main";
    this.token = connection.token || connection.password || process.env.MOTHERDUCK_TOKEN;
  }

  private isMotherDuck(): boolean {
    return this.path.startsWith("md:");
  }

  private async getConn(): Promise<DuckDbConnection> {
    if (this.conn) return this.conn;
    const mod = await loadOptionalModule<DuckDbMod>("@duckdb/node-api", "DuckDB");
    const opts: Record<string, string> = {};
    if (this.isMotherDuck()) {
      if (this.token) opts.motherduck_token = this.token;
    } else if (this.path !== ":memory:") {
      opts.access_mode = "READ_ONLY";
    }
    // Pin the session timezone so compiled timestamp casts are independent of
    // the host TZ. Postgres already does SET LOCAL TIME ZONE 'UTC'.
    const withTz = { ...opts, TimeZone: "UTC" };
    try {
      try {
        this.instance = await mod.DuckDBInstance.create(this.path, withTz);
      } catch {
        this.instance = await mod.DuckDBInstance.create(
          this.path,
          Object.keys(opts).length > 0 ? opts : undefined,
        );
      }
      this.conn = await this.instance.connect();
    } catch (err) {
      throw warehouseUnreachable("DuckDB", err);
    }
    try {
      // Session setting; may be rejected on some read-only attachments.
      await this.conn.runAndReadAll("SET TimeZone = 'UTC'");
    } catch {
      // Keep the instance-level TimeZone pin when SET is unavailable.
    }
    return this.conn;
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (/^\s*(insert|update|delete|drop|alter|create|truncate|copy)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const conn = await this.getConn();
    const reader = await conn.runAndReadAll(sql, params.length > 0 ? params : undefined);
    const rows = (reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? []).slice(0, limits.max_rows);
    const columns = reader.columnNames?.() ?? Object.keys(rows[0] ?? {});
    return { columns, rows };
  }

  async introspect(): Promise<DatabaseSchema> {
    const conn = await this.getConn();
    const reader = await conn.runAndReadAll(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = $1
       ORDER BY table_name, ordinal_position`,
      [this.schemaName],
    );
    const rows = reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? [];
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
    const conn = this.conn;
    this.conn = null;
    this.instance = null;
    conn?.closeSync?.();
    conn?.disconnectSync?.();
  }
}
