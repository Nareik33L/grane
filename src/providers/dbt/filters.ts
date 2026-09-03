import type { MetricFilterItem, Scalar } from "../../config/schema.js";
import type { MfSemanticModel } from "./graph.js";

/**
 * Translate MetricFlow filter templates into Grane metric filters, preserving
 * the operator. Supported: `{{ Dimension('entity__dim') }} <op> <literal>`
 * joined by `and`, where `<op>` is `=`, `!=`, or `<>` and the literal is a
 * quoted string, a number, or true/false, and the dimension belongs to the
 * metric's own semantic model.
 *
 * Anything else — TimeDimension/Entity/Metric templates, other operators,
 * `or`, NULL comparisons, SQL expressions, dimensions from other semantic
 * models — is an error. The caller skips the metric; the predicate is never
 * approximated or degraded to a different operator.
 */
export function translateMfFilter(
  filter: string | undefined,
  model: MfSemanticModel,
): { filters: MetricFilterItem[] } | { error: string } {
  if (!filter || !filter.trim()) return { filters: [] };
  const text = filter.replace(/\s+/g, " ").trim();
  if (/\s+or\s+/i.test(text)) {
    return { error: `cannot translate MetricFlow filter \`${text}\`: "or" is not supported` };
  }
  const parts = text.split(/\s+and\s+/i);
  const filters: MetricFilterItem[] = [];
  for (const part of parts) {
    const match = part.match(
      /^\{\{\s*Dimension\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}\s*(=|!=|<>)\s*(.+)$/i,
    );
    if (!match) {
      return { error: `cannot translate MetricFlow filter \`${part}\`` };
    }
    const qualified = match[1]!;
    const operator: MetricFilterItem["operator"] = match[2] === "=" ? "=" : "!=";
    const value = parseLiteral(match[3]!.trim());
    if (value === undefined) {
      return {
        error: `cannot translate MetricFlow filter \`${part}\`: right-hand side must be a quoted string, number, or true/false`,
      };
    }
    const column = resolveLocalDimension(qualified, model);
    if ("error" in column) return column;
    filters.push({ field: column.field, operator, value });
  }
  return { filters };
}

function parseLiteral(raw: string): Scalar | undefined {
  const quoted = raw.match(/^'((?:[^']|'')*)'$/) ?? raw.match(/^"([^"]*)"$/);
  if (quoted) return quoted[1]!.replaceAll("''", "'");
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (/^true$/i.test(raw)) return true;
  if (/^false$/i.test(raw)) return false;
  return undefined;
}

/**
 * `entity__dimension` (or bare `dimension`) must name a dimension on this
 * semantic model. Other models are refused rather than searched: Grane metric
 * filters stay at the metric's grain, and guessing an owner could bind the
 * predicate to the wrong table.
 */
function resolveLocalDimension(
  qualified: string,
  model: MfSemanticModel,
): { field: string } | { error: string } {
  const parts = qualified.split("__");
  const dimName = parts.length === 1 ? parts[0]! : parts.slice(1).join("__");
  const entityName = parts.length === 1 ? undefined : parts[0];
  if (!dimName) return { error: `cannot resolve Dimension('${qualified}')` };
  const localEntity = !entityName || entityName === model.primaryEntity || entityName === model.name;
  if (!localEntity) {
    return {
      error:
        `filter references Dimension('${qualified}') outside semantic model "${model.name}"; ` +
        `cross-model metric filters are not compiled`,
    };
  }
  const local = model.dimensions.find((d) => d.name === dimName);
  if (!local) {
    return {
      error: `cannot resolve Dimension('${qualified}') to a dimension on semantic model "${model.name}"`,
    };
  }
  if (!local.column) {
    return {
      error: `Dimension('${qualified}') is a SQL expression ("${local.expr}"); filters on expression dimensions are not compiled`,
    };
  }
  return { field: `${model.table}.${local.column}` };
}
