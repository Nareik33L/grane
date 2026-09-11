import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import {
  createMysqlPool,
  ensureMysqlReadonlyUser,
  MYSQL_READONLY_USER,
  mysqlLiveEnv,
  mysqlQuoteIdent,
  mysqlTimezoneTablesReady,
  newMysqlCertDatabase,
  withMysqlDatabase,
} from "../mysql-live.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const MYSQL_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: false,
  fkIntrospection: true,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: false,
};

type MysqlPool = Awaited<ReturnType<typeof createMysqlPool>>;

async function mysqlExec(pool: MysqlPool, sql: string, params?: unknown[]): Promise<ExecutedRows> {
  const [rows, fields] = params && params.length > 0 ? await pool.query(sql, params) : await pool.query(sql);
  const list = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  const columns = Array.isArray(fields)
    ? (fields as { name?: string }[]).map((f) => String(f.name ?? ""))
    : Object.keys(list[0] ?? {});
  return { columns, rows: list };
}

export const mysqlCertEngine: CertEngine = {
  type: "mysql",
  capabilities: MYSQL_CERT_CAPABILITIES,
  async available() {
    return (await mysqlLiveEnv()) !== null;
  },
  async setup(): Promise<CertSession> {
    const live = await mysqlLiveEnv();
    if (!live) {
      throw new Error(
        "MySQL 8 is not reachable. Set GRANE_MYSQL_WRITE_URL / GRANE_MYSQL_READ_URL, or run the mysql:8 CI service.",
      );
    }
    if (!(await mysqlTimezoneTablesReady(live.writeUrl))) {
      throw new Error(
        "MySQL timezone tables are not loaded (CONVERT_TZ returned NULL). " +
          "CI loads them with mysql_tzinfo_to_sql; see .github/workflows/ci.yml. " +
          "Named-zone localization cannot be certified without them.",
      );
    }
    const dbName = newMysqlCertDatabase();
    const writeUrl = withMysqlDatabase(live.writeUrl, dbName);
    const readUrl = withMysqlDatabase(live.readUrl, dbName);
    const admin = await createMysqlPool(live.writeUrl);
    try {
      await admin.query(
        `CREATE DATABASE ${mysqlQuoteIdent(dbName)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      );
    } finally {
      await admin.end();
    }
    await ensureMysqlReadonlyUser(live.writeUrl, dbName);

    const writePool = await createMysqlPool(writeUrl);
    for (const stmt of ddl("mysql")) {
      await writePool.query(stmt);
    }
    const readPool = await createMysqlPool(readUrl);

    const readConnection = (): ConnectionConfig => ({
      type: "mysql",
      url: readUrl,
      schema: dbName,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "mysql",
      schemaName: dbName,
      capabilities: MYSQL_CERT_CAPABILITIES,
      engineVersion: live.version,
      sessionSettings: {
        time_zone: live.timeZone,
        character_set_server: live.charset,
        database: dbName,
        writeUser: new URL(live.writeUrl).username,
        readUser: MYSQL_READONLY_USER,
      },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await writePool.query(sql);
      },
      queryWrite(sql, params) {
        return mysqlExec(writePool, sql, params);
      },
      queryRead(sql, params) {
        return mysqlExec(readPool, sql, params);
      },
      async teardown() {
        await readPool.end().catch(() => undefined);
        try {
          const drop = await createMysqlPool(live.writeUrl);
          try {
            await drop.query(`DROP DATABASE IF EXISTS ${mysqlQuoteIdent(dbName)}`);
          } finally {
            await drop.end().catch(() => undefined);
          }
        } catch {
          // Best-effort drop; the unique database name will not collide.
        }
        await writePool.end().catch(() => undefined);
      },
    };
  },
};
