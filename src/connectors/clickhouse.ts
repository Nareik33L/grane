import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { clickhouseDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery } from "../errors.js";

type ClickHouseMod = {
  createClient: (opts: Record<string, unknown>) => {
    query: (opts: Record<string, unknown>) => Promise<{ json: <T>() => Promise<T> }>;
    close: () => Promise<void>;
  };
};

export class ClickHouseConnector implements WarehouseConnector {
  readonly type = "clickhouse" as const;
  readonly dialect = clickhouseDialect;
  private client: ReturnType<ClickHouseMod["createClient"]> | null = null;
  private readonly connection: ConnectionConfig;
  private readonly schemaName: string;

  constructor(connection: ConnectionConfig) {
    this.connection = connection;
    this.schemaName = connection.schema || connection.database || "default";
  }

  private async getClient() {
    if (this.client) return this.client;
    const mod = await loadOptionalModule<ClickHouseMod>("@clickhouse/client", "ClickHouse");
    if (!this.connection.url && !this.connection.host) {
      throw configError("ClickHouse connection requires connection.url (http://user:pass@host:8123) or host.");
    }
    this.client = mod.createClient({
      url: this.connection.url,
      host: this.connection.host
        ? `http://${this.connection.host}:${this.connection.port ?? 8123}`
        : undefined,
      username: this.connection.user,
      password: this.connection.password,
      database: this.schemaName,
      request_timeout: 30_000,
    });
    return this.client;
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (/^\s*(insert|alter|create|drop|truncate|delete|optimize)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const client = await this.getClient();
    const query_params: Record<string, Scalar> = {};
    params.forEach((value, i) => {
      query_params[`p${i + 1}`] = value;
    });
    const result = await client.query({ query: sql, query_params, format: "JSONEachRow" });
    const rows = (await result.json<Record<string, unknown>[]>()).slice(0, limits.max_rows);
    return { columns: Object.keys(rows[0] ?? {}), rows };
  }

  async introspect(): Promise<DatabaseSchema> {
    const client = await this.getClient();
    const result = await client.query({
      query: `SELECT table AS table_name, name AS column_name, type AS data_type
              FROM system.columns
              WHERE database = {db:String}
              ORDER BY table, position`,
      query_params: { db: this.schemaName },
      format: "JSONEachRow",
    });
    const rows = await result.json<{ table_name: string; column_name: string; data_type: string }[]>();
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      let table = tablesByName.get(row.table_name);
      if (!table) {
        table = { schema: this.schemaName, name: row.table_name, columns: [] };
        tablesByName.set(row.table_name, table);
      }
      table.columns.push({
        name: row.column_name,
        dataType: row.data_type,
        nullable: /Nullable/i.test(row.data_type),
      });
    }
    return { schemaName: this.schemaName, tables: [...tablesByName.values()], foreignKeys: [] };
  }

  async close(): Promise<void> {
    if (this.client) await this.client.close();
    this.client = null;
  }
}
