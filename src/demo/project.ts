import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
