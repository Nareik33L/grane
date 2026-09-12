import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WAREHOUSE_TYPES, type WarehouseType } from "../connectors/dialect.js";
import { WAREHOUSE_CERTIFICATION } from "../connectors/certification.js";

export type SetupWarehouse = WarehouseType;

export interface ConnectionDraft {
  type: WarehouseType;
  url?: string;
  path?: string;
  host?: string;
  http_path?: string;
  account?: string;
  user?: string;
  password?: string;
  token?: string;
  warehouse?: string;
  database?: string;
  project?: string;
  dataset?: string;
  catalog?: string;
  schema?: string;
  role?: string;
  location?: string;
  credentials?: string;
}

export interface ConnectionField {
  key: Exclude<keyof ConnectionDraft, "type">;
  label: string;
  required: boolean;
  secret?: boolean;
  defaultValue?: string;
}

const YAML_KEYS: Array<Exclude<keyof ConnectionDraft, never>> = [
  "type",
  "url",
  "path",
  "host",
  "http_path",
  "account",
  "user",
  "password",
  "token",
  "warehouse",
  "database",
  "project",
  "dataset",
  "catalog",
  "schema",
  "role",
  "location",
  "credentials",
];

/** Fields the wizard collects for each connector that already ships on main. */
export function connectionFields(type: WarehouseType): ConnectionField[] {
  switch (type) {
    case "postgres":
    case "redshift":
      return [
        { key: "url", label: "Connection URL (postgres://…)", required: true },
        { key: "schema", label: "Schema", required: false, defaultValue: "public" },
      ];
    case "mysql":
      return [
        { key: "url", label: "Connection URL (mysql://…)", required: true },
        { key: "schema", label: "Database / schema", required: false },
      ];
    case "clickhouse":
      return [
        { key: "url", label: "Connection URL (http://user:pass@host:8123 or clickhouse://…)", required: true },
        { key: "database", label: "Database", required: false, defaultValue: "default" },
      ];
    case "duckdb":
      return [
        { key: "path", label: "DuckDB path (file, :memory:, or md:…)", required: true },
        { key: "schema", label: "Schema", required: false, defaultValue: "main" },
        { key: "token", label: "MotherDuck token", required: false, secret: true },
      ];
    case "snowflake":
      return [
        { key: "account", label: "Account (xy12345.us-east-1)", required: true },
        { key: "user", label: "User", required: true },
        { key: "password", label: "Password", required: true, secret: true },
        { key: "warehouse", label: "Warehouse", required: true },
        { key: "database", label: "Database", required: true },
        { key: "schema", label: "Schema", required: false, defaultValue: "PUBLIC" },
        { key: "role", label: "Role", required: false },
      ];
    case "bigquery":
      return [
        { key: "project", label: "GCP project", required: true },
        { key: "dataset", label: "Dataset", required: true },
        { key: "location", label: "Location", required: false, defaultValue: "US" },
        { key: "credentials", label: "Credentials keyfile path", required: false },
      ];
    case "databricks":
      return [
        { key: "host", label: "Host (xxx.cloud.databricks.com)", required: true },
        { key: "http_path", label: "HTTP path (/sql/1.0/warehouses/…)", required: true },
        { key: "token", label: "Token", required: true, secret: true },
        { key: "catalog", label: "Catalog", required: false, defaultValue: "main" },
        { key: "schema", label: "Schema", required: false },
      ];
  }
}

/** Reliable URL-scheme inference. Returns null for file paths and unknown schemes. */
export function inferWarehouseFromUrl(raw: string): WarehouseType | null {
  const url = raw.trim();
  if (!url) return null;
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    return null;
  }
  if (scheme === "postgres" || scheme === "postgresql") return "postgres";
  if (scheme === "mysql" || scheme === "mariadb") return "mysql";
  if (scheme === "clickhouse") return "clickhouse";
  if (scheme === "redshift") return "redshift";
  if (scheme === "snowflake") return "snowflake";
  if (scheme === "databricks") return "databricks";
  if (scheme === "bigquery") return "bigquery";
  if (scheme === "duckdb") return "duckdb";
  return null;
}

