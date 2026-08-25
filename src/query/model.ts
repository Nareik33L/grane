import { z } from "zod";
import { filterOperatorSchema } from "../config/schema.js";

/**
 * Grane Query Model v1 — the versioned semantic contract between agents and
 * the deterministic kernel. Agents request analytical intent; Grane compiles
 * it to SQL.
 */

export const QUERY_MODEL_VERSION = "v1";

export const timeGrainSchema = z.enum(["day", "week", "month", "quarter", "year"]);
export type TimeGrain = z.infer<typeof timeGrainSchema>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);

const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dates must use YYYY-MM-DD format");

export const queryFilterSchema = z.object({
  /** A governed dimension name, or a table.column raw warehouse field. */
  field: z.string(),
  operator: filterOperatorSchema.default("="),
  value: z.union([scalar, z.array(scalar)]).optional(),
});
export type QueryFilter = z.infer<typeof queryFilterSchema>;

export const rawMetricTypeSchema = z.enum(["sum", "count", "count_distinct", "avg", "min", "max"]);
export type RawMetricType = z.infer<typeof rawMetricTypeSchema>;

export const rawMetricSchema = z.object({
  /** Warehouse column as table.column. */
  field: z.string(),
  type: rawMetricTypeSchema.default("count"),
  alias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "alias must be a SQL identifier").optional(),
});
export type RawMetricInput = z.infer<typeof rawMetricSchema>;

export const trustLevelSchema = z.enum(["governed", "mixed", "exploratory"]);
export type TrustLevel = z.infer<typeof trustLevelSchema>;

export const queryTimeSchema = z.object({
  /**
   * Optional dimension name or table.column reference. Defaults to the
   * canonical time_dimension of the requested metrics.
   */
  dimension: z.string().optional(),
  from: dateString,
  /** Inclusive end date. */
  to: dateString,
  grain: timeGrainSchema.optional(),
});
export type QueryTime = z.infer<typeof queryTimeSchema>;

export const queryOrderSchema = z.object({
  field: z.string(),
  direction: z.enum(["asc", "desc"]).default("asc"),
});

export const semanticQuerySchema = z.object({
  query_model: z.literal(QUERY_MODEL_VERSION).default(QUERY_MODEL_VERSION),
  metrics: z.array(z.string()).default([]),
  dimensions: z.array(z.string()).default([]),
  /** Ungoverned warehouse columns (table.column) to group by. */
  raw_dimensions: z.array(z.string()).default([]),
  /** Ungoverned aggregations over warehouse columns. */
  raw_metrics: z.array(rawMetricSchema).default([]),
  filters: z.array(queryFilterSchema).default([]),
  time: queryTimeSchema.optional(),
  order: z.array(queryOrderSchema).default([]),
  limit: z.number().int().positive().optional(),
});
export type SemanticQuery = z.infer<typeof semanticQuerySchema>;
export type SemanticQueryInput = z.input<typeof semanticQuerySchema>;
