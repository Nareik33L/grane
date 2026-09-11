import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import {
  CLICKHOUSE_WRITE_SETTINGS,
  clickhouseExec,
  clickhouseLiveEnv,
  clickhouseReadSettings,
  createClickHouseClient,
  newClickhouseCertDatabase,
} from "../clickhouse-live.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const CLICKHOUSE_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: false,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: false,
};

export const clickhouseCertEngine: CertEngine = {
  type: "clickhouse",
  capabilities: CLICKHOUSE_CERT_CAPABILITIES,
  async available() {
    return (await clickhouseLiveEnv()) !== null;
  },
  async setup(): Promise<CertSession> {
    const live = await clickhouseLiveEnv();
    if (!live) {
      throw new Error(
        "ClickHouse is not reachable. Set GRANE_CLICKHOUSE_URL or run the clickhouse-server CI service.",
      );
    }
    const dbName = newClickhouseCertDatabase();
    const admin = await createClickHouseClient(live.url);
    try {
      await admin.command({ query: `CREATE DATABASE IF NOT EXISTS ${dbName}` });
    } finally {
      await admin.close();
    }

    const writeClient = await createClickHouseClient(live.url, dbName);
    for (const stmt of ddl("clickhouse")) {
      await writeClient.command({ query: stmt, clickhouse_settings: CLICKHOUSE_WRITE_SETTINGS });
    }
    const readClient = await createClickHouseClient(live.url, dbName);

    const readConnection = (): ConnectionConfig => ({
      type: "clickhouse",
      url: live.url,
      schema: dbName,
      database: dbName,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "clickhouse",
      schemaName: dbName,
      capabilities: CLICKHOUSE_CERT_CAPABILITIES,
      engineVersion: live.version,
      sessionSettings: {
        timezone: live.timezone,
        join_use_nulls: "1",
        readonly: "1",
        session_timezone: "UTC",
        aggregate_functions_null_for_empty: "1",
        database: dbName,
      },
      readConnection,
      environment,
      async execWrite(sql: string) {
        let rewritten = sql.replace(/\bDATE\s+'(\d{4}-\d{2}-\d{2})'/gi, (_m, d: string) => `toDate('${d}')`);
        rewritten = rewritten.replace(
          /^DELETE FROM\s+(`[^`]+`|[A-Za-z_][\w]*)\s+WHERE/i,
          "ALTER TABLE $1 DELETE WHERE",
        );
        await writeClient.command({ query: rewritten, clickhouse_settings: CLICKHOUSE_WRITE_SETTINGS });
      },
      queryWrite(sql, params) {
        return clickhouseExec(writeClient, sql, params, CLICKHOUSE_WRITE_SETTINGS);
      },
      queryRead(sql, params) {
        return clickhouseExec(readClient, sql, params, clickhouseReadSettings());
      },
      async teardown() {
        await readClient.close().catch(() => undefined);
        try {
          const drop = await createClickHouseClient(live.url);
          try {
            await drop.command({ query: `DROP DATABASE IF EXISTS ${dbName}` });
          } finally {
            await drop.close().catch(() => undefined);
          }
        } catch {
          // Best-effort drop; the unique database name will not collide.
        }
        await writeClient.close().catch(() => undefined);
      },
    };
  },
};
