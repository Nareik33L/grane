import type { ConnectionConfig } from "../config/schema.js";
import { configError } from "../errors.js";
import { PostgresConnector } from "./postgres/client.js";
import { MysqlConnector } from "./mysql.js";
import { SnowflakeConnector } from "./snowflake.js";
import { BigQueryConnector, bigquerySchemaNamespace } from "./bigquery.js";
import { DuckDbConnector } from "./duckdb.js";
import { ClickHouseConnector } from "./clickhouse.js";
import { DatabricksConnector, databricksSchemaNamespace } from "./databricks.js";
import type { WarehouseConnector } from "./types.js";
import type { WarehouseType } from "./dialect.js";
import { getDialect } from "./dialect.js";

export function createConnector(connection: ConnectionConfig): WarehouseConnector {
  const type = connection.type as WarehouseType;
  switch (type) {
    case "postgres":
      return new PostgresConnector(connection, false);
    case "redshift":
      return new PostgresConnector(connection, true);
    case "mysql":
      return new MysqlConnector(connection);
    case "snowflake":
      return new SnowflakeConnector(connection);
    case "bigquery":
      return new BigQueryConnector(connection);
    case "duckdb":
      return new DuckDbConnector(connection);
    case "clickhouse":
      return new ClickHouseConnector(connection);
    case "databricks":
      return new DatabricksConnector(connection);
    default:
      throw configError(
        `Unknown warehouse type "${String(type)}". Supported: postgres, mysql, snowflake, bigquery, duckdb, clickhouse, redshift, databricks.`,
      );
  }
}

export function compilerNamespace(connection: ConnectionConfig): string | undefined {
  if (connection.type === "bigquery") return bigquerySchemaNamespace(connection);
  if (connection.type === "databricks") return databricksSchemaNamespace(connection);
  if (connection.type === "duckdb") {
    return connection.schema && connection.schema !== "main" ? connection.schema : undefined;
  }
  if (connection.type === "mysql") return connection.schema || connection.database;
  if (connection.type === "clickhouse") return connection.schema || connection.database || "default";
  if (connection.type === "snowflake") return connection.schema || "PUBLIC";
  return connection.schema || "public";
}

export { getDialect };
export type { WarehouseConnector } from "./types.js";
