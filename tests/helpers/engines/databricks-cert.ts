import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { cloudCertCredentialsAvailable } from "../../../src/certify/env.js";
import { rethrowCreateNamespaceFailure } from "../../../src/certify/errors.js";
import { newCertifySchemaName } from "../../../src/certify/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const DATABRICKS_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: false,
  timestamptz: true,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: true,
};

type DbSession = {
  executeStatement: (
    sql: string,
    opts?: Record<string, unknown>,
  ) => Promise<{ fetchAll: () => Promise<Record<string, unknown>[]>; close: () => Promise<void> }>;
  close: () => Promise<void>;
};

function q(name: string): string {
  return `\`${name.replace(/`/g, "``")}\``;
}

function stripHost(value: string): string {
  return value.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

async function dbExec(session: DbSession, sql: string): Promise<ExecutedRows> {
  const op = await session.executeStatement(sql, { runAsync: true });
  try {
    const rows = (await op.fetchAll()) ?? [];
    return { columns: Object.keys(rows[0] ?? {}), rows };
  } finally {
    await op.close();
  }
}

export const databricksCertEngine: CertEngine = {
  type: "databricks",
  capabilities: DATABRICKS_CERT_CAPABILITIES,
  async available() {
    return cloudCertCredentialsAvailable("databricks").available;
  },
  async setup(): Promise<CertSession> {
    const creds = cloudCertCredentialsAvailable("databricks");
    if (!creds.available) {
      throw new Error(`Databricks cert env missing: ${creds.missing.join(", ")}`);
    }
    let DBSQLClient: new () => {
      connect: (opts: Record<string, unknown>) => Promise<unknown>;
      openSession: (opts?: Record<string, unknown>) => Promise<DbSession>;
      close: () => Promise<void>;
    };
    try {
      const mod = (await import("@databricks/sql")) as {
        DBSQLClient?: typeof DBSQLClient;
        default?: { DBSQLClient?: typeof DBSQLClient };
      };
      DBSQLClient = (mod.DBSQLClient ?? mod.default?.DBSQLClient)!;
    } catch {
      throw new Error("Databricks certification requires `npm install @databricks/sql`.");
    }
    if (!DBSQLClient) throw new Error("@databricks/sql did not export DBSQLClient.");
    const catalog = process.env.GRANE_CERT_DATABRICKS_CATALOG?.trim() || "main";
    const schemaName = newCertifySchemaName();
    const client = new DBSQLClient();
    await client.connect({
      host: stripHost(process.env.GRANE_CERT_DATABRICKS_HOST!),
      path: process.env.GRANE_CERT_DATABRICKS_HTTP_PATH,
      token: process.env.GRANE_CERT_DATABRICKS_TOKEN,
      userAgentEntry: "GraneCertify",
    });
    const session = await client.openSession({ initialCatalog: catalog });
    try {
      await dbExec(session, `CREATE SCHEMA ${q(catalog)}.${q(schemaName)}`);
    } catch (err) {
      await session.close().catch(() => undefined);
      await client.close().catch(() => undefined);
      rethrowCreateNamespaceFailure("databricks", schemaName, err);
    }
    await dbExec(session, `USE SCHEMA ${q(catalog)}.${q(schemaName)}`);
    for (const stmt of ddl("databricks")) {
      await dbExec(session, stmt);
    }

    const readConnection = (): ConnectionConfig => ({
      type: "databricks",
      host: process.env.GRANE_CERT_DATABRICKS_HOST,
      http_path: process.env.GRANE_CERT_DATABRICKS_HTTP_PATH,
      token: process.env.GRANE_CERT_DATABRICKS_TOKEN,
      catalog,
      schema: schemaName,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "databricks",
      schemaName,
      capabilities: DATABRICKS_CERT_CAPABILITIES,
      engineVersion: "databricks",
      sessionSettings: { catalog, schema: schemaName },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await dbExec(session, sql);
      },
      queryWrite: (sql) => dbExec(session, sql),
      queryRead: (sql) => dbExec(session, sql),
      async teardown() {
        try {
          await dbExec(session, `DROP SCHEMA IF EXISTS ${q(catalog)}.${q(schemaName)} CASCADE`);
        } catch {
          // Best-effort drop of the isolated cert schema only.
        }
        await session.close().catch(() => undefined);
        await client.close().catch(() => undefined);
      },
    };
  },
};
