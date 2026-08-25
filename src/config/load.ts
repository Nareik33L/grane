import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { graneConfigSchema, type GraneConfig } from "./schema.js";
import { configError } from "../errors.js";

/**
 * A Grane project is a directory containing grane.yml plus any number of
 * additional YAML files (metrics.yml, dimensions.yml, relationships.yml, ...).
 * All files are parsed and merged by top-level key, so users are free to
 * organise definitions across files however they like.
 */

export interface LoadedConfig {
  config: GraneConfig;
  projectDir: string;
  files: string[];
}

const MERGEABLE_MAPS = ["entities", "metrics", "dimensions", "relationships"] as const;
const SINGLETON_KEYS = ["project", "connection", "limits"] as const;

/** Resolve the project directory: the given dir, or ./analytics under it if grane.yml lives there. */
export function findProjectDir(startDir: string): string {
  const dir = resolve(startDir);
  if (existsSync(join(dir, "grane.yml")) || existsSync(join(dir, "grane.yaml"))) return dir;
  const analytics = join(dir, "analytics");
  if (existsSync(join(analytics, "grane.yml")) || existsSync(join(analytics, "grane.yaml"))) {
    return analytics;
  }
  throw configError(
    `No grane.yml found in ${dir} or ${analytics}. Run "grane init" to create a project.`,
  );
}

/** Interpolates ${VAR} and ${VAR:-default} in connection settings. */
function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
      (whole, name: string, fallback: string | undefined) => {
        const env = process.env[name];
        if (env !== undefined) return env;
        if (fallback !== undefined) return fallback;
        return whole;
      },
    );
  }
  return value;
}

export function loadConfig(projectDir: string): LoadedConfig {
  const dir = findProjectDir(projectDir);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .filter((f) => statSync(join(dir, f)).isFile())
    .sort();

  const merged: Record<string, unknown> = {};
  for (const file of files) {
    const raw = readFileSync(join(dir, file), "utf8");
    let doc: unknown;
    try {
      doc = parseYaml(raw);
    } catch (err) {
      throw configError(`Failed to parse ${file}: ${(err as Error).message}`);
    }
    if (doc === null || doc === undefined) continue;
    if (typeof doc !== "object" || Array.isArray(doc)) {
      throw configError(`${file} must contain a YAML mapping at the top level.`);
    }
    for (const [key, value] of Object.entries(doc as Record<string, unknown>)) {
      if ((MERGEABLE_MAPS as readonly string[]).includes(key)) {
        const existing = (merged[key] ?? {}) as Record<string, unknown>;
        const incoming = value as Record<string, unknown>;
        for (const name of Object.keys(incoming ?? {})) {
          if (name in existing) {
            throw configError(`Duplicate definition of ${key.slice(0, -1)} "${name}" (in ${file}).`);
          }
        }
        merged[key] = { ...existing, ...incoming };
      } else if ((SINGLETON_KEYS as readonly string[]).includes(key)) {
        if (key in merged) {
          throw configError(`Duplicate "${key}" section (in ${file}).`);
        }
        merged[key] = value;
      } else {
        throw configError(`Unknown top-level key "${key}" in ${file}.`);
      }
    }
  }

  // Environment interpolation for connection secrets.
  const connection = merged["connection"] as Record<string, unknown> | undefined;
  if (connection) {
    for (const field of ["url", "host", "database", "user", "password"]) {
      if (field in connection) connection[field] = interpolateEnv(connection[field]);
    }
  }

  const parsed = graneConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw configError(`Invalid Grane configuration:\n${issues}`, parsed.error.issues);
  }

  return { config: parsed.data, projectDir: dir, files };
}
