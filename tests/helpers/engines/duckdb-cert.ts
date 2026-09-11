import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionConfig, GraneConfig } from "../../../src/config/schema.js";
import { certConfig } from "../../fixtures/pg-cert.js";
import { ddl } from "../../certification/ddl.js";
import type { CertCapabilities, CertEngine, CertSession } from "../cert-engine.js";

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string, opts?: Record<string, string>) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
        runAndReadAll?: (sql: string) => Promise<{
          getRowObjectsJS?: () => Record<string, unknown>[];
          getRowObjects?: () => Record<string, unknown>[];
        }>;
        closeSync?: () => void;
        disconnectSync?: () => void;
      }>;
      closeSync?: () => void;
    }>;
  };
};

export const DUCKDB_CERT_CAPABILITIES: CertCapabilities = {
  readOnlyTransaction: false,
  timestamptz: true,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: false,
  sessionTimezoneLocal: false,
  mcpCli: true,
  filterClause: true,
};

export const duckdbCertEngine: CertEngine = {
  type: "duckdb",
  capabilities: DUCKDB_CERT_CAPABILITIES,
  async available() {
    try {
      await import("@duckdb/node-api");
      return true;
    } catch {
      return false;
    }
  },
  async setup(): Promise<CertSession> {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    const dir = mkdtempSync(join(tmpdir(), "grane-cert-duck-"));
    const path = join(dir, "corpus.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    let engineVersion = "duckdb";
    try {
      const reader = await conn.runAndReadAll?.("SELECT version() AS v");
      const row = reader?.getRowObjectsJS?.()?.[0] ?? reader?.getRowObjects?.()?.[0];
      if (row?.v) engineVersion = String(row.v);
    } catch {
      engineVersion = "duckdb";
    }
    for (const stmt of ddl("duckdb")) await conn.run(stmt);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();

    const readConnection = (): ConnectionConfig => ({
      type: "duckdb",
      path,
      schema: "main",
    });
    const environment = (): GraneConfig => certConfig({ connection: readConnection() });

    return {
      type: "duckdb",
      schemaName: "main",
      capabilities: DUCKDB_CERT_CAPABILITIES,
      engineVersion,
      sessionSettings: {
        TimeZone: "UTC",
        access_mode: "READ_ONLY",
      },
      readConnection,
      environment,
      async execWrite() {
        throw new Error("DuckDB certification session is file-seeded; mutateSeed is false");
      },
      async queryWrite() {
        throw new Error("DuckDB certification session has no write oracle connection");
      },
      async queryRead() {
        throw new Error("DuckDB certification reads go through Grane, not a side channel");
      },
      async teardown() {
        rmSync(dir, { recursive: true, force: true });
      },
    };
  },
};
