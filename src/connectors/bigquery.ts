import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { bigqueryDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule, isWriteSql } from "./types.js";
import { executedRowsFromBigQuery, schemaFromBigQueryResults } from "./result-meta.js";
import { unsafeQuery } from "../errors.js";

type BqJob = {
  getQueryResults: (
    opts?: Record<string, unknown>,
  ) => Promise<[Record<string, unknown>[], unknown?, { schema?: unknown }?]>;
  metadata?: { statistics?: { query?: { schema?: unknown } } };
};

type BigQueryClient = {
  createQueryJob?: (opts: Record<string, unknown>) => Promise<[BqJob]>;
  query: (
    opts: Record<string, unknown>,
  ) => Promise<[Record<string, unknown>[], unknown?, { schema?: unknown }?]>;
};

type BigQueryCtor = new (opts?: Record<string, unknown>) => BigQueryClient;

export class BigQueryConnector implements WarehouseConnector {
  readonly type = "bigquery" as const;
  readonly dialect = bigqueryDialect;
  private client: BigQueryClient | null = null;
  private readonly connection: ConnectionConfig;
  private readonly dataset: string;
  private readonly project?: string;

  constructor(connection: ConnectionConfig, client?: BigQueryClient | null) {
    this.connection = connection;
    this.dataset = connection.dataset || connection.schema || "";
    this.project = connection.project || connection.database;
    this.client = client ?? null;
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
    if (isWriteSql(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const bq = await this.getClient();
    const named: Record<string, Scalar> = {};
    params.forEach((value, i) => {
      named[`p${i + 1}`] = value;
    });
    const jobOpts = bigQueryJobOptions(sql, named, limits, this.connection.location);
    if (typeof bq.createQueryJob === "function") {
      const [job] = await bq.createQueryJob(jobOpts);
      const [rows, , apiResponse] = await job.getQueryResults({ maxResults: limits.max_rows });
      return executedRowsFromBigQuery(rows, schemaFromBigQueryResults(apiResponse, job), limits.max_rows);
    }
    const [rows, , apiResponse] = await bq.query(jobOpts);
    return executedRowsFromBigQuery(rows, schemaFromBigQueryResults(apiResponse), limits.max_rows);
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

/** Default scan cap when `limits.max_bytes_billed` is omitted (10 GiB). */
export const DEFAULT_BIGQUERY_MAX_BYTES_BILLED = 10 * 1024 * 1024 * 1024;

export function bigQueryMaximumBytesBilled(limits: LimitsConfig): string {
  return String(limits.max_bytes_billed ?? DEFAULT_BIGQUERY_MAX_BYTES_BILLED);
}

export function bigQueryJobOptions(
  sql: string,
  params: Record<string, Scalar>,
  limits: LimitsConfig,
  location?: string,
): {
  query: string;
  params: Record<string, Scalar>;
  location?: string;
  jobTimeoutMs: number;
  maximumBytesBilled: string;
} {
  return {
    query: sql,
    params,
    location,
    jobTimeoutMs: limits.timeout_ms,
    maximumBytesBilled: bigQueryMaximumBytesBilled(limits),
  };
}

export function bigquerySchemaNamespace(connection: ConnectionConfig): string | undefined {
  const dataset = connection.dataset || connection.schema;
  const project = connection.project || connection.database;
  if (project && dataset) return `${project}.${dataset}`;
  return dataset;
}
