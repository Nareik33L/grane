import { join } from "node:path";
import { configError } from "../../errors.js";
import type { SemanticProviderConfig } from "../../config/schema.js";
import type { ProviderContext, SemanticContribution } from "../types.js";
import { emptyContribution } from "../types.js";
import { mapMetricFlowGraph } from "./map.js";
import { applyRelationNames, parseDbtManifestRelations, parseDbtYamlFiles, parseSemanticManifest } from "./parse.js";
import type { MetricFlowGraph } from "./graph.js";
import { isDir, isFile, resolveFrom, specRoot } from "../helpers.js";

/**
 * Read an existing dbt/MetricFlow project (YAML and/or semantic_manifest.json)
 * and contribute Grane entities, metrics, dimensions and relationships.
 */
export function loadDbtProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const project = specRoot(spec, ctx);
  const projectDir = isDir(project) ? project : undefined;
  const semanticManifest =
    resolveFrom(ctx, spec.semantic_manifest) ??
    (projectDir ? join(projectDir, "target", "semantic_manifest.json") : isFile(project) && project.endsWith(".json") ? project : undefined);
  const dbtManifest =
    resolveFrom(ctx, spec.dbt_manifest) ?? (projectDir ? join(projectDir, "target", "manifest.json") : undefined);

  if (!projectDir && !isFile(semanticManifest)) {
    throw configError(
      `dbt connector requires "path"/"project" (a dbt project directory) or "semantic_manifest" (semantic_manifest.json).`,
    );
  }
  if ((spec.project || spec.path) && project && !isDir(project) && !isFile(semanticManifest)) {
    throw configError(`dbt connector path does not exist or is not a directory: ${spec.project ?? spec.path}`);
  }

  let graph: MetricFlowGraph = { models: [], metrics: [], warnings: [] };
  if (projectDir) {
    graph = parseDbtYamlFiles(projectDir);
  }
  if (isFile(semanticManifest)) {
    const fromManifest = parseSemanticManifest(semanticManifest);
    if (graph.models.length === 0 && graph.metrics.length === 0) {
      graph = fromManifest;
    } else {
      graph.warnings.push(...fromManifest.warnings);
    }
  }
  if (isFile(dbtManifest)) {
    applyRelationNames(graph, parseDbtManifestRelations(dbtManifest));
  }

  if (graph.models.length === 0 && graph.metrics.length === 0) {
    const contribution = emptyContribution();
    contribution.warnings.push(
      `dbt connector found no MetricFlow semantic models or metrics under ${spec.path ?? spec.project ?? spec.semantic_manifest}.`,
    );
    return contribution;
  }

  return mapMetricFlowGraph(graph, "dbt");
}
