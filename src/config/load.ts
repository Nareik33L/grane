import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { graneConfigSchema, type GraneConfig } from "./schema.js";
import { configError } from "../errors.js";
import { mergeContributions } from "../providers/merge.js";
import { loadConfiguredProviders } from "../providers/registry.js";
import { emptyContribution, type SemanticContribution } from "../providers/types.js";
import { validateAuthConfig } from "../auth/agents.js";

/**
 * A Grane project is a directory containing grane.yml plus any number of
 * additional YAML files (metrics.yml, dimensions.yml, relationships.yml, ...).
 * All files are parsed and merged by top-level key, so users are free to
 * organise definitions across files however they like.
 *
 * Optional `providers:` entries (dbt/MetricFlow, Cube, LookML, Ossie, Malloy)
 * are loaded afterwards and merged into the same maps.
 */

export interface LoadedConfig {
  config: GraneConfig;
  projectDir: string;
  files: string[];
  warnings: string[];
}

const MERGEABLE_MAPS = ["entities", "metrics", "dimensions", "relationships"] as const;
const UNSUPPORTED_MAP = {
  entity: "entities",
  metric: "metrics",
  dimension: "dimensions",
  relationship: "relationships",
} as const;
const SINGLETON_KEYS = ["project", "connection", "limits", "exploration", "auth", "audit", "providers"] as const;

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

/** Docker-friendly overrides so a read-only project mount can still audit. */
function applyAuditEnvOverrides(config: GraneConfig): void {
  const path = process.env.GRANE_AUDIT_PATH;
  if (path) config.audit.path = path;
  if (/^(1|true|yes)$/i.test(process.env.GRANE_AUDIT_STDOUT ?? "")) {
    config.audit.stdout = true;
  }
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

function nativeContribution(config: GraneConfig): SemanticContribution {
  const stamp = <T extends { source?: { provider: string; path?: string } }>(value: T): T =>
    value.source ? value : { ...value, source: { provider: "native" } };
  const contribution = emptyContribution();
  for (const [name, entity] of Object.entries(config.entities)) {
    contribution.entities[name] = stamp(entity);
  }
  for (const [name, metric] of Object.entries(config.metrics)) {
    contribution.metrics[name] = stamp(metric);
  }
  for (const [name, dimension] of Object.entries(config.dimensions)) {
    contribution.dimensions[name] = stamp(dimension);
  }
  for (const [name, relationship] of Object.entries(config.relationships)) {
    contribution.relationships[name] = stamp(relationship);
  }
  return contribution;
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
    for (const field of [
      "url",
      "host",
      "database",
      "user",
      "password",
      "account",
      "warehouse",
      "role",
      "project",
      "dataset",
      "location",
      "credentials",
      "path",
      "catalog",
      "http_path",
      "token",
    ]) {
      if (field in connection) connection[field] = interpolateEnv(connection[field]);
    }
  }

  const audit = merged["audit"] as Record<string, unknown> | undefined;
  if (audit && "path" in audit) {
    audit.path = interpolateEnv(audit.path);
  }

  const auth = merged["auth"] as Record<string, unknown> | undefined;
  const agents = auth && Array.isArray(auth.agents) ? auth.agents : [];
  for (const agent of agents) {
    if (agent && typeof agent === "object" && !Array.isArray(agent) && "token" in agent) {
      const record = agent as Record<string, unknown>;
      record.token = interpolateEnv(record.token);
    }
  }

  const parsed = graneConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw configError(`Invalid Grane configuration:\n${issues}`, parsed.error.issues);
  }

  const native = nativeContribution(parsed.data);
  const extras = loadConfiguredProviders(parsed.data.providers, { projectDir: dir });
  const combined = mergeContributions([native, ...extras]);

  const withMaps = {
    ...parsed.data,
    entities: combined.entities,
    metrics: combined.metrics,
    dimensions: combined.dimensions,
    relationships: combined.relationships,
    // A name defined natively or by another provider is not "unsupported".
    unsupported: combined.unsupported.filter((item) => !(item.name in combined[UNSUPPORTED_MAP[item.kind]])),
  };
  const finalParsed = graneConfigSchema.safeParse(withMaps);
  if (!finalParsed.success) {
    const issues = finalParsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw configError(`Invalid semantic provider output:\n${issues}`, finalParsed.error.issues);
  }

  const config = finalParsed.data;
  applyAuditEnvOverrides(config);
  validateAuthConfig(config);
  for (const agent of config.auth.agents) {
    for (const name of agent.metrics ?? []) {
      if (!(name in config.metrics)) {
        combined.warnings.push(`auth agent "${agent.id}" allows metric "${name}", which is not a defined metric.`);
      }
    }
    for (const name of agent.dimensions ?? []) {
      if (!(name in config.dimensions)) {
        combined.warnings.push(
          `auth agent "${agent.id}" allows dimension "${name}", which is not a defined dimension.`,
        );
      }
    }
  }
  const duckPath = config.connection.path;
  if (
    config.connection.type === "duckdb" &&
    duckPath &&
    duckPath !== ":memory:" &&
    !duckPath.startsWith("md:") &&
    !isAbsolute(duckPath)
  ) {
    config.connection.path = resolve(dir, duckPath);
  }

  return { config, projectDir: dir, files, warnings: combined.warnings };
}
