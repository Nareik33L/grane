import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  dimensionConfigSchema,
  entityConfigSchema,
  metricConfigSchema,
  relationshipConfigSchema,
  type SemanticProviderConfig,
} from "../config/schema.js";
import { configError } from "../errors.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import { isDir, isFile, isRecord, readText, specRoot, walkYamlFiles } from "./helpers.js";

/**
 * Generic Grane-shaped maps dumped by any other tool (JSON/YAML with
 * entities/metrics/dimensions/relationships). The interchange hatch:
 * if a system can emit this, Grane can read it.
 */
export function loadFragmentProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root) throw configError(`Fragment connector needs path/file pointing at YAML/JSON with Grane maps.`);
  const out = emptyContribution();
  const files = isFile(root) ? [root] : walkYamlFiles(root);
  for (const file of files) {
    let doc: unknown;
    try {
      doc = file.endsWith(".json") ? JSON.parse(readText(file)) : parseYaml(readText(file));
    } catch (err) {
      out.warnings.push(`Skipped ${file}: ${(err as Error).message}`);
      continue;
    }
    if (!isRecord(doc)) continue;
    const rel = isDir(root) ? relative(root, file) : file;
    const source = { provider: "fragment" as const, path: rel };
    ingestMap(out.entities, doc.entities, entityConfigSchema, source, "entity", out);
    ingestMap(out.metrics, doc.metrics, metricConfigSchema, source, "metric", out);
    ingestMap(out.dimensions, doc.dimensions, dimensionConfigSchema, source, "dimension", out);
    ingestMap(out.relationships, doc.relationships, relationshipConfigSchema, source, "relationship", out);
  }
  return out;
}

function ingestMap<T>(
  target: Record<string, T>,
  raw: unknown,
  schema: { parse: (value: unknown) => T },
  source: { provider: string; path: string },
  kind: string,
  out: SemanticContribution,
): void {
  if (!isRecord(raw)) {
    if (Array.isArray(raw)) {
      out.warnings.push(`Skipping ${kind} list in ${source.path}: Grane fragments use a name → definition map.`);
    }
    return;
  }
  for (const [name, value] of Object.entries(raw)) {
    try {
      target[name] = withSource(schema.parse(value) as T & object, source) as T;
    } catch (err) {
      out.warnings.push(`Skipping ${kind} "${name}" in ${source.path}: ${(err as Error).message}`);
    }
  }
}
