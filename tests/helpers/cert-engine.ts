import type { ConnectionConfig, GraneConfig, WarehouseType } from "../../src/config/schema.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import type { ExecutedRows } from "../../src/connectors/types.js";
import { bigqueryCertEngine } from "./engines/bigquery-cert.js";
import { clickhouseCertEngine } from "./engines/clickhouse-cert.js";
import { databricksCertEngine } from "./engines/databricks-cert.js";
import { duckdbCertEngine } from "./engines/duckdb-cert.js";
import { mysqlCertEngine } from "./engines/mysql-cert.js";
import { postgresCertEngine } from "./engines/postgres-cert.js";
import { redshiftCertEngine } from "./engines/redshift-cert.js";
import { snowflakeCertEngine } from "./engines/snowflake-cert.js";

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
  /**
   * Native `FILTER (WHERE …)` on aggregates. MySQL has none — the dialect
   * emits `CASE WHEN` instead. Corpus assertions must check the compiled SQL.
   */
  filterClause: boolean;
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

/**
 * Shared corpus adapters. Cloud engines return available()=false unless
 * GRANE_CERT_* is set — they never run in OSS CI.
 */
export const CERT_ENGINES: readonly CertEngine[] = [
  postgresCertEngine,
  duckdbCertEngine,
  mysqlCertEngine,
  clickhouseCertEngine,
  snowflakeCertEngine,
  bigqueryCertEngine,
  databricksCertEngine,
  redshiftCertEngine,
];

/**
 * Engines CI must run. `.github/workflows/ci.yml` sets
 * `GRANE_CERT_REQUIRE` to this list. Local `npm run test:unit` leaves the
 * variable unset so missing warehouses still skip.
 */
export const CI_REQUIRED_CERT_ENGINES = ["postgres", "duckdb", "mysql", "clickhouse"] as const;

export type LoadAvailableEnginesOptions = {
  engines?: readonly CertEngine[];
  /** When omitted, read `GRANE_CERT_REQUIRE`. Pass `[]` to require nothing. */
  require?: readonly string[];
  /** When omitted, read `GRANE_CERTIFY_ENGINE`. Empty string disables the filter. */
  only?: string;
};

export function parseRequiredCertEngines(
  raw: string | undefined = process.env.GRANE_CERT_REQUIRE,
): WarehouseType[] {
  if (!raw?.trim()) return [];
  const out: WarehouseType[] = [];
  for (const part of raw.split(",")) {
    const type = part.trim().toLowerCase();
    if (!type) continue;
    if (!(WAREHOUSE_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `GRANE_CERT_REQUIRE contains unknown engine "${part.trim()}". ` +
          `Expected one of: ${WAREHOUSE_TYPES.join(", ")}.`,
      );
    }
    if (!out.includes(type as WarehouseType)) out.push(type as WarehouseType);
  }
  return out;
}

function requireMessage(missing: string[]): string {
  return (
    `Required certification engine(s) unavailable: ${missing.join(", ")}. ` +
    `CI sets GRANE_CERT_REQUIRE=${CI_REQUIRED_CERT_ENGINES.join(",")} and must not skip these engines.`
  );
}

export async function loadAvailableEngines(
  opts: LoadAvailableEnginesOptions = {},
): Promise<CertEngine[]> {
  const only = (opts.only !== undefined ? opts.only : process.env.GRANE_CERTIFY_ENGINE)
    ?.trim()
    .toLowerCase();
  const requiredList =
    opts.require !== undefined ? [...opts.require] : parseRequiredCertEngines();
  const required = new Set(requiredList.map((type) => type.trim().toLowerCase()).filter(Boolean));
  for (const type of required) {
    if (!(WAREHOUSE_TYPES as readonly string[]).includes(type)) {
      throw new Error(
        `GRANE_CERT_REQUIRE contains unknown engine "${type}". ` +
          `Expected one of: ${WAREHOUSE_TYPES.join(", ")}.`,
      );
    }
  }
  const registry = opts.engines ?? CERT_ENGINES;
  const out: CertEngine[] = [];
  const missing: string[] = [];

  for (const engine of registry) {
    if (only && engine.type !== only) continue;
    let ok = false;
    try {
      ok = await engine.available();
    } catch (err) {
      if (required.has(engine.type)) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Required certification engine "${engine.type}" probe failed: ${detail}. ` +
            `CI sets GRANE_CERT_REQUIRE and must not skip these engines.`,
          { cause: err },
        );
      }
      continue;
    }
    if (ok) out.push(engine);
    else if (required.has(engine.type)) missing.push(engine.type);
  }

  if (!only) {
    for (const type of required) {
      if (!registry.some((engine) => engine.type === type) && !missing.includes(type)) {
        missing.push(type);
      }
    }
  }

  if (missing.length > 0) throw new Error(requireMessage(missing));
  return out;
}

export {
  bigqueryCertEngine,
  clickhouseCertEngine,
  databricksCertEngine,
  duckdbCertEngine,
  mysqlCertEngine,
  postgresCertEngine,
  redshiftCertEngine,
  snowflakeCertEngine,
};
