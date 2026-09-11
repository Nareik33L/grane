import { WAREHOUSE_TYPES, type WarehouseType } from "../connectors/dialect.js";

/**
 * Credential environment for `grane certify`. Cloud engines (Snowflake,
 * BigQuery, Databricks, Redshift) read **only** `GRANE_CERT_*` — never
 * `GRANE_PG_*`. Postgres certification does not cover Redshift.
 *
 * This module is the single source of truth; `docs/certify.md` must contain
 * `certEnvContractMarkdown()`.
 */
export type CertEnvVar = {
  name: string;
  required: boolean;
  description: string;
};

export type CertEngineEnvContract = {
  type: WarehouseType;
  /** Isolated namespace kind created for the run. */
  namespace: "schema" | "database" | "dataset" | "file";
  vars: readonly CertEnvVar[];
  notes: string;
};

const snowflake: CertEngineEnvContract = {
  type: "snowflake",
  namespace: "schema",
  vars: [
    { name: "GRANE_CERT_SNOWFLAKE_ACCOUNT", required: true, description: "Account identifier (e.g. xy12345.us-east-1)" },
    { name: "GRANE_CERT_SNOWFLAKE_USER", required: true, description: "User that can CREATE SCHEMA" },
    { name: "GRANE_CERT_SNOWFLAKE_PASSWORD", required: true, description: "Password" },
    { name: "GRANE_CERT_SNOWFLAKE_WAREHOUSE", required: true, description: "Warehouse" },
    { name: "GRANE_CERT_SNOWFLAKE_DATABASE", required: true, description: "Database that will own `grane_cert_<runid>`" },
    { name: "GRANE_CERT_SNOWFLAKE_ROLE", required: false, description: "Role (optional)" },
  ],
  notes: "Creates and drops schema `grane_cert_<runid>`. QUERY_TAG=grane and STATEMENT_TIMEOUT come from limits.",
};

const bigquery: CertEngineEnvContract = {
  type: "bigquery",
  namespace: "dataset",
  vars: [
    { name: "GRANE_CERT_BIGQUERY_PROJECT", required: true, description: "GCP project id" },
    { name: "GRANE_CERT_BIGQUERY_LOCATION", required: false, description: "Location (default US)" },
    { name: "GRANE_CERT_BIGQUERY_CREDENTIALS", required: false, description: "Service-account JSON key path; else ADC / GOOGLE_APPLICATION_CREDENTIALS" },
  ],
  notes: "Creates and drops dataset `grane_cert_<runid>` (1-day table expiration). Jobs set maximumBytesBilled from limits.max_bytes_billed (default 10 GiB).",
};

const databricks: CertEngineEnvContract = {
  type: "databricks",
  namespace: "schema",
  vars: [
    { name: "GRANE_CERT_DATABRICKS_HOST", required: true, description: "Workspace host (xxx.cloud.databricks.com)" },
    { name: "GRANE_CERT_DATABRICKS_HTTP_PATH", required: true, description: "SQL warehouse HTTP path" },
    { name: "GRANE_CERT_DATABRICKS_TOKEN", required: true, description: "PAT / service-principal token that can CREATE SCHEMA" },
    { name: "GRANE_CERT_DATABRICKS_CATALOG", required: false, description: "Unity Catalog (default main)" },
  ],
  notes: "Creates and drops schema `grane_cert_<runid>`. queryTimeout is limits.timeout_ms in seconds.",
};

const redshift: CertEngineEnvContract = {
  type: "redshift",
  namespace: "schema",
  vars: [
    { name: "GRANE_CERT_REDSHIFT_URL", required: true, description: "postgres:// user with CREATE SCHEMA (pg driver)" },
  ],
  notes: "Creates and drops schema `grane_cert_<runid>`. Uses ddl('redshift') and the Redshift dialect (CASE WHEN, not FILTER). Postgres CI certification does not cover Redshift.",
};

/** Cloud engines that are never live in OSS CI. */
export const CLOUD_CERT_ENGINES = ["snowflake", "bigquery", "databricks", "redshift"] as const;
export type CloudCertEngine = (typeof CLOUD_CERT_ENGINES)[number];

