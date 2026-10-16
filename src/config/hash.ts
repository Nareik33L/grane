import { createHash } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import type { GraneConfig } from "./schema.js";

/**
 * Canonical hash of the served semantic config.
 *
 * Excludes absolute filesystem paths (DuckDB `connection.path` is resolved
 * against `projectDir`; provider `source.path` may be absolute). Two clones
 * of the same pin therefore compare equal even when their working directories
 * differ.
 */
export function stableConfigHash(config: GraneConfig, projectDir?: string): string {
  const canonical = {
    project: { name: config.project.name, timezone: config.project.timezone },
    entities: canonicalizeMap(config.entities, projectDir),
    metrics: canonicalizeMap(config.metrics, projectDir),
    dimensions: canonicalizeMap(config.dimensions, projectDir),
    relationships: canonicalizeMap(config.relationships, projectDir),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function canonicalizeMap(value: unknown, projectDir?: string): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeMap(item, projectDir));
  if (!value || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [key, item] of entries) {
    if (key === "path" && typeof item === "string") {
      out[key] = portablePath(item, projectDir);
      continue;
    }
    out[key] = canonicalizeMap(item, projectDir);
  }
  return out;
}

function portablePath(path: string, projectDir?: string): string {
  const normalised = path.replaceAll("\\", "/");
  if (!isAbsolute(path) || !projectDir) return normalised;
  const rel = relative(projectDir, path).replaceAll("\\", "/");
  return rel.startsWith("..") ? normalised : rel;
}
