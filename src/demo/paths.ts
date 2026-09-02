import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Repo / npm package root (contains demo/ and package.json). */
export function packageRoot(from = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (let i = 0; i < 6; i += 1) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "demo"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return resolve(dirname(from), "../..");
}

export function demoRoot(root = packageRoot()): string {
  return join(root, "demo");
}

export function demoAnalyticsDir(root = packageRoot()): string {
  return join(demoRoot(root), "analytics");
}

export function demoDuckdbSql(root = packageRoot()): string {
  return join(demoRoot(root), "seed", "duckdb.sql");
}

export function demoMarkdownPath(root = packageRoot()): string {
  return join(demoRoot(root), "README.md");
}

/** YAML project used for both DuckDB and Postgres; connection is overridden in code. */
export function bundledDuckdbProject(root = packageRoot()): string {
  return demoAnalyticsDir(root);
}

export function bundledPostgresProject(root = packageRoot()): string {
  return demoAnalyticsDir(root);
}

export function isWritableDir(dir: string): boolean {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function demoProjectExists(dir: string): boolean {
  return existsSync(join(dir, "grane.yml"));
}
