import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { bigqueryDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule } from "./types.js";
import { unsafeQuery } from "../errors.js";

type BigQueryCtor = new (opts?: Record<string, unknown>) => {
  query: (opts: Record<string, unknown>) => Promise<[Record<string, unknown>[]]>;
};

export class BigQueryConnector implements WarehouseConnector {
  readonly type = "bigquery" as const;
  readonly dialect = bigqueryDialect;
  private client: InstanceType<BigQueryCtor> | null = null;
  private readonly connection: ConnectionConfig;
  private readonly dataset: string;
  private readonly project?: string;

  constructor(connection: ConnectionConfig) {
    this.connection = connection;
    this.dataset = connection.dataset || connection.schema || "";
    this.project = connection.project || connection.database;
  }

  private namespace(): string {
    if (this.project && this.dataset) return `${this.project}.${this.dataset}`;
    return this.dataset;
  }

  private async getClient() {
    if (this.client) return this.client;
    const mod = await loadOptionalModule<{ BigQuery: BigQueryCtor }>("@google-cloud/bigquery", "BigQuery");
    this.client = new mod.BigQuery({
      projectId: this.project,
      keyFilename: this.connection.credentials,
      location: this.connection.location,
    });
    return this.client;
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (/^\s*(insert|update|delete|drop|alter|create|truncate|merge)/i.test(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const bq = await this.getClient();
    const named: Record<string, Scalar> = {};
    params.forEach((value, i) => {
      named[`p${i + 1}`] = value;
    });
    const [rows] = await bq.query({
      query: sql,
      params: named,
      location: this.connection.location,
      jobTimeoutMs: limits.timeout_ms,
    });
    const list = rows.slice(0, limits.max_rows);
    return { columns: Object.keys(list[0] ?? {}), rows: list };
  }

  async introspect(): Promise<DatabaseSchema> {
    if (!this.dataset) {
      throw configError("BigQuery introspection requires connection.dataset (or connection.schema).");
    }
    const bq = await this.getClient();
    const datasetRef = this.project ? `\`${this.project}.${this.dataset}\`` : `\`${this.dataset}\``;
    const [rows] = await bq.query({
      query: `SELECT table_name, column_name, data_type, is_nullable
              FROM ${datasetRef}.INFORMATION_SCHEMA.COLUMNS
              ORDER BY table_name, ordinal_position`,
    });
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      const tableName = String(row["table_name"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: this.dataset, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["column_name"]),
        dataType: String(row["data_type"]),
        nullable: String(row["is_nullable"]).toUpperCase() === "YES",
      });
    }
    return { schemaName: this.namespace(), tables: [...tablesByName.values()], foreignKeys: [] };
  }

  async close(): Promise<void> {
    this.client = null;
  }
}

export function bigquerySchemaNamespace(connection: ConnectionConfig): string | undefined {
  const dataset = connection.dataset || connection.schema;
  const project = connection.project || connection.database;
  if (project && dataset) return `${project}.${dataset}`;
  return dataset;
}
