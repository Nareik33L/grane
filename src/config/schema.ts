import { z } from "zod";

/** zod schemas for Grane project configuration (grane.yml and friends). */

export const metricTypeSchema = z.enum([
  "sum",
  "count",
  "count_distinct",
  "avg",
  "min",
  "max",
  "ratio",
]);
export type MetricType = z.infer<typeof metricTypeSchema>;

export const cardinalitySchema = z.enum(["many_to_one", "one_to_many", "one_to_one"]);
export type Cardinality = z.infer<typeof cardinalitySchema>;

export const metricStatusSchema = z.enum(["experimental", "approved", "deprecated"]);
export type MetricStatus = z.infer<typeof metricStatusSchema>;

const scalar = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type Scalar = z.infer<typeof scalar>;

export const filterOperatorSchema = z.enum([
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "in",
  "not_in",
  "is_null",
  "is_not_null",
  "contains",
]);
export type FilterOperator = z.infer<typeof filterOperatorSchema>;

/** Filters on metric definitions: either `{ "orders.status": "completed" }` or an explicit list. */
const metricFilterListItem = z.object({
  field: z.string(),
  operator: filterOperatorSchema.default("="),
  value: z.union([scalar, z.array(scalar)]).optional(),
});
export type MetricFilterItem = z.infer<typeof metricFilterListItem>;

export const metricFiltersSchema = z.union([
  z.record(z.string(), scalar),
  z.array(metricFilterListItem),
]);

/** Where a governed definition was loaded from. Native YAML is `native`; dbt/MetricFlow is `dbt`. */
export const definitionSourceSchema = z.object({
  provider: z.string(),
  /** Project-relative file or artifact the definition was read from. */
  path: z.string().optional(),
});
export type DefinitionSource = z.infer<typeof definitionSourceSchema>;

export const entityConfigSchema = z.object({
  table: z.string(),
  primary_key: z.string().default("id"),
  description: z.string().optional(),
  source: definitionSourceSchema.optional(),
});
export type EntityConfig = z.infer<typeof entityConfigSchema>;

export const metricConfigSchema = z
  .object({
    description: z.string().optional(),
    owner: z.string().optional(),
    entity: z.string(),
    type: metricTypeSchema,
    sql: z.string().optional(),
    numerator: z.string().optional(),
    denominator: z.string().optional(),
    filters: metricFiltersSchema.optional(),
    time_dimension: z.string().optional(),
    unit: z.string().optional(),
    status: metricStatusSchema.default("approved"),
    synonyms: z.array(z.string()).default([]),
    source: definitionSourceSchema.optional(),
  })
  .refine((m) => (m.type === "ratio" ? Boolean(m.numerator && m.denominator) : Boolean(m.sql)), {
    message:
      "metrics of type 'ratio' require 'numerator' and 'denominator' (metric names); all other types require 'sql' (a ${table.column} reference)",
  });
export type MetricConfig = z.infer<typeof metricConfigSchema>;

export const dimensionConfigSchema = z.object({
  description: z.string().optional(),
  entity: z.string(),
  sql: z.string(),
  type: z.enum(["string", "number", "boolean", "timestamp", "date"]).optional(),
  source: definitionSourceSchema.optional(),
});
export type DimensionConfig = z.infer<typeof dimensionConfigSchema>;

export const relationshipConfigSchema = z.object({
  from: z.string(),
  to: z.string(),
  type: cardinalitySchema,
  source: definitionSourceSchema.optional(),
});
export type RelationshipConfig = z.infer<typeof relationshipConfigSchema>;

export const warehouseTypeSchema = z.enum([
  "postgres",
  "mysql",
  "snowflake",
  "bigquery",
  "duckdb",
  "clickhouse",
  "redshift",
  "databricks",
]);
export type WarehouseType = z.infer<typeof warehouseTypeSchema>;

export const connectionConfigSchema = z.object({
  type: warehouseTypeSchema.default("postgres"),
  /** Full connection URL. Supports ${ENV_VAR} interpolation. */
  url: z.string().optional(),
  host: z.string().optional(),
  port: z.number().optional(),
  database: z.string().optional(),
  user: z.string().optional(),
  password: z.string().optional(),
  schema: z.string().optional(),
  ssl: z.boolean().optional(),
  /** Snowflake account identifier. */
  account: z.string().optional(),
  /** Snowflake warehouse. */
  warehouse: z.string().optional(),
  role: z.string().optional(),
  /** BigQuery project id. */
  project: z.string().optional(),
  /** BigQuery dataset (falls back to schema). */
  dataset: z.string().optional(),
  location: z.string().optional(),
  /** Path to a service-account JSON key (BigQuery). */
  credentials: z.string().optional(),
  /** DuckDB file path, :memory:, or MotherDuck md:database. */
  path: z.string().optional(),
  /** Databricks Unity Catalog name. */
  catalog: z.string().optional(),
  /** Databricks SQL warehouse HTTP path (e.g. /sql/1.0/warehouses/...). */
  http_path: z.string().optional(),
  /** Databricks or MotherDuck token (falls back to password / MOTHERDUCK_TOKEN). */
  token: z.string().optional(),
});
export type ConnectionConfig = z.infer<typeof connectionConfigSchema>;

