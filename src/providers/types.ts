import type {
  DefinitionSource,
  DimensionConfig,
  EntityConfig,
  MetricConfig,
  RelationshipConfig,
  SemanticProviderConfig,
  UnsupportedDefinition,
} from "../config/schema.js";

/**
 * A semantic provider reads an upstream modelling system and contributes
 * Grane-native maps. The kernel never queries dbt/Cube/LookML at request time
 * — providers run at load, then Grane compiles SQL as usual.
 */
export interface SemanticContribution {
  entities: Record<string, EntityConfig>;
  metrics: Record<string, MetricConfig>;
  dimensions: Record<string, DimensionConfig>;
  relationships: Record<string, RelationshipConfig>;
  /**
   * Upstream definitions the provider saw and deliberately did not import,
   * with the reason. Surfaced through the catalog and in refusals so an
   * agent can tell "not imported" from "does not exist".
   */
  unsupported: UnsupportedDefinition[];
  warnings: string[];
}

export interface ProviderContext {
  /** Directory containing grane.yml. Provider paths are resolved from here. */
  projectDir: string;
}

export type SemanticProviderLoader = (
  spec: SemanticProviderConfig,
  ctx: ProviderContext,
) => SemanticContribution;

export function emptyContribution(): SemanticContribution {
  return {
    entities: {},
    metrics: {},
    dimensions: {},
    relationships: {},
    unsupported: [],
    warnings: [],
  };
}

/** Record a deliberate skip once: structured for the catalog, human-readable for `grane validate`. */
export function skipDefinition(
  out: SemanticContribution,
  item: UnsupportedDefinition,
): void {
  out.unsupported.push(item);
  out.warnings.push(`Skipping ${item.kind} "${item.name}": ${item.reason}`);
}

export function withSource<T extends object>(
  value: T,
  source: DefinitionSource,
): T & { source: DefinitionSource } {
  return { ...value, source };
}
