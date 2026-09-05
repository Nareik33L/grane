import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  bundledDuckdbProject,
  bundledPostgresProject,
  demoMarkdownPath,
  demoProjectExists,
  isWritableDir,
  packageRoot,
} from "./paths.js";

export interface ResolveDemoProjectOptions {
  dir?: string;
  postgres?: boolean;
  root?: string;
}

export interface ResolvedDemoProject {
  projectDir: string;
  warehousePath: string | null;
  copied: boolean;
  postgres: boolean;
  demoMarkdown: string;
}

const YAML_FILES = ["grane.yml", "metrics.yml", "dimensions.yml", "relationships.yml"];

export function userDemoDir(): string {
  return join(homedir(), ".grane", "demo");
}

export function resolveDemoProject(options: ResolveDemoProjectOptions = {}): ResolvedDemoProject {
  const root = options.root ?? packageRoot();
  const demoMarkdown = demoMarkdownPath(root);

  if (options.postgres) {
    const projectDir = options.dir ?? bundledPostgresProject(root);
    if (!demoProjectExists(projectDir)) {
      throw new Error(`Postgres demo project not found at ${projectDir}`);
    }
    return { projectDir, warehousePath: null, copied: false, postgres: true, demoMarkdown };
  }

  const bundled = bundledDuckdbProject(root);
  if (options.dir) {
    mkdirSync(options.dir, { recursive: true });
    const copied = syncDemoYaml(bundled, options.dir);
    return {
      projectDir: options.dir,
      warehousePath: join(options.dir, "warehouse.duckdb"),
      copied,
      postgres: false,
      demoMarkdown,
    };
  }

  if (isWritableDir(bundled) || isWritableDir(join(bundled, ".."))) {
    return {
      projectDir: bundled,
      warehousePath: join(bundled, "warehouse.duckdb"),
      copied: false,
      postgres: false,
      demoMarkdown,
    };
  }

  mkdirSync(userDemoDir(), { recursive: true });
  const copied = syncDemoYaml(bundled, userDemoDir());
  return {
    projectDir: userDemoDir(),
    warehousePath: join(userDemoDir(), "warehouse.duckdb"),
    copied,
    postgres: false,
    demoMarkdown,
  };
}

export function syncDemoYaml(from: string, to: string): boolean {
  mkdirSync(to, { recursive: true });
  let copied = false;
  for (const name of YAML_FILES) {
    const src = join(from, name);
    if (!existsSync(src)) continue;
    cpSync(src, join(to, name));
    copied = true;
  }
  return copied;
}

/** Warehouse path stored in grane.yml: relative when the file lives in the project. */
export function demoWarehouseConfigPath(projectDir: string, warehousePath: string): string {
  const absProject = resolve(projectDir);
  const absWarehouse = resolve(warehousePath);
  if (dirname(absWarehouse) === absProject) {
    return absWarehouse.slice(absProject.length + 1).replaceAll("\\", "/") || "warehouse.duckdb";
  }
  if (!isAbsolute(warehousePath)) return warehousePath.replaceAll("\\", "/");
  const rel = relative(absProject, absWarehouse).replaceAll("\\", "/");
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  return absWarehouse;
}

/**
 * Write the DuckDB warehouse the demo just built into grane.yml so later
 * `grane query` / `validate` / MCP launches do not read the Postgres template.
 */
export function persistDuckdbConnection(projectDir: string, warehousePath: string): void {
  const file = join(projectDir, "grane.yml");
  if (!existsSync(file)) {
    throw new Error(`Cannot persist the demo DuckDB connection: ${file} was not found.`);
  }
  const stored = demoWarehouseConfigPath(projectDir, warehousePath);
  const block = ["connection:", "  type: duckdb", `  path: ${stored}`, "  schema: main", ""].join("\n");
  const raw = readFileSync(file, "utf8");
  const next = raw.replace(/connection:\n(?:[ \t]+.+\n)*/, block);
  if (next === raw && !/type:\s*duckdb/.test(raw)) {
    throw new Error(`Cannot persist the demo DuckDB connection: ${file} has no connection: block.`);
  }
  if (next !== raw) writeFileSync(file, next);
}
