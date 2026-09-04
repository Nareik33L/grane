/**
 * Shared live-PostgreSQL helpers for the #36 certification corpus.
 *
 * Write URL (owner/setup): GRANE_PG_WRITE_URL, then 127.0.0.1:5432, then
 * Docker demo localhost:5433.
 * Read URL (Grane runtime): GRANE_PG_READ_URL, else the write host with
 * user `grane_readonly`.
 */
import pg from "pg";

const WRITE_CANDIDATES = [
  process.env.GRANE_PG_WRITE_URL,
  "postgres://grane:grane@127.0.0.1:5432/grane_demo",
  "postgres://grane:grane@localhost:5433/grane_demo",
].filter((u): u is string => Boolean(u));

export const PG_READONLY_USER = "grane_readonly";
export const PG_READONLY_PASSWORD = "grane_readonly";

export interface PostgresLiveEnv {
  writeUrl: string;
  readUrl: string;
  version: string;
  serverTimezone: string;
  dateStyle: string;
  lcTime: string;
  serverEncoding: string;
  sslSupported: string;
  clientSsl: boolean;
  database: string;
  writeUser: string;
}

let cached: PostgresLiveEnv | null = null;
let probeFailed = false;

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function rewriteUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export async function postgresLiveEnv(): Promise<PostgresLiveEnv | null> {
  if (cached) return cached;
  if (probeFailed) return null;
  for (const writeUrl of WRITE_CANDIDATES) {
    const pool = new pg.Pool({ connectionString: writeUrl, connectionTimeoutMillis: 2000 });
    try {
      const client = await pool.connect();
      try {
        const info = await client.query<{
          version: string;
          timezone: string;
          datestyle: string;
          lc_time: string;
          encoding: string;
          ssl: string;
          db: string;
          usr: string;
          client_ssl: boolean | null;
        }>(
          `SELECT
             version() AS version,
             current_setting('TimeZone') AS timezone,
             current_setting('DateStyle') AS datestyle,
             current_setting('lc_time') AS lc_time,
             current_setting('server_encoding') AS encoding,
             current_setting('ssl') AS ssl,
             current_database() AS db,
             current_user AS usr,
             (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS client_ssl`,
        );
        const row = info.rows[0]!;
        const readUrl = process.env.GRANE_PG_READ_URL ?? rewriteUser(writeUrl, PG_READONLY_USER, PG_READONLY_PASSWORD);
        cached = {
          writeUrl,
          readUrl,
          version: row.version,
          serverTimezone: row.timezone,
          dateStyle: row.datestyle,
          lcTime: row.lc_time,
          serverEncoding: row.encoding,
          sslSupported: row.ssl,
          clientSsl: Boolean(row.client_ssl),
          database: row.db,
          writeUser: row.usr,
        };
        return cached;
      } finally {
        client.release();
      }
    } catch {
      // try next candidate
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
  probeFailed = true;
  return null;
}

/**
 * Create the restricted runtime role if needed and grant CONNECT.
 * Uses an advisory lock so parallel vitest files cannot race CREATE ROLE.
 */
export async function ensureReadonlyRole(writeUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: writeUrl });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(361036)");
    try {
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${PG_READONLY_USER}') THEN
            CREATE ROLE ${PG_READONLY_USER} LOGIN PASSWORD '${PG_READONLY_PASSWORD}'
              NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
          END IF;
        END$$;
      `);
      const db = (await client.query<{ d: string }>("SELECT current_database() AS d")).rows[0]!.d;
      await client.query(`GRANT CONNECT ON DATABASE ${quoteIdent(db)} TO ${PG_READONLY_USER}`);
    } finally {
      await client.query("SELECT pg_advisory_unlock(361036)");
    }
  } finally {
    client.release();
    await pool.end();
  }
}

export async function grantReadonlyOnSchema(writePool: pg.Pool, schema: string): Promise<void> {
  await writePool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${PG_READONLY_USER}`);
  await writePool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${PG_READONLY_USER}`);
  await writePool.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT SELECT ON TABLES TO ${PG_READONLY_USER}`,
  );
  await writePool.query(`REVOKE CREATE ON SCHEMA ${schema} FROM PUBLIC`);
  await writePool.query(`REVOKE CREATE ON SCHEMA ${schema} FROM ${PG_READONLY_USER}`);
}

export function newCertSchema(): string {
  return `pgcert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
