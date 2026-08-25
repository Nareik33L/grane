import pg from "pg";
import type { ConnectionConfig } from "../../config/schema.js";
import { configError } from "../../errors.js";

const { Pool } = pg;

export function createPool(connection: ConnectionConfig): pg.Pool {
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

export type { Pool } from "pg";
