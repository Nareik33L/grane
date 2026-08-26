import type { MetricFilterItem } from "../../config/schema.js";
import type { MfSemanticModel } from "./graph.js";

/**
 * Translate a handful of MetricFlow filter templates into Grane filters.
 * Unrecognised Jinja is not guessed at — the metric is skipped instead.
 */
export function translateMfFilter(
  filter: string | undefined,
  model: MfSemanticModel,
  models: MfSemanticModel[],
): { filters: MetricFilterItem[] } | { error: string } {
  if (!filter || !filter.trim()) return { filters: [] };
  const text = filter.replace(/\s+/g, " ").trim();
  const parts = text.split(/\s+and\s+/i);
  const filters: MetricFilterItem[] = [];
  for (const part of parts) {
    const match = part.match(
      /^\{\{\s*(?:Dimension|TimeDimension)\s*\(\s*['"]([^'"]+)['"]\s*(?:,[^)]*)?\)\s*\}\}\s*(=|!=)\s*(.+)$/i,
    );
    if (!match) {
      return { error: `cannot translate MetricFlow filter \`${part}\`` };
    }
    const qualified = match[1]!;
    const operator = match[2]! as "=" | "!=";
    const rawValue = match[3]!.trim().replace(/^['"]|['"]$/g, "");
    const column = resolveDimensionColumn(qualified, model, models);
    if (!column) {
      return { error: `cannot resolve Dimension('${qualified}') to a warehouse column` };
    }
    const value = rawValue === "true" ? true : rawValue === "false" ? false : rawValue;
    filters.push({ field: column, operator, value });
  }
  return { filters };
}

function resolveDimensionColumn(
  qualified: string,
  model: MfSemanticModel,
  models: MfSemanticModel[],
): string | null {
  const parts = qualified.split("__");
  const dimName = parts.length === 1 ? parts[0]! : parts.slice(1).join("__");
  const entityName = parts.length === 1 ? undefined : parts[0];
  if (!dimName) return null;

  const local = model.dimensions.find((d) => d.name === dimName || d.expr === dimName);
  if (local && (!entityName || entityName === model.primaryEntity || entityName === model.name)) {
    return `${model.table}.${local.expr}`;
  }

  const owner =
    models.find((m) => m.primaryEntity === entityName && m.dimensions.some((d) => d.name === dimName)) ??
    models.find((m) => m.dimensions.some((d) => d.name === dimName));
  if (!owner) return null;
  const dim = owner.dimensions.find((d) => d.name === dimName);
  return dim ? `${owner.table}.${dim.expr}` : null;
}
