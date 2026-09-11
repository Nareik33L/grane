import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import type { ExecutedRows } from "../../../src/connectors/types.js";
import { cloudCertCredentialsAvailable } from "../../../src/certify/env.js";
import { rethrowCreateNamespaceFailure } from "../../../src/certify/errors.js";
import { newCertifySchemaName } from "../../../src/certify/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

export const BIGQUERY_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: false,
  timestamptz: true,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: true,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: false,
};

type BqClient = {
  createDataset: (id: string, opts?: Record<string, unknown>) => Promise<unknown>;
  dataset: (id: string) => { delete: (opts?: Record<string, unknown>) => Promise<unknown> };
  query: (opts: Record<string, unknown>) => Promise<[Record<string, unknown>[]]>;
};

export const bigqueryCertEngine: CertEngine = {
  type: "bigquery",
  capabilities: BIGQUERY_CERT_CAPABILITIES,
  async available() {
    return cloudCertCredentialsAvailable("bigquery").available;
  },
  async setup(): Promise<CertSession> {
    const creds = cloudCertCredentialsAvailable("bigquery");
    if (!creds.available) {
      throw new Error(`BigQuery cert env missing: ${creds.missing.join(", ")}`);
    }
    let BigQuery: new (opts?: Record<string, unknown>) => BqClient;
    try {
      const mod = (await import("@google-cloud/bigquery")) as {
        BigQuery?: new (opts?: Record<string, unknown>) => BqClient;
        default?: { BigQuery?: new (opts?: Record<string, unknown>) => BqClient };
      };
      BigQuery = (mod.BigQuery ?? mod.default?.BigQuery)!;
    } catch {
      throw new Error("BigQuery certification requires `npm install @google-cloud/bigquery`.");
    }
    if (!BigQuery) throw new Error("@google-cloud/bigquery did not export BigQuery.");
    const project = process.env.GRANE_CERT_BIGQUERY_PROJECT!;
    const location = process.env.GRANE_CERT_BIGQUERY_LOCATION?.trim() || "US";
    const schemaName = newCertifySchemaName();
    const client = new BigQuery({
      projectId: project,
      keyFilename: process.env.GRANE_CERT_BIGQUERY_CREDENTIALS,
      location,
    });
    try {
      await client.createDataset(schemaName, {
        location,
        defaultTableExpirationMs: "86400000",
      });
    } catch (err) {
      rethrowCreateNamespaceFailure("bigquery", schemaName, err);
    }

    const jobOpts = {
      defaultDataset: { projectId: project, datasetId: schemaName },
      location,
      maximumBytesBilled: "10737418240",
    };
    for (const stmt of ddl("bigquery")) {
      await client.query({ query: stmt, ...jobOpts });
    }

    const queryDataset = async (sql: string): Promise<ExecutedRows> => {
      const [rows] = await client.query({ query: sql, ...jobOpts });
      return { columns: Object.keys(rows[0] ?? {}), rows };
    };

    const readConnection = (): ConnectionConfig => ({
      type: "bigquery",
      project,
      dataset: schemaName,
      location,
      credentials: process.env.GRANE_CERT_BIGQUERY_CREDENTIALS,
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "bigquery",
      schemaName,
      capabilities: BIGQUERY_CERT_CAPABILITIES,
      engineVersion: "bigquery",
      sessionSettings: { project, dataset: schemaName, location, maximumBytesBilled: "10737418240" },
      readConnection,
      environment,
      async execWrite(sql: string) {
        await client.query({ query: sql, ...jobOpts });
      },
      queryWrite: queryDataset,
      queryRead: queryDataset,
      async teardown() {
        try {
          await client.dataset(schemaName).delete({ force: true });
        } catch {
          // Best-effort drop of the isolated cert dataset only.
        }
      },
    };
  },
};
