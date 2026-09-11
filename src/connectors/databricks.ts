import type { ConnectionConfig, LimitsConfig, Scalar } from "../config/schema.js";
import { configError } from "../errors.js";
import { databricksDialect } from "./dialect.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "./types.js";
import { loadOptionalModule, isWriteSql, timeoutSeconds } from "./types.js";
import { executedRowsFromDatabricks } from "./result-meta.js";
import { unsafeQuery } from "../errors.js";

type DatabricksSession = {
  executeStatement: (
    sql: string,
    opts?: Record<string, unknown>,
  ) => Promise<{
    fetchAll: () => Promise<Record<string, unknown>[]>;
    getSchema?: () => Promise<unknown>;
    close: () => Promise<void>;
  }>;
  close: () => Promise<void>;
};

type DatabricksClient = {
  connect: (opts: Record<string, unknown>) => Promise<DatabricksClient>;
  openSession: (opts?: Record<string, unknown>) => Promise<DatabricksSession>;
  close: () => Promise<void>;
};

type DatabricksMod = {
  DBSQLClient: new () => DatabricksClient;
  default?: { DBSQLClient: new () => DatabricksClient };
};

function stripHost(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

export function databricksSchemaNamespace(connection: ConnectionConfig): string {
  const schema = connection.schema || "default";
  const catalog = connection.catalog || connection.database;
  return catalog ? `${catalog}.${schema}` : schema;
}

export const DATABRICKS_SESSION_UTC = "SET TIME ZONE 'UTC'";

/** Statement options honoring `limits.timeout_ms` as `queryTimeout` seconds. */
export function databricksStatementOptions(
  params: Scalar[],
  timeoutMs: number,
): { runAsync: true; ordinalParameters?: Scalar[]; queryTimeout: number } {
  return {
    runAsync: true,
    ...(params.length > 0 ? { ordinalParameters: params } : {}),
    queryTimeout: timeoutSeconds(timeoutMs),
  };
}

export class DatabricksConnector implements WarehouseConnector {
  readonly type = "databricks" as const;
  readonly dialect = databricksDialect;
  private client: DatabricksClient | null = null;
  private session: DatabricksSession | null = null;
  private readonly connection: ConnectionConfig;
  private readonly schemaName: string;
  private readonly catalog?: string;

  constructor(connection: ConnectionConfig, session?: DatabricksSession | null) {
    this.connection = connection;
    this.schemaName = connection.schema || "default";
    this.catalog = connection.catalog || connection.database || undefined;
    this.session = session ?? null;
  }

  private async getSession(): Promise<DatabricksSession> {
    if (this.session) return this.session;
    const mod = await loadOptionalModule<DatabricksMod>("@databricks/sql", "Databricks");
    const DBSQLClient = mod.DBSQLClient ?? mod.default?.DBSQLClient;
    if (!DBSQLClient) throw configError("@databricks/sql did not export DBSQLClient.");
    const host = stripHost(this.connection.host || this.connection.url || "");
    const httpPath = this.connection.http_path || this.connection.path;
    const token = this.connection.token || this.connection.password;
    if (!host || !httpPath || !token) {
      throw configError(
        "Databricks connection requires host (or url), http_path, and token (or password).",
      );
    }
    const client = new DBSQLClient();
    await client.connect({
      host,
      path: httpPath,
      token,
      userAgentEntry: "Grane",
    });
    this.client = client;
    this.session = await client.openSession({
      initialCatalog: this.catalog,
      initialSchema: this.schemaName,
    });
    await this.pinUtc(this.session);
    return this.session;
  }

  private async pinUtc(session: DatabricksSession): Promise<void> {
    try {
      const operation = await session.executeStatement(DATABRICKS_SESSION_UTC, { runAsync: true });
      try {
        await operation.fetchAll().catch(() => undefined);
      } finally {
        await operation.close();
      }
    } catch {
      // Live tests skip when the warehouse is unreachable; SET may be blocked on some warehouses.
    }
  }

  private async exec(sql: string, params: Scalar[] = [], timeoutMs?: number): Promise<Record<string, unknown>[]> {
    if (isWriteSql(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const session = await this.getSession();
    const operation = await session.executeStatement(
      sql,
      timeoutMs != null ? databricksStatementOptions(params, timeoutMs) : { runAsync: true, ...(params.length > 0 ? { ordinalParameters: params } : {}) },
    );
    try {
      return (await operation.fetchAll()) ?? [];
    } finally {
      await operation.close();
    }
  }

  async query(sql: string, params: Scalar[], limits: LimitsConfig): Promise<ExecutedRows> {
    if (isWriteSql(sql)) {
      throw unsafeQuery("Refusing to execute a non-SELECT statement.");
    }
    const session = await this.getSession();
    await this.pinUtc(session);
    const operation = await session.executeStatement(sql, databricksStatementOptions(params, limits.timeout_ms));
    try {
      const rows = (await operation.fetchAll()) ?? [];
      const schema = operation.getSchema ? await operation.getSchema() : null;
      return executedRowsFromDatabricks(rows, schema, limits.max_rows);
    } finally {
      await operation.close();
    }
  }

  async introspect(): Promise<DatabaseSchema> {
    const schemaName = this.schemaName.toLowerCase();
    const catalog = this.catalog?.toLowerCase();
    const infoSchema = catalog ? `\`${catalog}\`.information_schema.columns` : "information_schema.columns";
    const predicates = ["table_schema = ?"];
    const binds: Scalar[] = [schemaName];
    if (catalog) {
      predicates.unshift("table_catalog = ?");
      binds.unshift(catalog);
    }
    const rows = await this.exec(
      `SELECT table_name, column_name, data_type, is_nullable
       FROM ${infoSchema}
       WHERE ${predicates.join(" AND ")}
       ORDER BY table_name, ordinal_position`,
      binds,
    );
    const tablesByName = new Map<string, TableInfo>();
    for (const row of rows) {
      const tableName = String(row["table_name"] ?? row["TABLE_NAME"]);
      let table = tablesByName.get(tableName);
      if (!table) {
        table = { schema: schemaName, name: tableName, columns: [] };
        tablesByName.set(tableName, table);
      }
      table.columns.push({
        name: String(row["column_name"] ?? row["COLUMN_NAME"]),
        dataType: String(row["data_type"] ?? row["DATA_TYPE"]),
        nullable: String(row["is_nullable"] ?? row["IS_NULLABLE"]).toUpperCase() === "YES",
      });
    }
    return {
      schemaName: databricksSchemaNamespace(this.connection),
      tables: [...tablesByName.values()],
      foreignKeys: [],
    };
  }

  async close(): Promise<void> {
    const session = this.session;
    const client = this.client;
    this.session = null;
    this.client = null;
    if (session) await session.close();
    if (client) await client.close();
  }
}
