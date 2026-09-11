/**
 * Shared live-MySQL helpers for the certification corpus.
 *
 * Write URL: GRANE_MYSQL_WRITE_URL, then root/grane at 127.0.0.1:3306.
 * Read URL: GRANE_MYSQL_READ_URL, else the write host with user `grane_readonly`.
 */
import { MYSQL_POOL_DEFAULTS } from "../../src/connectors/mysql.js";

const WRITE_CANDIDATES = [
  process.env.GRANE_MYSQL_WRITE_URL,
  "mysql://root:grane@127.0.0.1:3306/grane_demo",
  "mysql://grane:grane@127.0.0.1:3306/grane_demo",
].filter((u): u is string => Boolean(u));

export const MYSQL_READONLY_USER = "grane_readonly";
export const MYSQL_READONLY_PASSWORD = "grane_readonly";

export interface MysqlLiveEnv {
  writeUrl: string;
  readUrl: string;
  version: string;
  timeZone: string;
  charset: string;
}

let cached: MysqlLiveEnv | null = null;
let probeFailed = false;

type MysqlConn = {
  query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
  end: () => Promise<void>;
};

type MysqlMod = {
  createConnection: (opts: Record<string, unknown>) => Promise<MysqlConn>;
  createPool: (opts: Record<string, unknown>) => {
    query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
    getConnection: () => Promise<{
      query: (sql: string, values?: unknown[]) => Promise<[unknown, unknown]>;
      release: () => void;
    }>;
    end: () => Promise<void>;
  };
};

async function loadMysql2(): Promise<MysqlMod | null> {
  try {
    return (await import("mysql2/promise")) as unknown as MysqlMod;
  } catch {
    return null;
  }
}

function rewriteUser(url: string, user: string, password: string): string {
  const parsed = new URL(url);
  parsed.username = user;
  parsed.password = password;
  return parsed.toString();
}

export function mysqlQuoteIdent(name: string): string {
  return `\`${name.replaceAll("`", "``")}\``;
}

export function withMysqlDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export async function mysqlLiveEnv(): Promise<MysqlLiveEnv | null> {
  if (cached) return cached;
  if (probeFailed) return null;
  const mysql = await loadMysql2();
  if (!mysql) {
    probeFailed = true;
    return null;
  }
  for (const writeUrl of WRITE_CANDIDATES) {
    let conn: MysqlConn | undefined;
    try {
      conn = await mysql.createConnection({
        uri: writeUrl,
        connectTimeout: 2000,
        ...MYSQL_POOL_DEFAULTS,
      });
      const [rows] = await conn.query(
        "SELECT VERSION() AS version, @@session.time_zone AS tz, @@character_set_server AS charset",
      );
      const row = (rows as { version: string; tz: string; charset: string }[])[0];
      if (!row) continue;
      const readUrl =
        process.env.GRANE_MYSQL_READ_URL ?? rewriteUser(writeUrl, MYSQL_READONLY_USER, MYSQL_READONLY_PASSWORD);
      cached = {
        writeUrl,
        readUrl,
        version: row.version,
        timeZone: row.tz,
        charset: row.charset,
      };
      return cached;
    } catch {
      // try next candidate
    } finally {
      await conn?.end().catch(() => undefined);
    }
  }
  probeFailed = true;
  return null;
}

export async function mysqlTimezoneTablesReady(url: string): Promise<boolean> {
  const mysql = await loadMysql2();
  if (!mysql) return false;
  const conn = await mysql.createConnection({ uri: url, connectTimeout: 2000, ...MYSQL_POOL_DEFAULTS });
  try {
    const [rows] = await conn.query(
      "SELECT CONVERT_TZ('2026-08-01 04:00:00', 'UTC', 'America/New_York') AS t",
    );
    const t = (rows as { t: unknown }[])[0]?.t;
    return t !== null && t !== undefined;
  } catch {
    return false;
  } finally {
    await conn.end().catch(() => undefined);
  }
}

export async function ensureMysqlReadonlyUser(writeUrl: string, database: string): Promise<void> {
  const mysql = await loadMysql2();
  if (!mysql) throw new Error("mysql2 is required for the MySQL certification adapter");
  const conn = await mysql.createConnection({ uri: writeUrl, ...MYSQL_POOL_DEFAULTS });
  try {
    await conn.query("SELECT GET_LOCK('grane_mysql_readonly', 10)");
    try {
      await conn.query(
        `CREATE USER IF NOT EXISTS '${MYSQL_READONLY_USER}'@'%' IDENTIFIED BY '${MYSQL_READONLY_PASSWORD}'`,
      );
      await conn.query(
        `CREATE USER IF NOT EXISTS '${MYSQL_READONLY_USER}'@'localhost' IDENTIFIED BY '${MYSQL_READONLY_PASSWORD}'`,
      );
      const db = mysqlQuoteIdent(database);
      await conn.query(`GRANT SELECT ON ${db}.* TO '${MYSQL_READONLY_USER}'@'%'`);
      await conn.query(`GRANT SELECT ON ${db}.* TO '${MYSQL_READONLY_USER}'@'localhost'`);
      await conn.query("FLUSH PRIVILEGES");
    } finally {
      await conn.query("SELECT RELEASE_LOCK('grane_mysql_readonly')").catch(() => undefined);
    }
  } finally {
    await conn.end();
  }
}

export function newMysqlCertDatabase(): string {
  return `mysqlcert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createMysqlPool(url: string) {
  const mysql = await loadMysql2();
  if (!mysql) throw new Error("mysql2 is required for the MySQL certification adapter");
  return mysql.createPool({ uri: url, connectionLimit: 5, ...MYSQL_POOL_DEFAULTS });
}
