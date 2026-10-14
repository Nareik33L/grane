import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { configError } from "../errors.js";

/** UTF-16 code-unit order — locale-independent, same bytes every run. */
export function compareOrdinal(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export const SEMANTIC_YAML_KEYS = ["entities", "metrics", "dimensions", "relationships"] as const;
export type SemanticYamlKey = (typeof SEMANTIC_YAML_KEYS)[number];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    compareOrdinal(a, b),
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

/** Merge `added` into `existing`. Same key + different value is a conflict. */
export function mergeNamedDefs<T>(
  existing: Record<string, T>,
  added: Record<string, T>,
  kind: string,
  fileHint: string,
): Record<string, T> {
  const out: Record<string, T> = { ...existing };
  for (const [name, value] of Object.entries(added)) {
    if (name in out && canonical(out[name]) !== canonical(value)) {
      throw configError(
        `Refusing to overwrite existing ${kind} "${name}" in ${fileHint}. ` +
          `The base-branch definition differs from the draft. Resolve the conflict before proposing.`,
      );
    }
    out[name] = value;
  }
  return out;
}

export type SemanticYamlRestored = Record<SemanticYamlKey, string[]>;

export interface SemanticYamlMerge {
  contents: string;
  restored: SemanticYamlRestored;
  lost_comments: boolean;
}

export function emptyRestored(): SemanticYamlRestored {
  return { entities: [], metrics: [], dimensions: [], relationships: [] };
}

function yamlCommentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#") || /(?:^|\s)#.+$/.test(line));
}

function commentsLost(base: string, incoming: string, output: string): boolean {
  const kept = new Set(yamlCommentLines(output));
  return [...yamlCommentLines(base), ...yamlCommentLines(incoming)].some((line) => !kept.has(line));
}

/**
 * Combine a draft YAML file with the same path on the base branch.
 * Semantic maps are unioned; conflicting keys refuse. When the draft already
 * contains every base key, the draft bytes are kept (comments survive).
 */
export function combineSemanticYaml(
  base: string | undefined,
  incoming: string,
  path: string,
): string {
  return combineSemanticYamlWithReport(base, incoming, path).contents;
}

export function combineSemanticYamlWithReport(
  base: string | undefined,
  incoming: string,
  path: string,
): SemanticYamlMerge {
  const restored = emptyRestored();
  if (base === undefined || base.trim() === "") {
    return { contents: incoming, restored, lost_comments: false };
  }
  let baseDoc: unknown;
  let nextDoc: unknown;
  try {
    baseDoc = parseYaml(base);
    nextDoc = parseYaml(incoming);
  } catch (err) {
    throw configError(`Failed to parse ${path} while combining with the base branch: ${(err as Error).message}`);
  }
  if (!isPlainObject(baseDoc) || !isPlainObject(nextDoc)) {
    if (canonical(baseDoc) === canonical(nextDoc)) {
      return { contents: incoming, restored, lost_comments: false };
    }
    throw configError(
      `Refusing to replace ${path}: it already exists on the base branch and is not a semantic YAML map.`,
    );
  }
  const merged: Record<string, unknown> = { ...baseDoc };
  let extraFromBase = false;
  for (const key of SEMANTIC_YAML_KEYS) {
    const fromBase = isPlainObject(baseDoc[key]) ? (baseDoc[key] as Record<string, unknown>) : {};
    const fromDraft = isPlainObject(nextDoc[key]) ? (nextDoc[key] as Record<string, unknown>) : undefined;
    if (fromDraft === undefined) {
      if (Object.keys(fromBase).length > 0) {
        extraFromBase = true;
        restored[key].push(...Object.keys(fromBase).sort());
      }
      continue;
    }
    for (const name of Object.keys(fromBase).sort()) {
      if (!(name in fromDraft)) {
        extraFromBase = true;
        restored[key].push(name);
      }
    }
    merged[key] = mergeNamedDefs(fromBase, fromDraft, key, path);
  }
  if (!extraFromBase) {
    return { contents: incoming, restored, lost_comments: false };
  }
  const contents = stringifyYaml(merged);
  return { contents, restored, lost_comments: commentsLost(base, incoming, contents) };
}

/** Read a top-level map (`entities`, `metrics`, …) from `<key>.yml` / `<key>.yaml`. */
export function readYamlMapFile(
  projectDir: string,
  key: SemanticYamlKey,
): Record<string, unknown> {
  const yml = join(projectDir, `${key}.yml`);
  const yamlPath = join(projectDir, `${key}.yaml`);
  const path = existsSync(yamlPath) && !existsSync(yml) ? yamlPath : yml;
  if (!existsSync(path)) return {};
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw configError(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) return {};
  if (!isPlainObject(doc)) {
    throw configError(`${path} must contain a YAML mapping at the top level.`);
  }
  const value = doc[key];
  if (value === undefined || value === null) return {};
  if (!isPlainObject(value)) {
    throw configError(`${path} "${key}" must be a mapping.`);
  }
  return value;
}
