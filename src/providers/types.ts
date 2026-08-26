import type {
  DefinitionSource,
  DimensionConfig,
  EntityConfig,
  MetricConfig,
  RelationshipConfig,
  SemanticProviderConfig,
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
    warnings: [],
  };
}

export function withSource<T extends object>(
  value: T,
  source: DefinitionSource,
): T & { source: DefinitionSource } {
  return { ...value, source };
}
