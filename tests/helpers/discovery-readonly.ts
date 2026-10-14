/**
 * Prove discovery's warehouse session is read-only at the engine, not only
 * because we construct SELECT SQL. Uses the same session SQL / settings as
 * the connectors (`BEGIN TRANSACTION READ ONLY`, MySQL session read-only,
 * DuckDB `access_mode=READ_ONLY`, ClickHouse `readonly=1`).
 */
import pg from "pg";
import { POSTGRES_READ_ONLY_BEGIN } from "../../src/connectors/postgres/client.js";
import { MYSQL_SESSION_READONLY, MYSQL_POOL_DEFAULTS } from "../../src/connectors/mysql.js";
import { clickhouseQuerySettings } from "../../src/connectors/clickhouse.js";
import { isWriteSql } from "../../src/connectors/types.js";
import { createClickHouseClient } from "./clickhouse-live.js";
import type { CertSession } from "./cert-engine.js";

/** SELECT that is not caught by `isWriteSql` but is a write at the engine. */
export const SELECT_FOR_UPDATE = "SELECT id FROM customers FOR UPDATE LIMIT 1";

export function selectForUpdateIsNotWriteSql(): boolean {
  return isWriteSql(SELECT_FOR_UPDATE) === false;
}

export async function assertEngineRejectsWrite(session: CertSession): Promise<void> {
  switch (session.type) {
    case "postgres":
      await postgresReadOnlyRejectsWrite(session);
      return;
    case "mysql":
      await mysqlReadOnlyRejectsWrite(session);
      return;
    case "duckdb":
      await duckdbFileRejectsWrite(session);
      return;
    case "clickhouse":
      await clickhouseReadonlyRejectsWrite(session);
      return;
    default:
      throw new Error(`No engine-level write probe for ${session.type}`);
  }
}

async function postgresReadOnlyRejectsWrite(session: CertSession): Promise<void> {
  const url = session.readConnection().url;
  if (!url) throw new Error("postgres cert session has no url");
  const pool = new pg.Pool({ connectionString: url });
  const client = await pool.connect();
  try {
    await client.query(`SET search_path TO ${session.schemaName}`);
    await client.query(POSTGRES_READ_ONLY_BEGIN);
    try {
      await client.query("CREATE TABLE qa_discovery_write_probe (id INTEGER)");
      throw new Error("Postgres accepted CREATE TABLE inside BEGIN TRANSACTION READ ONLY");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/read-only|cannot execute/i.test(message)) throw err;
    }
    await client.query("ROLLBACK").catch(() => undefined);
  } finally {
    client.release();
    await pool.end();
  }
}

async function mysqlReadOnlyRejectsWrite(session: CertSession): Promise<void> {
  const url = session.readConnection().url;
  if (!url) throw new Error("mysql cert session has no url");
  const mysql = await import("mysql2/promise");
  const conn = await mysql.createConnection({ uri: url, ...MYSQL_POOL_DEFAULTS });
  try {
    await conn.query(`USE \`${session.schemaName}\``);
    await conn.query(MYSQL_SESSION_READONLY);
    try {
      await conn.query("CREATE TABLE qa_discovery_write_probe (id INT)");
      throw new Error("MySQL accepted CREATE TABLE after SET SESSION TRANSACTION READ ONLY");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errno = (err as { errno?: number }).errno;
      if (errno !== 1792 && errno !== 1290 && !/read.?only/i.test(message)) throw err;
    }
  } finally {
    await conn.end();
  }
}

async function duckdbFileRejectsWrite(session: CertSession): Promise<void> {
  const path = session.readConnection().path;
  if (!path || path === ":memory:") {
    throw new Error("DuckDB engine-level read-only requires a file database");
  }
  const mod = (await import("@duckdb/node-api")) as {
    DuckDBInstance: {
      create: (path: string, opts?: Record<string, string>) => Promise<{
        connect: () => Promise<{
          runAndReadAll: (sql: string) => Promise<unknown>;
          closeSync?: () => void;
        }>;
        closeSync?: () => void;
      }>;
    };
  };
  const instance = await mod.DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
  const conn = await instance.connect();
  try {
    try {
      await conn.runAndReadAll("CREATE TABLE qa_discovery_write_probe (id INTEGER)");
      throw new Error("DuckDB accepted CREATE TABLE with access_mode=READ_ONLY");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/accepted CREATE TABLE/.test(message)) throw err;
      if (!/read.?only|cannot|permission|write/i.test(message)) throw err;
    }
  } finally {
    conn.closeSync?.();
    instance.closeSync?.();
  }
}

async function clickhouseReadonlyRejectsWrite(session: CertSession): Promise<void> {
  const url = session.readConnection().url;
  if (!url) throw new Error("clickhouse cert session has no url");
  const client = await createClickHouseClient(url, session.schemaName);
  try {
    await client.query({
      query: "CREATE TABLE qa_discovery_write_probe (id Int32) ENGINE = Memory",
      clickhouse_settings: clickhouseQuerySettings(5_000),
    });
    throw new Error("ClickHouse accepted CREATE TABLE with readonly=1");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/accepted CREATE TABLE/.test(message)) throw err;
    if (!/readonly|Cannot execute|read-only|not allowed/i.test(message)) throw err;
  } finally {
    await client.close().catch(() => undefined);
  }
}
