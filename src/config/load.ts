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
 * `grane-tests.yml` / `grane-tests.yaml` are skipped (see `grane test`).
 * All other files are parsed and merged by top-level key, so users are free to
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

export interface LoadConfigOptions {
  /**
   * Project-root YAML basenames → contents. When set, `loadConfig` does not
   * read the working tree (used to serve a pinned commit).
   */
  yamlContents?: Record<string, string>;
  /** Env for `${VAR}` interpolation. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const MERGEABLE_MAPS = ["entities", "metrics", "dimensions", "relationships"] as const;
const UNSUPPORTED_MAP = {
  entity: "entities",
  metric: "metrics",
  dimension: "dimensions",
  relationship: "relationships",
} as const;
const SINGLETON_KEYS = [
  "project",
  "connection",
  "limits",
  "exploration",
  "auth",
  "audit",
  "authoring",
  "providers",
] as const;

/**
 * YAML next to `grane.yml` that is not project config. `grane test` loads
 * `grane-tests.yml` / `grane-tests.yaml`; merging them as config throws
 * `Unknown top-level key "scenarios"` (or `"id"` / `"query"`).
 */
export function isAdopterTestYaml(filename: string): boolean {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  return /^grane-tests\.ya?ml$/i.test(base);
}

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
  if (/^(1|true|yes)$/i.test(process.env.GRANE_AUDIT_FAIL_CLOSED ?? "")) {
    config.audit.fail_closed = true;
  }
}

const PLACEHOLDER = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;
const PLACEHOLDER_PRESENT = /\$\{[A-Z0-9_]+(?::-[^}]*)?\}/;
const URL_SCHEME = /[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

export interface InterpolateEnvOptions {
  /** Connection field name (`url`, `password`, …). Audit/auth omit this. */
  field?: string;
  /**
   * `refuse` (default): an unset referenced variable throws, naming only
   * that variable. `leave`: keep `${VAR}` — historical behaviour for
   * audit.path / auth tokens; not used for connection fields.
   */
  unset?: "refuse" | "leave";
  /**
   * When the YAML value is exactly `${VAR}` and that env value is itself a
   * URL template, expand that template's original text once. Never re-scan
   * substituted values. Default true unless `unset` is `leave`.
   */
  expandUrlTemplates?: boolean;
}

function hasPlaceholder(text: string): boolean {
  return PLACEHOLDER_PRESENT.test(text);
}

function isUrlTemplate(text: string): boolean {
  return URL_SCHEME.test(text) && hasPlaceholder(text);
}

/** Byte range of URL userinfo (`user:password` before the first `@`). */
function userinfoSpan(template: string): { start: number; end: number } | null {
  const scheme = URL_SCHEME.exec(template);
  if (!scheme || scheme.index === undefined) return null;
  const start = scheme.index + scheme[0].length;
  const at = template.indexOf("@", start);
  if (at < 0) return null;
  return { start, end: at };
}

function unsetVariableError(name: string): never {
  throw configError(`Unset environment variable: ${name}`);
}

/**
 * One pass over `template`'s original text. Substituted env values are
 * inserted as-is (URL-encoded when they sit in userinfo) and are never
 * scanned for further `${…}`.
 */
function expandOnce(
  template: string,
  env: NodeJS.ProcessEnv,
  unset: "refuse" | "leave",
  encodeUserinfo: boolean,
): string {
  const span = encodeUserinfo ? userinfoSpan(template) : null;
  let out = "";
  let last = 0;
  for (const match of template.matchAll(new RegExp(PLACEHOLDER.source, "g"))) {
    const index = match.index ?? 0;
    out += template.slice(last, index);
    const name = match[1]!;
    const fallback = match[2];
    const found = env[name];
    let replacement: string;
    if (found !== undefined) {
      replacement = found;
    } else if (fallback !== undefined) {
      replacement = fallback;
    } else if (unset === "leave") {
      replacement = match[0];
    } else {
      unsetVariableError(name);
    }
    const substituted = found !== undefined || fallback !== undefined;
    if (substituted && span && index >= span.start && index < span.end) {
      replacement = encodeURIComponent(replacement);
    }
    out += replacement;
    last = index + match[0].length;
  }
  return out + template.slice(last);
}

/**
 * Interpolates `${VAR}` and `${VAR:-default}` in connection settings.
 * Single pass: a substituted value that itself contains `${…}` is not
 * expanded again (no recursion, no injection from env values).
 *
 * A template URL in env is still supported — `DATABASE_URL=postgres://u:${GRANE_DB_PASSWORD}@h/db`
 * — by expanding that env value's own text once, never the substituted
 * password. Substitutions inside URL userinfo are URL-encoded.
 *
 * Grane does not read the MCP client's JSON; the client copies `env`
 * onto the process, then this runs when loading `grane.yml`.
 */
export function interpolateEnv(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
  options: InterpolateEnvOptions | number = {},
): unknown {
  if (typeof value !== "string") return value;
  const opts: InterpolateEnvOptions = typeof options === "number" ? {} : options;
  const unset = opts.unset ?? "refuse";
  const expandUrlTemplates = opts.expandUrlTemplates ?? unset === "refuse";
  const field = opts.field;
  const encodeUserinfo = field === "url" || (field === undefined && URL_SCHEME.test(value));

  if (expandUrlTemplates && (field === "url" || field === undefined)) {
    const whole = /^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(value);
    if (whole) {
      const name = whole[1]!;
      const fallback = whole[2];
      const found = env[name];
      if (found === undefined && fallback === undefined) {
        if (unset === "refuse") unsetVariableError(name);
      } else {
        const raw = found !== undefined ? found : (fallback as string);
        if (isUrlTemplate(raw)) {
          return expandOnce(raw, env, unset, true);
        }
      }
    }
  }

  return expandOnce(value, env, unset, encodeUserinfo);
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

export function loadConfig(projectDir: string, options: LoadConfigOptions = {}): LoadedConfig {
  const dir = findProjectDir(projectDir);
  const files = options.yamlContents
    ? Object.keys(options.yamlContents)
        .filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && !f.includes("/") && !f.includes("\\"))
        .filter((f) => !isAdopterTestYaml(f))
        .sort()
    : readdirSync(dir)
        .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
        .filter((f) => !isAdopterTestYaml(f))
        .filter((f) => statSync(join(dir, f)).isFile())
        .sort();

  const merged: Record<string, unknown> = {};
  for (const file of files) {
    const raw = options.yamlContents ? options.yamlContents[file]! : readFileSync(join(dir, file), "utf8");
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
  const env = options.env ?? process.env;
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
      if (field in connection) {
        connection[field] = interpolateEnv(connection[field], env, { field });
      }
    }
  }

  const audit = merged["audit"] as Record<string, unknown> | undefined;
  if (audit && "path" in audit) {
    audit.path = interpolateEnv(audit.path, env, { unset: "leave", expandUrlTemplates: false });
  }

  const auth = merged["auth"] as Record<string, unknown> | undefined;
  const agents = auth && Array.isArray(auth.agents) ? auth.agents : [];
  for (const agent of agents) {
    if (agent && typeof agent === "object" && !Array.isArray(agent)) {
      const record = agent as Record<string, unknown>;
      const leave = { unset: "leave" as const, expandUrlTemplates: false };
      if ("token" in record) record.token = interpolateEnv(record.token, env, leave);
      if ("token_sha256" in record) {
        record.token_sha256 = interpolateEnv(record.token_sha256, env, leave);
      }
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