export const projectConfigSchema = z.object({
  name: z.string().default("grane-project"),
  timezone: z.string().default("UTC"),
  week: z.object({ starts: z.enum(["monday", "sunday"]).default("monday") }).default({ starts: "monday" }),
  fiscal_year: z
    .object({
      starts_month: z.enum([
        "january",
        "february",
        "march",
        "april",
        "may",
        "june",
        "july",
        "august",
        "september",
        "october",
        "november",
        "december",
      ]),
    })
    .optional(),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export const limitsConfigSchema = z.object({
  max_rows: z.number().int().positive().default(10000),
  default_rows: z.number().int().positive().default(1000),
  timeout_ms: z.number().int().positive().default(30000),
});
export type LimitsConfig = z.infer<typeof limitsConfigSchema>;

/**
 * Controlled exploration: agents may query warehouse columns that are not
 * governed metrics or dimensions. Results are never marked trust: governed.
 */
export const explorationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /**
   * Schemas agents may explore. Empty means the connection schema (or every
   * table returned by introspection).
   */
  schemas: z.array(z.string()).default([]),
  /** table.column refs that must never be queried, even when exploration is on. */
  exclude: z.array(z.string()).default([]),
});
export type ExplorationConfig = z.infer<typeof explorationConfigSchema>;

/**
 * Per-agent HTTP MCP credentials. When `agents` is non-empty, streamable HTTP
 * requires `Authorization: Bearer <token>` (stdio stays local-process trusted).
 * Omit `metrics` / `dimensions` to grant the full governed catalog.
 */
export const agentConfigSchema = z.object({
  id: z.string().min(1),
  token: z.string().min(1),
  metrics: z.array(z.string()).optional(),
  dimensions: z.array(z.string()).optional(),
  exploration: z.boolean().default(true),
});
export type AgentConfig = z.infer<typeof agentConfigSchema>;

export const authConfigSchema = z.object({
  agents: z.array(agentConfigSchema).default([]),
});
export type AuthConfig = z.infer<typeof authConfigSchema>;

/**
 * Append-only query audit log. Records time, agent, trust, the semantic query,
 * compiled SQL, row count, and refusals. Never writes row payloads or tokens.
 */
export const auditConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** JSONL path. Relative paths resolve from the project directory. */
  path: z.string().default(".grane/audit.jsonl"),
  /**
   * Also emit one JSON object per line on stderr (MCP stdio stays clean;
   * container runtimes still collect it).
   */
  stdout: z.boolean().default(false),
});
export type AuditConfig = z.infer<typeof auditConfigSchema>;

/**
 * Extra semantic inputs. Native YAML in the Grane project is always loaded.
 * `providers` are universal connectors: point them at a dbt, Cube, LookML,
 * Apache Ossie, or generic fragment path. Omit `type` to auto-detect.
 */
export const semanticProviderConfigSchema = z
  .object({
    /** Connector kind. Omit (or `auto`) to sniff the path. */
    type: z.string().optional(),
    /** Directory or file to read. Preferred over `project`. */
    path: z.string().optional(),
    /** Alias of `path` (dbt project root, Cube schema folder, …). */
    project: z.string().optional(),
    /** Single document (Ossie YAML/JSON, semantic_manifest.json, …). */
    file: z.string().optional(),
    /** dbt MetricFlow artifact (defaults to <path>/target/semantic_manifest.json). */
    semantic_manifest: z.string().optional(),
    /** dbt manifest.json for physical relation names (defaults to <path>/target/manifest.json). */
    dbt_manifest: z.string().optional(),
  })
  .passthrough();
export type SemanticProviderConfig = z.infer<typeof semanticProviderConfigSchema>;

export const graneConfigSchema = z.object({
  project: projectConfigSchema.prefault({}),
  connection: connectionConfigSchema.prefault({}),
  limits: limitsConfigSchema.prefault({}),
  exploration: explorationConfigSchema.prefault({}),
  auth: authConfigSchema.prefault({}),
  audit: auditConfigSchema.prefault({}),
  providers: z.array(semanticProviderConfigSchema).default([]),
  entities: z.record(z.string(), entityConfigSchema).default({}),
  metrics: z.record(z.string(), metricConfigSchema).default({}),
  dimensions: z.record(z.string(), dimensionConfigSchema).default({}),
  relationships: z.record(z.string(), relationshipConfigSchema).default({}),
});
export type GraneConfig = z.infer<typeof graneConfigSchema>;
