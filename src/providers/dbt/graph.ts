import type { MetricType } from "../../config/schema.js";

/** Normalised MetricFlow graph used by every dbt/MetricFlow parser. */
export interface MfEntity {
  name: string;
  type: "primary" | "foreign" | "unique" | "natural";
  expr: string;
}

export interface MfDimension {
  name: string;
  type: "categorical" | "time";
  /** Raw `expr` (defaults to the name). */
  expr: string;
  /** The bare column when `expr` is one; null for SQL-expression dimensions, which Grane does not compile. */
  column: string | null;
  /** Declared `time_granularity` / `granularity` for time dimensions (lower-cased), when present. */
  granularity?: string;
}

/**
 * MetricFlow `non_additive_dimension` (latest spec: name / window_agg /
 * group_by; legacy: name / window_choice / window_groupings). `groupBy` is the
 * explicit list of entity names; empty means one snapshot for the whole set.
 */
export interface MfNonAdditive {
  name: string;
  windowAgg: string;
  groupBy: string[];
}

export interface MfMeasure {
  name: string;
  agg: string;
  /** Column name, SQL expression, or numeric literal as text (`expr: 1` → "1"). */
  expr: string;
  createMetric: boolean;
  aggTimeDimension?: string;
  filter?: string;
  description?: string;
  label?: string;
  nonAdditive?: MfNonAdditive;
}

/** A metric/measure reference that may carry its own filter, alias, or offset. */
export interface MfMetricInput {
  name: string;
  alias?: string;
  filter?: string;
  offsetWindow?: string;
  offsetToGrain?: string;
  /** Any other key MetricFlow accepts on an input that Grane does not model. */
  extraKeys: string[];
}

export interface MfMetric {
  name: string;
  type: string;
  description?: string;
  label?: string;
  filter?: string;
  agg?: string;
  expr?: string;
  measure?: MfMetricInput;
  aggTimeDimension?: string;
  numerator?: MfMetricInput;
  denominator?: MfMetricInput;
  /** Derived metric inputs (`input_metrics` / legacy `type_params.metrics`). */
  inputMetrics?: MfMetricInput[];
  nonAdditive?: MfNonAdditive;
  /** Semantic model this simple metric belongs to, when known. */
  semanticModel?: string;
  sourcePath: string;
}

export interface MfSemanticModel {
  name: string;
  description?: string;
  table: string;
  dbtModel?: string;
  primaryEntity?: string;
  aggTimeDimension?: string;
  entities: MfEntity[];
  dimensions: MfDimension[];
  measures: MfMeasure[];
  metrics: MfMetric[];
  sourcePath: string;
}

export interface MetricFlowGraph {
  models: MfSemanticModel[];
  metrics: MfMetric[];
  warnings: string[];
}

const AGG_MAP: Record<string, MetricType> = {
  sum: "sum",
  count: "count",
  count_distinct: "count_distinct",
  average: "avg",
  avg: "avg",
  min: "min",
  max: "max",
};

export const SUPPORTED_AGGS = Object.keys(AGG_MAP);

export function mapAgg(agg: string | undefined): MetricType | null {
  if (!agg) return null;
  return AGG_MAP[agg.toLowerCase()] ?? null;
}

const SIMPLE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const NUMERIC_LITERAL = /^-?\d+(\.\d+)?$/;

/** A bare column identifier, or null. Numeric literals and SQL expressions are not columns. */
export function simpleColumn(expr: string | undefined | null, fallback?: string): string | null {
  const value = (expr ?? fallback ?? "").trim();
  if (!value) return null;
  return SIMPLE_COLUMN.test(value) ? value : null;
}

export function isNumericLiteral(expr: string | undefined | null): boolean {
  return NUMERIC_LITERAL.test((expr ?? "").trim());
}

/** MetricFlow accepts `expr` as a string or an integer (`expr: 1`). */
export function exprText(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

export function extractRef(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const ref = model.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (ref) return ref[1]!;
  const trimmed = model.trim();
  return SIMPLE_COLUMN.test(trimmed) ? trimmed : null;
}
