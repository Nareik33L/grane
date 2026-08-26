import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { RelationshipConfig } from "../config/schema.js";
import { configError } from "../errors.js";

export interface InferredRelationship {
  from: string;
  to: string;
  type: string;
}

export interface RelationshipWritePlan {
  nextFile: Record<string, InferredRelationship>;
  added: string[];
  skipped: { name: string; reason: string }[];
}

function pairKey(rel: InferredRelationship): string {
  return `${rel.from}->${rel.to}`;
}

/**
 * Merge inferred FKs into a relationships.yml map. Never overwrites an
 * existing key or a from→to pair already in the loaded catalog.
 */
export function planRelationshipWrite(input: {
  fileRelationships: Record<string, InferredRelationship>;
  catalogRelationships: Record<string, InferredRelationship>;
  inferred: Record<string, InferredRelationship>;
}): RelationshipWritePlan {
  const nextFile = { ...input.fileRelationships };
  const added: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const catalogPairs = new Set(Object.values(input.catalogRelationships).map(pairKey));
  const filePairs = new Set(Object.values(nextFile).map(pairKey));

  for (const [preferred, rel] of Object.entries(input.inferred)) {
    const pair = pairKey(rel);
    if (catalogPairs.has(pair) || filePairs.has(pair)) {
      skipped.push({ name: preferred, reason: "already defined" });
      continue;
    }
    let name = preferred;
    let n = 2;
    while (name in input.catalogRelationships || name in nextFile) {
      name = `${preferred}_${n++}`;
    }
    nextFile[name] = rel;
    added.push(name);
    filePairs.add(pair);
    catalogPairs.add(pair);
  }

  return { nextFile, added, skipped };
}

export function relationshipsFilePath(projectDir: string): string {
  const yml = join(projectDir, "relationships.yml");
  const yaml = join(projectDir, "relationships.yaml");
  if (existsSync(yaml) && !existsSync(yml)) return yaml;
  return yml;
}

export function readRelationshipsFile(projectDir: string): {
  path: string;
  relationships: Record<string, InferredRelationship>;
} {
  const path = relationshipsFilePath(projectDir);
  if (!existsSync(path)) {
    return { path, relationships: {} };
  }
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    throw configError(`Failed to parse ${path}: ${(err as Error).message}`);
  }
  if (doc === null || doc === undefined) {
    return { path, relationships: {} };
  }
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw configError(`${path} must contain a YAML mapping at the top level.`);
  }
  const relationships = (doc as Record<string, unknown>).relationships;
  if (relationships === undefined || relationships === null) {
    return { path, relationships: {} };
  }
  if (typeof relationships !== "object" || Array.isArray(relationships)) {
    throw configError(`${path} "relationships" must be a mapping.`);
  }
  return { path, relationships: relationships as Record<string, InferredRelationship> };
}

export function writeDiscoveredRelationships(
  projectDir: string,
  inferred: Record<string, InferredRelationship>,
  catalogRelationships: Record<string, RelationshipConfig>,
): { file: string; added: string[]; skipped: { name: string; reason: string }[] } {
  const { path, relationships } = readRelationshipsFile(projectDir);
  const plan = planRelationshipWrite({
    fileRelationships: relationships,
    catalogRelationships,
    inferred,
  });
  if (plan.added.length === 0) {
    return { file: path, added: [], skipped: plan.skipped };
  }
  const header =
    "# How tables relate. Cardinality is required for join-safety checks.\n" +
    "# Updated by `grane discover --write-relationships`. Existing keys were kept.\n\n";
  writeFileSync(path, header + stringifyYaml({ relationships: plan.nextFile }));
  return { file: path, added: plan.added, skipped: plan.skipped };
}
