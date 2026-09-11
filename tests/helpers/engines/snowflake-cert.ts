import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { cloudCertCredentialsAvailable } from "../../../src/certify/env.js";
import { rethrowCreateNamespaceFailure } from "../../../src/certify/errors.js";
import { newCertifySchemaName } from "../../../src/certify/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const SNOWFLAKE_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: false,
  timestamptz: true,
  fkIntrospection: true,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: true,
};

type SfConn = {
  connect: (cb: (err: Error | null) => void) => void;
  execute: (opts: {
    sqlText: string;
    complete: (err: Error | null, stmt: { getColumns?: () => { getName: () => string }[] }, rows?: Record<string, unknown>[]) => void;
  }) => void;
  destroy: (cb: (err: Error | null) => void) => void;
};

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function sfExec(conn: SfConn, sql: string): Promise<ExecutedRows> {
  return new Promise((resolve, reject) => {
    conn.execute({
      sqlText: sql,
      complete: (err, stmt, rows) => {
        if (err) return reject(err);
        const list = (rows ?? []) as Record<string, unknown>[];
        const columns = stmt.getColumns?.().map((c) => c.getName()) ?? Object.keys(list[0] ?? {});
        resolve({ columns, rows: list });
      },
    });
  });
}

export const snowflakeCertEngine: CertEngine = {
  type: "snowflake",
  capabilities: SNOWFLAKE_CERT_CAPABILITIES,
  async available() {
    return cloudCertCredentialsAvailable("snowflake").available;
  },
  async setup(): Promise<CertSession> {
    const creds = cloudCertCredentialsAvailable("snowflake");
    if (!creds.available) {
      throw new Error(`Snowflake cert env missing: ${creds.missing.join(", ")}`);
    }
    let createConnection: ((opts: Record<string, unknown>) => SfConn) | undefined;
    try {
      const mod = (await import("snowflake-sdk")) as {
        createConnection?: (opts: Record<string, unknown>) => SfConn;
        default?: { createConnection?: (opts: Record<string, unknown>) => SfConn };
      };
      createConnection = mod.createConnection ?? mod.default?.createConnection;
    } catch {
      throw new Error("Snowflake certification requires `npm install snowflake-sdk`.");
    }
    if (!createConnection) throw new Error("snowflake-sdk did not export createConnection.");
    const schemaName = newCertifySchemaName();
    const database = process.env.GRANE_CERT_SNOWFLAKE_DATABASE!;
    const conn = createConnection({
      account: process.env.GRANE_CERT_SNOWFLAKE_ACCOUNT,
      username: process.env.GRANE_CERT_SNOWFLAKE_USER,
      password: process.env.GRANE_CERT_SNOWFLAKE_PASSWORD,
      warehouse: process.env.GRANE_CERT_SNOWFLAKE_WAREHOUSE,
      database,
      role: process.env.GRANE_CERT_SNOWFLAKE_ROLE,
      application: "GraneCertify",
    });
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });
    try {
      await sfExec(conn, `CREATE SCHEMA ${q(schemaName)}`);
    } catch (err) {
      await new Promise<void>((resolve) => conn.destroy(() => resolve()));
      rethrowCreateNamespaceFailure("snowflake", schemaName, err);
    }
    await sfExec(conn, `USE SCHEMA ${q(database)}.${q(schemaName)}`);
    for (const stmt of ddl("snowflake")) {
      await sfExec(conn, stmt);
    }

    let engineVersion = "snowflake";
    try {
      const ver = await sfExec(conn, "SELECT CURRENT_VERSION() AS v");
      engineVersion = String(ver.rows[0]?.V ?? ver.rows[0]?.v ?? "snowflake");
    } catch {
      engineVersion = "snowflake";
    }

    const readConnection = (): ConnectionConfig => ({
      type: "snowflake",
      account: process.env.GRANE_CERT_SNOWFLAKE_ACCOUNT,
      user: process.env.GRANE_CERT_SNOWFLAKE_USER,
      password: process.env.GRANE_CERT_SNOWFLAKE_PASSWORD,
      warehouse: process.env.GRANE_CERT_SNOWFLAKE_WAREHOUSE,
      database,
      schema: schemaName,
      role: process.env.GRANE_CERT_SNOWFLAKE_ROLE,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "snowflake",
      schemaName,
      capabilities: SNOWFLAKE_CERT_CAPABILITIES,
      engineVersion,
      sessionSettings: { schema: schemaName, database, query_tag: "grane" },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await sfExec(conn, sql);
      },
      queryWrite: (sql) => sfExec(conn, sql),
      queryRead: (sql) => sfExec(conn, sql),
      async teardown() {
        try {
          await sfExec(conn, `DROP SCHEMA IF EXISTS ${q(database)}.${q(schemaName)} CASCADE`);
        } catch {
          // Best-effort drop of the isolated cert schema only.
        }
        await new Promise<void>((resolve) => conn.destroy(() => resolve()));
      },
    };
  },
};
