import { accessSync, constants, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root: both `src/demo` and `dist/demo` sit two levels below it. */
export function packageRoot(from = fileURLToPath(import.meta.url)): string {
  return join(dirname(from), "../..");
}

export function bundledExampleDir(root = packageRoot()): string {
  return join(root, "example");
}

export function bundledDuckdbProject(root = packageRoot()): string {
  return join(bundledExampleDir(root), "analytics-duckdb");
}

export function bundledPostgresProject(root = packageRoot()): string {
  return join(bundledExampleDir(root), "analytics");
}

export function bundledDuckdbSeed(root = packageRoot()): string {
  return join(bundledExampleDir(root), "seed", "duckdb.sql");
}

export function demoMarkdownPath(root = packageRoot()): string {
  return join(bundledExampleDir(root), "DEMO.md");
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
