import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { WarehouseType } from "../config/schema.js";

export type SetupWarehouse = Extract<WarehouseType, "postgres" | "mysql" | "clickhouse">;

export interface ParsedOwnUrl {
  type: SetupWarehouse;
  url: string;
}

const GUIDED = "postgres://";
const ALSO = "mysql:// and clickhouse:// also write connection.type";

/** Map a connection URL to a warehouse Grane already supports. Does not invent engines. */
export function parseOwnDatabaseUrl(raw: string): ParsedOwnUrl {
  const url = raw.trim();
  if (!url) {
    throw new Error(`A database URL is required (${GUIDED}…; ${ALSO}).`);
  }
  let scheme: string;
  try {
    scheme = new URL(url).protocol.replace(/:$/, "").toLowerCase();
  } catch {
    throw new Error(`Not a valid URL. Use ${GUIDED}user:pass@host:5432/db (${ALSO}).`);
  }
  if (scheme === "postgres" || scheme === "postgresql") return { type: "postgres", url };
  if (scheme === "mysql" || scheme === "mariadb") return { type: "mysql", url };
  if (scheme === "clickhouse") return { type: "clickhouse", url };
  throw new Error(
    `Unsupported URL scheme "${scheme}:". This wizard accepts ${GUIDED} (${ALSO}). ` +
      `Snowflake, BigQuery, Databricks, and Redshift: set connection.type in grane.yml — see docs/warehouses.md.`,
  );
}

export function maskDatabaseUrl(url: string): string {
  return url.replace(/:\/\/([^/@]+):([^/@]+)@/, "://$1:***@");
}

function yamlScalar(value: string): string {
  if (value === "${DATABASE_URL}") return value;
  return JSON.stringify(value);
}

/**
 * Rewrite the `connection:` block so later validate / MCP / query use this URL.
 * Same approach as the demo DuckDB persist: comments in the block are replaced.
 */
export function persistOwnConnection(
  projectDir: string,
  parsed: ParsedOwnUrl,
  schema = "public",
): void {
  const file = join(projectDir, "grane.yml");
  if (!existsSync(file)) {
    throw new Error(`Cannot persist the connection: ${file} was not found.`);
  }
  const block = [
    "connection:",
    `  type: ${parsed.type}`,
    `  url: ${yamlScalar(parsed.url)}`,
    `  schema: ${schema}`,
    "",
  ].join("\n");
  const raw = readFileSync(file, "utf8");
  const normalized = raw.endsWith("\n") ? raw : `${raw}\n`;
  const next = normalized.replace(/connection:\n(?:[ \t]+.+\n)*/, block);
  if (next === raw && !new RegExp(`type:\\s*${parsed.type}`).test(raw)) {
    throw new Error(`Cannot persist the connection: ${file} has no connection: block.`);
  }
  if (next !== raw) writeFileSync(file, next);
}

export function isGraneSourceTree(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) &&
    existsSync(join(dir, "demo")) &&
    existsSync(join(dir, "src", "cli", "index.ts"))
  );
}
