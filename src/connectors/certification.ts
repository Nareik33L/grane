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
    label: "MySQL / MariaDB",
    certification: "certified",
    certified_version: "8",
    explanation: "Shared corpus runs in CI against MySQL 8.",
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
    explanation: "Connector ships; Grane CI has no Snowflake warehouse.",
  },
  bigquery: {
    type: "bigquery",
    label: "BigQuery",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Connector ships; Grane CI has no BigQuery project.",
  },
  redshift: {
    type: "redshift",
    label: "Amazon Redshift",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Postgres driver compiles and executes; Grane CI does not run the corpus on Redshift.",
  },
  databricks: {
    type: "databricks",
    label: "Databricks",
    certification: "self_certifiable",
    certified_version: null,
    explanation: "Connector ships; Grane CI has no Databricks warehouse.",
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

const STATE_MEANING: Record<CertificationState, string> = {
  certified: "Shared corpus runs in Grane CI.",
  self_certifiable: "Connector ships; Grane CI does not run the corpus. Verify against your warehouse.",
  compile_only: "SQL is compiled for this dialect; live execution is not a Grane-certified path.",
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

/** README one-liner generated from the map so the matrix cannot drift. */
export function readmeCertificationLine(): string {
  const certified = WAREHOUSE_TYPES.filter((type) => WAREHOUSE_CERTIFICATION[type].certification === "certified").map(
    (type) => {
      const entry = WAREHOUSE_CERTIFICATION[type];
      return `${entry.label} ${entry.certified_version}`;
    },
  );
  return `Certified in CI: ${joinEnglish(certified)}. Other engines are not CI-certified — see [docs/warehouses.md](docs/warehouses.md).`;
}

function joinEnglish(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}
