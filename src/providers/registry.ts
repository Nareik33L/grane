import type { SemanticProviderConfig } from "../config/schema.js";
import { configError } from "../errors.js";
import { loadDbtProvider } from "./dbt/index.js";
import type { ProviderContext, SemanticContribution, SemanticProviderLoader } from "./types.js";

/**
 * Known semantic providers. Add a loader here when a new upstream system
 * (Cube, LookML, Malloy, …) should feed the same Grane kernel.
 */
export const SEMANTIC_PROVIDERS: Record<string, SemanticProviderLoader> = {
  dbt: loadDbtProvider,
  metricflow: loadDbtProvider,
};

export const SUPPORTED_PROVIDER_TYPES = ["dbt"] as const;

export function loadProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const type = spec.type.trim().toLowerCase();
  const loader = SEMANTIC_PROVIDERS[type];
  if (!loader) {
    throw configError(
      `Unknown semantic provider "${spec.type}". Supported today: ${SUPPORTED_PROVIDER_TYPES.join(", ")}. ` +
        `Native Grane YAML in this project is always loaded. Additional loaders can be registered for other modelling systems.`,
    );
  }
  return loader(spec, ctx);
}

export function loadConfiguredProviders(
  specs: SemanticProviderConfig[],
  ctx: ProviderContext,
): SemanticContribution[] {
  return specs.map((spec) => loadProvider(spec, ctx));
}
