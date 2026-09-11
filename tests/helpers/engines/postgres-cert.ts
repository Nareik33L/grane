import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import {
  ensureReadonlyRole,
  grantReadonlyOnSchema,
  newCertSchema,
  postgresLiveEnv,
  PG_READONLY_USER,
} from "../postgres-live.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";
import pg from "pg";

export const POSTGRES_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: true,
  fkIntrospection: true,
  postgresReadonlyRole: true,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: true,
};

export const postgresCertEngine: CertEngine = {
  type: "postgres",
  capabilities: POSTGRES_CERT_CAPABILITIES,
  async available() {
    return (await postgresLiveEnv()) !== null;
  },
  async setup(): Promise<CertSession> {
    const live = await postgresLiveEnv();
    if (!live) throw new Error("PostgreSQL live environment is not available");
    await ensureReadonlyRole(live.writeUrl);
    const schemaName = newCertSchema();
    const writePool = new pg.Pool({ connectionString: live.writeUrl });
    await writePool.query(`CREATE SCHEMA ${schemaName}`);
    await writePool.query(`SET search_path TO ${schemaName}`);
    for (const stmt of ddl("postgres")) await writePool.query(stmt);
    await grantReadonlyOnSchema(writePool, schemaName);
    const readPool = new pg.Pool({ connectionString: live.readUrl });

    const withSearchPath = async (sql: string, params?: unknown[]): Promise<ExecutedRows> => {
      const client = await writePool.connect();
      try {
        await client.query(`SET search_path TO ${schemaName}`);
        const result = await client.query<Record<string, unknown>>(sql, params);
        return { columns: result.fields.map((f) => f.name), rows: result.rows };
      } finally {
        client.release();
      }
    };

    const readConnection = (): ConnectionConfig => ({
      type: "postgres",
      url: live.readUrl,
      schema: schemaName,
    });

    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "postgres",
      schemaName,
      capabilities: POSTGRES_CERT_CAPABILITIES,
      engineVersion: live.version,
      sessionSettings: {
        TimeZone: live.serverTimezone,
        DateStyle: live.dateStyle,
        lc_time: live.lcTime,
        server_encoding: live.serverEncoding,
        ssl: live.sslSupported,
        database: live.database,
        writeUser: live.writeUser,
        readUser: PG_READONLY_USER,
      },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await withSearchPath(sql);
      },
      queryWrite: withSearchPath,
      async queryRead(sql: string, params: unknown[] = []) {
        const result = await readPool.query<Record<string, unknown>>(sql, params);
        return { columns: result.fields.map((f) => f.name), rows: result.rows };
      },
      async teardown() {
        await readPool.end().catch(() => undefined);
        await writePool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
        await writePool.end().catch(() => undefined);
      },
    };
  },
};
