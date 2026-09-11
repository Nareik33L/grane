import type { ConnectionConfig, GraneConfig, WarehouseType } from "../../src/config/schema.js";
import type { ExecutedRows } from "../../src/connectors/types.js";
import { clickhouseCertEngine } from "./engines/clickhouse-cert.js";
import { duckdbCertEngine } from "./engines/duckdb-cert.js";
import { mysqlCertEngine } from "./engines/mysql-cert.js";
import { postgresCertEngine } from "./engines/postgres-cert.js";

export type CertCapabilities = {
  /** SET TRANSACTION READ ONLY / equivalent on the Grane session. */
  readOnlyTransaction: boolean;
  /** Native timestamptz / TIMESTAMP WITH TIME ZONE. */
  timestamptz: boolean;
  /** information_schema / pg_catalog FK listing used by explore. */
  fkIntrospection: boolean;
  /** Dedicated `grane_readonly` role (Postgres live only). */
  postgresReadonlyRole: boolean;
  /** Tests may INSERT/DELETE mid-suite (Postgres write URL). DuckDB file is seeded once. */
  mutateSeed: boolean;
  /** Engine session default TZ is local rather than UTC (should be false after WS2 pins). */
  sessionTimezoneLocal: boolean;
  /** MCP + CLI live-warehouse round-trips are meaningful. */
  mcpCli: boolean;
};

export type CertSession = {
  type: WarehouseType;
  schemaName: string;
  capabilities: CertCapabilities;
  engineVersion: string;
  sessionSettings: Record<string, string>;
  readConnection(): ConnectionConfig;
  environment(): GraneConfig;
  execWrite(sql: string): Promise<void>;
  queryWrite(sql: string, params?: unknown[]): Promise<ExecutedRows>;
  queryRead(sql: string, params?: unknown[]): Promise<ExecutedRows>;
  teardown(): Promise<void>;
};

export type CertEngine = {
  readonly type: WarehouseType;
  readonly capabilities: CertCapabilities;
  available(): Promise<boolean>;
  setup(): Promise<CertSession>;
};

/** Engines that can run the corpus in this PR. Stubs return available()=false. */
export const CERT_ENGINES: readonly CertEngine[] = [
  postgresCertEngine,
  duckdbCertEngine,
  mysqlCertEngine,
  clickhouseCertEngine,
];

export async function loadAvailableEngines(): Promise<CertEngine[]> {
  const out: CertEngine[] = [];
  for (const engine of CERT_ENGINES) {
    if (await engine.available()) out.push(engine);
  }
  return out;
}

export { clickhouseCertEngine, duckdbCertEngine, mysqlCertEngine, postgresCertEngine };
