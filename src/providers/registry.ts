import type { SemanticProviderConfig } from "../config/schema.js";
import { configError } from "../errors.js";
import { loadAutoProvider, loadKind } from "./auto.js";
import { detectConnectorKinds, type ConnectorKind } from "./detect.js";
import type { ProviderContext, SemanticContribution, SemanticProviderLoader } from "./types.js";

export const SEMANTIC_PROVIDERS: Record<string, SemanticProviderLoader> = {
  auto: loadAutoProvider,
  dbt: (spec, ctx) => loadKind("dbt", spec, ctx),
  metricflow: (spec, ctx) => loadKind("dbt", spec, ctx),
  cube: (spec, ctx) => loadKind("cube", spec, ctx),
  lookml: (spec, ctx) => loadKind("lookml", spec, ctx),
  looker: (spec, ctx) => loadKind("lookml", spec, ctx),
  ossie: (spec, ctx) => loadKind("ossie", spec, ctx),
  osi: (spec, ctx) => loadKind("ossie", spec, ctx),
  fragment: (spec, ctx) => loadKind("fragment", spec, ctx),
  grane: (spec, ctx) => loadKind("fragment", spec, ctx),
  malloy: (spec, ctx) => loadKind("malloy", spec, ctx),
};

export const SUPPORTED_PROVIDER_TYPES = [
  "auto",
  "dbt",
  "cube",
  "lookml",
  "ossie",
  "fragment",
  "malloy",
] as const;

export function loadProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const type = (spec.type ?? "auto").trim().toLowerCase();
  const loader = SEMANTIC_PROVIDERS[type];
  if (!loader) {
    throw configError(
      `Unknown semantic connector "${spec.type}". Supported: ${SUPPORTED_PROVIDER_TYPES.join(", ")} ` +
        `(aliases: metricflow, looker, osi, grane). Omit type to auto-detect from path.`,
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

export { detectConnectorKinds, loadAutoProvider, loadKind };
export type { ConnectorKind };
