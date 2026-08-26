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
  expr: string;
}

export interface MfMeasure {
  name: string;
  agg: string;
  expr: string;
  createMetric: boolean;
  aggTimeDimension?: string;
  filter?: string;
  description?: string;
  label?: string;
}

export interface MfMetric {
  name: string;
  type: string;
  description?: string;
  label?: string;
  filter?: string;
  agg?: string;
  expr?: string;
  measure?: string;
  aggTimeDimension?: string;
  numerator?: string;
  denominator?: string;
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

export function mapAgg(agg: string | undefined): MetricType | null {
  if (!agg) return null;
  return AGG_MAP[agg.toLowerCase()] ?? null;
}

const SIMPLE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function simpleColumn(expr: string | undefined | null, fallback?: string): string | null {
  const value = (expr ?? fallback ?? "").trim();
  if (!value) return null;
  if (value === "1") return fallback && SIMPLE_COLUMN.test(fallback) ? fallback : null;
  return SIMPLE_COLUMN.test(value) ? value : null;
}

export function extractRef(model: unknown): string | null {
  if (typeof model !== "string") return null;
  const ref = model.match(/ref\s*\(\s*['"]([^'"]+)['"]\s*\)/i);
  if (ref) return ref[1]!;
  const trimmed = model.trim();
  return SIMPLE_COLUMN.test(trimmed) ? trimmed : null;
}
