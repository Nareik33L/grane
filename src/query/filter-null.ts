import type { FilterOperator } from "../config/schema.js";
import { invalidQuery } from "../errors.js";

/**
 * JSON null in an ordinary comparison or membership list is not a supported
 * way to request SQL NULL semantics. Those operators compile to `= $1` /
 * `IN (…)` binds; SQL three-valued logic then silently drops rows (PostgreSQL)
 * or fails the binder (DuckDB). Explicit `is_null` / `is_not_null` are the
 * only operators that mean NULL.
 */
export function filterValueContainsJsonNull(value: unknown): boolean {
  if (value === null) return true;
  if (Array.isArray(value)) return value.some((item) => item === null);
  return false;
}

export function jsonNullFilterMessage(operator: FilterOperator, field: string): string {
  return (
    `Operator "${operator}" on "${field}" cannot use JSON null. ` +
    `SQL NULL comparison and membership are three-valued and warehouse-dependent. ` +
    `Use operator "is_null" or "is_not_null" to select or exclude the NULL cohort.`
  );
}

export function assertNoJsonNullFilterValue(
  operator: FilterOperator,
  field: string,
  value: unknown,
): void {
  if (operator === "is_null" || operator === "is_not_null") return;
  if (!filterValueContainsJsonNull(value)) return;
  throw invalidQuery(jsonNullFilterMessage(operator, field), {
    field,
    operator,
    reason: "json_null_comparison",
  });
}