export const CERT_ENV_CONTRACT: Record<CloudCertEngine, CertEngineEnvContract> = {
  snowflake,
  bigquery,
  databricks,
  redshift,
};

const CI_ENGINE_NOTES: Partial<Record<WarehouseType, string>> = {
  postgres: "GRANE_PG_WRITE_URL / GRANE_PG_READ_URL (CI postgres:16). Isolated schema `grane_cert_<runid>`.",
  mysql: "GRANE_MYSQL_WRITE_URL / GRANE_MYSQL_READ_URL plus timezone tables. Isolated database `grane_cert_<runid>`.",
  clickhouse: "GRANE_CLICKHOUSE_URL (CI clickhouse:24). Isolated database `grane_cert_<runid>`.",
  duckdb: "No env. Requires `@duckdb/node-api`. Isolated temp file; never opens an adopter database.",
};

export function isCloudCertEngine(type: string): type is CloudCertEngine {
  return (CLOUD_CERT_ENGINES as readonly string[]).includes(type);
}

export function requiredCertEnvVars(type: CloudCertEngine): string[] {
  return CERT_ENV_CONTRACT[type].vars.filter((v) => v.required).map((v) => v.name);
}

export function missingCertEnvVars(type: CloudCertEngine, env: NodeJS.Dict<string> = process.env): string[] {
  return requiredCertEnvVars(type).filter((name) => !env[name]?.trim());
}

export function cloudCertCredentialsAvailable(
  type: CloudCertEngine,
  env: NodeJS.Dict<string> = process.env,
): { available: boolean; missing: string[] } {
  const missing = missingCertEnvVars(type, env);
  return { available: missing.length === 0, missing };
}

export function parseWarehouseType(value: string): WarehouseType {
  const type = value.trim().toLowerCase();
  if (!(WAREHOUSE_TYPES as readonly string[]).includes(type)) {
    throw new Error(
      `Unknown engine "${value}". Expected one of: ${WAREHOUSE_TYPES.join(", ")}.`,
    );
  }
  return type as WarehouseType;
}

/** Markdown tables for docs/certify.md. */
export function certEnvContractMarkdown(): string {
  const lines = [
    "| Engine | Required | Optional | Isolated namespace |",
    "| --- | --- | --- | --- |",
  ];
  for (const type of CLOUD_CERT_ENGINES) {
    const entry = CERT_ENV_CONTRACT[type];
    const required = entry.vars.filter((v) => v.required).map((v) => `\`${v.name}\``).join(", ");
    const optional = entry.vars.filter((v) => !v.required).map((v) => `\`${v.name}\``);
    lines.push(
      `| \`${type}\` | ${required} | ${optional.length ? optional.join(", ") : "—"} | ${entry.namespace} \`grane_cert_<runid>\` |`,
    );
  }
  const details: string[] = [];
  for (const type of CLOUD_CERT_ENGINES) {
    const entry = CERT_ENV_CONTRACT[type];
    details.push(`### \`${type}\``, "", entry.notes, "");
    details.push("| Variable | Required | Purpose |", "| --- | --- | --- |");
    for (const v of entry.vars) {
      details.push(`| \`${v.name}\` | ${v.required ? "yes" : "no"} | ${v.description} |`);
    }
    details.push("");
  }
  details.push("### CI-certified engines (not `GRANE_CERT_*`)", "");
  for (const [type, note] of Object.entries(CI_ENGINE_NOTES)) {
    details.push(`- \`${type}\`: ${note}`);
  }
  details.push(
    "",
    "CI sets `GRANE_CERT_REQUIRE=postgres,duckdb,mysql,clickhouse`. `loadAvailableEngines` throws if a required engine is unavailable (no silent skip). Unset locally so missing warehouses still skip. Cloud engines are unchanged.",
  );
  details.push("");
  return `${lines.join("\n")}\n\n${details.join("\n")}`;
}

export function skipMissingCloudEnvMessage(type: CloudCertEngine, missing: string[]): string {
  return (
    `Skipping ${type} certification: unset ${missing.join(", ")}. ` +
    `Cloud engines are self_certifiable and do not run in OSS CI. ` +
    `See docs/certify.md.`
  );
}
