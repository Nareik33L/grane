import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { configError } from "../../errors.js";
import type { SemanticProviderConfig } from "../../config/schema.js";
import type { ProviderContext, SemanticContribution } from "../types.js";
import { emptyContribution } from "../types.js";
import { mapMetricFlowGraph } from "./map.js";
import { applyRelationNames, parseDbtManifestRelations, parseDbtYamlFiles, parseSemanticManifest } from "./parse.js";
import type { MetricFlowGraph } from "./graph.js";

function resolveFrom(ctx: ProviderContext, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(ctx.projectDir, path);
}

function isFile(path: string | undefined): path is string {
  return Boolean(path && existsSync(path) && statSync(path).isFile());
}

function isDir(path: string | undefined): path is string {
  return Boolean(path && existsSync(path) && statSync(path).isDirectory());
}

/**
 * Read an existing dbt/MetricFlow project (YAML and/or semantic_manifest.json)
 * and contribute Grane entities, metrics, dimensions and relationships.
 */
export function loadDbtProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const project = resolveFrom(ctx, spec.project);
  const semanticManifest =
    resolveFrom(ctx, spec.semantic_manifest) ??
    (project ? join(project, "target", "semantic_manifest.json") : undefined);
  const dbtManifest =
    resolveFrom(ctx, spec.dbt_manifest) ?? (project ? join(project, "target", "manifest.json") : undefined);

  if (!project && !isFile(semanticManifest)) {
    throw configError(
      `dbt provider requires "project" (a dbt project directory) or "semantic_manifest" (semantic_manifest.json).`,
    );
  }
  if (spec.project && !isDir(project)) {
    throw configError(`dbt provider project path does not exist or is not a directory: ${spec.project}`);
  }

  let graph: MetricFlowGraph = { models: [], metrics: [], warnings: [] };
  if (isDir(project)) {
    graph = parseDbtYamlFiles(project);
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
      `dbt provider found no MetricFlow semantic models or metrics under ${spec.project ?? spec.semantic_manifest}.`,
    );
    return contribution;
  }

  return mapMetricFlowGraph(graph, "dbt");
}
