import pg from "pg";
import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { cloudCertCredentialsAvailable } from "../../../src/certify/env.js";
import { rethrowCreateNamespaceFailure } from "../../../src/certify/errors.js";
import { newCertifySchemaName } from "../../../src/certify/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const REDSHIFT_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: true,
  timestamptz: true,
  fkIntrospection: true,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: false,
};

function q(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Redshift is self_certifiable via this adapter and `grane certify --engine redshift`.
 * It does **not** use GRANE_PG_* and is not covered by Postgres CI certification.
 */
export const redshiftCertEngine: CertEngine = {
  type: "redshift",
  capabilities: REDSHIFT_CERT_CAPABILITIES,
  async available() {
    return cloudCertCredentialsAvailable("redshift").available;
  },
  async setup(): Promise<CertSession> {
    const creds = cloudCertCredentialsAvailable("redshift");
    if (!creds.available) {
      throw new Error(`Redshift cert env missing: ${creds.missing.join(", ")}`);
    }
    const url = process.env.GRANE_CERT_REDSHIFT_URL!;
    const schemaName = newCertifySchemaName();
    const pool = new pg.Pool({ connectionString: url, connectionTimeoutMillis: 10_000 });
    try {
      await pool.query(`CREATE SCHEMA ${q(schemaName)}`);
    } catch (err) {
      await pool.end().catch(() => undefined);
      rethrowCreateNamespaceFailure("redshift", schemaName, err);
    }
    await pool.query(`SET search_path TO ${q(schemaName)}`);
    for (const stmt of ddl("redshift")) {
      await pool.query(stmt);
    }

    let engineVersion = "redshift";
    try {
      const ver = await pool.query<{ v: string }>("SELECT version() AS v");
      engineVersion = ver.rows[0]?.v ?? "redshift";
    } catch {
      engineVersion = "redshift";
    }

    const withSearchPath = async (sql: string, params?: unknown[]): Promise<ExecutedRows> => {
      const client = await pool.connect();
      try {
        await client.query(`SET search_path TO ${q(schemaName)}`);
        const result = await client.query<Record<string, unknown>>(sql, params);
        return { columns: result.fields.map((f) => f.name), rows: result.rows };
      } finally {
        client.release();
      }
    };

    const readConnection = (): ConnectionConfig => ({
      type: "redshift",
      url,
      schema: schemaName,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "redshift",
      schemaName,
      capabilities: REDSHIFT_CERT_CAPABILITIES,
      engineVersion,
      sessionSettings: { schema: schemaName },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await withSearchPath(sql);
      },
      queryWrite: withSearchPath,
      queryRead: withSearchPath,
      async teardown() {
        try {
          await pool.query(`DROP SCHEMA IF EXISTS ${q(schemaName)} CASCADE`);
        } catch {
          // Best-effort drop of the isolated cert schema only.
        }
        await pool.end().catch(() => undefined);
      },
    };
  },
};
