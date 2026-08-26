import { configError } from "../errors.js";
import type { SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution } from "./types.js";
import { detectConnectorKinds, type ConnectorKind } from "./detect.js";
import { specRoot, isDir, isFile } from "./helpers.js";
import { mergeContributions } from "./merge.js";
import { loadDbtProvider } from "./dbt/index.js";
import { loadCubeProvider } from "./cube.js";
import { loadLookmlProvider } from "./lookml.js";
import { loadOssieProvider } from "./ossie.js";
import { loadFragmentProvider } from "./fragment.js";

export function loadKind(
  kind: ConnectorKind,
  spec: SemanticProviderConfig,
  ctx: ProviderContext,
): SemanticContribution {
  switch (kind) {
    case "dbt":
      return loadDbtProvider(spec, ctx);
    case "cube":
      return loadCubeProvider(spec, ctx);
    case "lookml":
      return loadLookmlProvider(spec, ctx);
    case "ossie":
      return loadOssieProvider(spec, ctx);
    case "fragment":
      return loadFragmentProvider(spec, ctx);
    case "malloy":
      return malloyStub(spec, ctx);
  }
}

function malloyStub(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const out = emptyContribution();
  out.warnings.push(
    `Malloy sources were detected at ${spec.path ?? spec.project ?? specRoot(spec, ctx) ?? "?"}. ` +
      `Grane does not compile .malloy yet — export Apache Ossie, Cube YAML, or Grane fragment maps.`,
  );
  return out;
}

/**
 * Sniff the path and run every matching connector. Point Grane at a folder;
 * it should not matter whether the company used dbt, Cube, Looker, or Ossie.
 */
export function loadAutoProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root || (!isDir(root) && !isFile(root))) {
    throw configError(
      `Semantic connector needs a path (directory or file) to read. ` +
        `Example: providers: [{ path: ../jaffle_shop }]`,
    );
  }
  const kinds = detectConnectorKinds(root);
  if (kinds.length === 0) {
    throw configError(
      `No semantic definitions found at ${spec.path ?? spec.project ?? spec.file ?? root}. ` +
        `Grane can auto-detect dbt/MetricFlow, Cube YAML, LookML, Apache Ossie, or Grane fragment maps.`,
    );
  }
  const parts = kinds.map((kind) => loadKind(kind, spec, ctx));
  if (kinds.length > 1) {
    const merged = mergeContributions(parts);
    merged.warnings.unshift(`Auto-detected semantic connectors at this path: ${kinds.join(", ")}.`);
    return merged;
  }
  return parts[0]!;
}