export interface ParsedOwnUrl {
  type: WarehouseType;
  url: string;
}

/**
 * Map a connection URL to a warehouse Grane already supports.
 * `expected` keeps postgres:// as redshift when the user already picked Redshift.
 */
export function parseOwnDatabaseUrl(raw: string, expected?: WarehouseType): ParsedOwnUrl {
  const url = raw.trim();
  if (!url) {
    throw new Error("A database URL is required (postgres://, mysql://, clickhouse://, redshift://, …).");
  }
  const inferred = inferWarehouseFromUrl(url);
  if (!inferred) {
    let scheme = "unknown";
    try {
      scheme = new URL(url).protocol.replace(/:$/, "");
    } catch {
      throw new Error("Not a valid URL. Use postgres://user:pass@host:5432/db (or mysql://, clickhouse://, redshift://).");
    }
    if (scheme === "http" || scheme === "https") {
      if (expected === "clickhouse") return { type: "clickhouse", url };
      throw new Error(
        `http(s) URLs are ClickHouse. Pick ClickHouse, or use clickhouse://. Other engines use their own schemes or fields.`,
      );
    }
    throw new Error(
      `Unsupported URL scheme "${scheme}:". Supported connectors: ${WAREHOUSE_TYPES.join(", ")}. ` +
        `Use a matching URL, or pick the engine and enter its fields.`,
    );
  }
  if (expected === "redshift" && inferred === "postgres") return { type: "redshift", url };
  if (expected && expected !== inferred) {
    throw new Error(
      `That URL looks like ${inferred}, but the chosen engine is ${expected}. Go back and pick ${inferred}, or paste a ${expected} URL.`,
    );
  }
  return { type: inferred, url };
}

export function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^/@]+):([^/@]+)@/, "://$1:***@");
}

export function maskSecret(value: string): string {
  if (!value) return value;
  if (value.includes("://")) return maskDatabaseUrl(value);
  if (value.length <= 4) return "***";
  return `${value.slice(0, 2)}***`;
}

function yamlScalar(value: string): string {
  if (value === "${DATABASE_URL}") return value;
  return JSON.stringify(value);
}

export function persistOwnConnection(projectDir: string, draft: ConnectionDraft): void {
  const file = join(projectDir, "grane.yml");
  if (!existsSync(file)) {
    throw new Error(`Cannot persist the connection: ${file} was not found.`);
  }
  const lines = ["connection:"];
  for (const key of YAML_KEYS) {
    const value = draft[key];
    if (value === undefined || value === "") continue;
    lines.push(`  ${key}: ${key === "type" ? value : yamlScalar(String(value))}`);
  }
  lines.push("");
  const block = lines.join("\n");
  const raw = readFileSync(file, "utf8");
  const normalized = raw.endsWith("\n") ? raw : `${raw}\n`;
  const next = normalized.replace(/connection:\n(?:[ \t]+.+\n)*/, block);
  if (next === raw && !new RegExp(`type:\\s*${draft.type}`).test(raw)) {
    throw new Error(`Cannot persist the connection: ${file} has no connection: block.`);
  }
  if (next !== raw) writeFileSync(file, next);
}

export function describeConnection(draft: ConnectionDraft): string {
  if (draft.url) return `${draft.type}  ${maskDatabaseUrl(draft.url)}`;
  if (draft.path) return `${draft.type}  ${draft.path}`;
  if (draft.account) return `${draft.type}  account=${draft.account}`;
  if (draft.project) return `${draft.type}  project=${draft.project}`;
  if (draft.host) return `${draft.type}  host=${draft.host}`;
  return draft.type;
}

export function engineHint(type: WarehouseType): string {
  const entry = WAREHOUSE_CERTIFICATION[type];
  if (entry.certification === "certified") {
    return `certified in CI (${entry.certified_version})`;
  }
  return `${entry.certification} — not CI-certified`;
}

export function isGraneSourceTree(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "demo")) &&
    existsSync(join(dir, "src", "cli", "index.ts"))
  );
}

export { WAREHOUSE_TYPES };
