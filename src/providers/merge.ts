import { configError } from "../errors.js";
import type { SemanticContribution } from "./types.js";
import { emptyContribution } from "./types.js";

type MapKey = "entities" | "metrics" | "dimensions" | "relationships";

const KINDS: { key: MapKey; singular: string }[] = [
  { key: "entities", singular: "entity" },
  { key: "metrics", singular: "metric" },
  { key: "dimensions", singular: "dimension" },
  { key: "relationships", singular: "relationship" },
];

function sourceLabel(value: { source?: { provider?: string; path?: string } }): string {
  const source = value.source;
  if (!source?.provider) return "unknown provider";
  return source.path ? `${source.provider} (${source.path})` : source.provider;
}

/**
 * Merge provider contributions into one semantic model.
 * Duplicate names are a config error — Grane will not silently pick a winner.
 */
export function mergeContributions(parts: SemanticContribution[]): SemanticContribution {
  const out = emptyContribution();
  for (const part of parts) {
    out.warnings.push(...part.warnings);
    for (const { key, singular } of KINDS) {
      const incoming = part[key];
      const target = out[key] as Record<string, { source?: { provider?: string; path?: string } }>;
      for (const [name, value] of Object.entries(incoming)) {
        if (name in target) {
          throw configError(
            `Duplicate ${singular} "${name}" from ${sourceLabel(target[name]!)} and ${sourceLabel(value)}. ` +
              `Define each governed name once — Grane will not merge competing definitions.`,
          );
        }
        target[name] = value;
      }
    }
  }
  return out;
}
