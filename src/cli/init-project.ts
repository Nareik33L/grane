import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIMENSIONS_YML, METRICS_YML, RELATIONSHIPS_YML, graneYml } from "./templates.js";

export interface InitProjectResult {
  dir: string;
  written: string[];
  skipped: string[];
}

/** Scaffold grane.yml + metrics/dimensions/relationships. Skips files that already exist. */
export function writeInitProject(dir: string, options: { provider?: string } = {}): InitProjectResult {
  const resolved = resolve(dir);
  mkdirSync(resolved, { recursive: true });
  const files: [string, string][] = [
    ["grane.yml", graneYml(options.provider)],
    ["metrics.yml", METRICS_YML],
    ["dimensions.yml", DIMENSIONS_YML],
    ["relationships.yml", RELATIONSHIPS_YML],
  ];
  const written: string[] = [];
  const skipped: string[] = [];
  for (const [name, contents] of files) {
    const path = join(resolved, name);
    if (existsSync(path)) {
      skipped.push(name);
      continue;
    }
    writeFileSync(path, contents);
    written.push(name);
  }
  return { dir: resolved, written, skipped };
}
