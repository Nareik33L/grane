import { WAREHOUSE_TYPES, type WarehouseType } from "./dialect.js";

/** How far Grane itself has taken a warehouse through the shared corpus. */
export type CertificationState = "certified" | "self_certifiable" | "compile_only";

export const CERTIFICATION_STATES: readonly CertificationState[] = [
  "certified",
  "self_certifiable",
  "compile_only",
];

export type WarehouseCertification = {
  type: WarehouseType;
  /** Display name used in docs / README. */
  label: string;
  certification: CertificationState;
  /** Minimum version the shared corpus is known to pass in CI, when certified. */
  certified_version: string | null;
  /** One-line explanation for `grane validate --production`. */
  explanation: string;
};

/**
 * Static certification map. `certified` is only for engines whose shared
 * corpus actually runs in GitHub Actions CI. Do not mark an engine certified
 * because a connector exists.
 */
export const WAREHOUSE_CERTIFICATION: Record<WarehouseType, WarehouseCertification> = {
  postgres: {
    type: "postgres",
    label: "PostgreSQL",
    certification: "certified",
    certified_version: "16",
    explanation: "Shared corpus runs in CI against PostgreSQL 16.",
  },
  duckdb: {
    type: "duckdb",
    label: "DuckDB",
    certification: "certified",
    certified_version: "1.5",
    explanation: "Shared corpus runs in CI with @duckdb/node-api (devDependency).",
  },
  mysql: {
    type: "mysql",
    label: "MySQL",
    certification: "certified",
    certified_version: "8",
    explanation:
      "Shared corpus runs in CI against MySQL 8 (mysql:8.4). MariaDB is not CI-certified.",
  },
  clickhouse: {
    type: "clickhouse",
    label: "ClickHouse",
    certification: "certified",
    certified_version: "24",
    explanation: "Shared corpus runs in CI against ClickHouse 24.",
  },
  snowflake: {
    type: "snowflake",
    label: "Snowflake",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Connector ships; Grane CI has no Snowflake warehouse. Self-certify with `grane certify --engine snowflake`.",
  },
  bigquery: {
    type: "bigquery",
    label: "BigQuery",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Connector ships; Grane CI has no BigQuery project. Self-certify with `grane certify --engine bigquery`.",
  },
  redshift: {
    type: "redshift",
    label: "Amazon Redshift",
    certification: "self_certifiable",
    certified_version: null,
    explanation:
      "Postgres driver compiles and executes; Postgres CI certification does not cover Redshift. Self-certify with `grane certify --engine redshift`.",
  },
  databricks: {
    type: "databricks",
    label: "Databricks",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Connector ships; Grane CI has no Databricks warehouse. Self-certify with `grane certify --engine databricks`.",
  },
};

export type WarehouseServerInfo = {
  type: WarehouseType;
  certification: CertificationState;
  certified_version: string | null;
};

export function warehouseCertification(type: WarehouseType): WarehouseCertification {
  return WAREHOUSE_CERTIFICATION[type];
}

export function warehouseServerInfo(type: WarehouseType): WarehouseServerInfo {
  const entry = WAREHOUSE_CERTIFICATION[type];
  return {
    type: entry.type,
    certification: entry.certification,
    certified_version: entry.certified_version,
  };
}

/** One-line warning when the configured engine is not `certified`. Null if it is. */
export function uncertifiedWarehouseWarning(type: WarehouseType): string | null {
  const entry = WAREHOUSE_CERTIFICATION[type];
  if (entry.certification === "certified") return null;
  return `${type} is ${entry.certification}, not certified. ${entry.explanation}`;
}

/** User-facing category for each map state (docs / release language). */
export const CERTIFICATION_CATEGORY: Record<CertificationState, string> = {
  certified: "runtime-certified",
  self_certifiable: "compile-supported",
  compile_only: "not yet certified",
};

const STATE_MEANING: Record<CertificationState, string> = {
  certified: "runtime-certified — shared corpus runs in Grane CI.",
  self_certifiable:
    "compile-supported — connector ships and compiles; not yet runtime-certified. Self-certify with `grane certify`. Cloud warehouses stay here until a credentialed certify-cloud run passes.",
  compile_only: "not yet certified — SQL is compiled for this dialect; live execution is not a Grane-certified path.",
};

/** Markdown tables for docs/warehouses.md. Single source of truth with the map. */
export function warehouseCertificationMarkdown(): string {
  const legend = [
    "| State | Meaning |",
    "| --- | --- |",
    ...CERTIFICATION_STATES.map((state) => `| \`${state}\` | ${STATE_MEANING[state]} |`),
  ].join("\n");
  const rows = WAREHOUSE_TYPES.map((type) => {
    const entry = WAREHOUSE_CERTIFICATION[type];
    const version = entry.certified_version ?? "—";
    return `| ${entry.label} | \`${type}\` | \`${entry.certification}\` | ${version} |`;
  });
  const engines = [
    "| Warehouse | `connection.type` | State | Minimum certified version |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
  return `${legend}\n\n${engines}`;
}

/** Plain README status for each map state. Cloud connectors stay uncertified until a credentialed run. */
export function readmeWarehouseStatus(entry: WarehouseCertification): string {
  switch (entry.certification) {
    case "certified":
      return "Certified";
    case "self_certifiable":
      return "Not yet tested / not certified";
    case "compile_only":
      return "Not yet certified";
  }
}

/**
 * README warehouse matrix generated from the map so a "Certified" cell cannot
 * appear for an engine the map does not mark `certified`.
 */
export function readmeCertificationMatrix(): string {
  const header = ["| Warehouse | `connection.type` | Status |", "| --- | --- | --- |"];
  const rows = WAREHOUSE_TYPES.map((type) => {
    const entry = WAREHOUSE_CERTIFICATION[type];
    const name =
      entry.certification === "certified" && entry.certified_version
        ? `${entry.label} ${entry.certified_version}`
        : entry.label;
    return `| ${name} | \`${type}\` | ${readmeWarehouseStatus(entry)} |`;
  });
  return [...header, ...rows].join("\n");
}

/** README one-liner generated from the map so the certified list cannot drift. */
export function readmeCertificationLine(): string {
  const certified = WAREHOUSE_TYPES.filter((type) => WAREHOUSE_CERTIFICATION[type].certification === "certified").map(
    (type) => {
      const entry = WAREHOUSE_CERTIFICATION[type];
      return `${entry.label} ${entry.certified_version}`;
    },
  );
  return `Certified: ${joinEnglish(certified)}.`;
}

/** Existing MySQL ≠ MariaDB correction. Not a `WAREHOUSE_TYPES` engine. */
export const README_MARIADB_NOTE =
  "MariaDB is **not certified**. `connection.type: mysql` plus mysql2 may connect; treat MariaDB as self-certifiable and verify against your server.";

function joinEnglish(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
