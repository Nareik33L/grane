import { createHash } from "node:crypto";
import type {
  DimensionConfig,
  EntityConfig,
  GraneConfig,
  MetricConfig,
  MetricFilterItem,
} from "../config/schema.js";
import { RelationshipGraph } from "./graph.js";
import { parseColumnRef, type ColumnRef } from "./refs.js";
import { undefinedDimension, undefinedMetric } from "../errors.js";

/** Normalised metric filter (the map form is converted to equality items). */
export function normaliseMetricFilters(config: MetricConfig): MetricFilterItem[] {
  if (!config.filters) return [];
  if (Array.isArray(config.filters)) return config.filters;
  return Object.entries(config.filters).map(([field, value]) => ({
    field,
    operator: "=" as const,
    value,
  }));
}

export interface Metric {
  name: string;
  config: MetricConfig;
  /** Short content hash identifying this exact definition (provenance). */
  definitionVersion: string;
  /** Parsed measure column for non-ratio metrics. */
  measure: ColumnRef | null;
  timeDimension: ColumnRef | null;
  filters: MetricFilterItem[];
}

export interface Dimension {
  name: string;
  config: DimensionConfig;
  column: ColumnRef;
}

export interface Entity {
  name: string;
  config: EntityConfig;
}

/** JSON stringify with recursively sorted object keys, so hashes are stable. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashDefinition(name: string, config: unknown): string {
  const canonical = canonicalJson({ name, config });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 8);
}

/** Levenshtein distance, used only for "did you mean" suggestions. */
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = dp[j]!;
      dp[j] = Math.min(
        dp[j]! + 1,
        dp[j - 1]! + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = temp;
    }
  }
  return dp[n]!;
}

function similarNames(requested: string, candidates: string[], max = 5): string[] {
  const lower = requested.toLowerCase();
  const scored = candidates.map((name) => {
    const candidate = name.toLowerCase();
    let score: number;
    if (candidate.includes(lower) || lower.includes(candidate)) {
      score = 0;
    } else {
      score = editDistance(lower, candidate);
    }
    return { name, score };
  });
  return scored
    .filter((s) => s.score <= Math.max(3, Math.floor(requested.length / 2)))
    .sort((a, b) => a.score - b.score)
    .slice(0, max)
    .map((s) => s.name);
}

/**
 * The semantic model: entities, metrics, dimensions and the relationship
 * graph, with deterministic name resolution (including synonyms).
 */
export class SemanticModel {
  readonly config: GraneConfig;
  readonly graph: RelationshipGraph;
  readonly entities = new Map<string, Entity>();
  readonly metrics = new Map<string, Metric>();
  readonly dimensions = new Map<string, Dimension>();
  private readonly metricSynonyms = new Map<string, string>();

  constructor(config: GraneConfig) {
    this.config = config;
    this.graph = new RelationshipGraph(config.relationships);

    for (const [name, entity] of Object.entries(config.entities)) {
      this.entities.set(name, { name, config: entity });
    }

    for (const [name, metric] of Object.entries(config.metrics)) {
      const measure = metric.sql ? parseColumnRef(metric.sql) : null;
      const timeDimension = metric.time_dimension ? parseColumnRef(metric.time_dimension) : null;
      this.metrics.set(name, {
        name,
        config: metric,
        definitionVersion: hashDefinition(name, metric),
        measure,
        timeDimension,
        filters: normaliseMetricFilters(metric),
      });
      for (const synonym of metric.synonyms) {
        this.metricSynonyms.set(synonym.toLowerCase(), name);
      }
    }

    // Ratio metrics inherit their numerator's canonical time dimension unless
    // they declare their own.
    for (const metric of this.metrics.values()) {
      if (metric.config.type === "ratio" && !metric.timeDimension && metric.config.numerator) {
        const numerator = this.metrics.get(metric.config.numerator);
        if (numerator?.timeDimension) {
          metric.timeDimension = numerator.timeDimension;
        }
      }
    }

    for (const [name, dimension] of Object.entries(config.dimensions)) {
      const column = parseColumnRef(dimension.sql);
      if (column) {
        this.dimensions.set(name, { name, config: dimension, column });
      } else {
        // Recorded as a parse failure during validation; store a placeholder
        // so validation can report it with context.
        this.dimensions.set(name, {
          name,
          config: dimension,
          column: { table: "", column: "" },
        });
      }
    }
  }

  /** Table backing an entity, or null if the entity is not defined. */
  entityTable(entityName: string): string | null {
    return this.entities.get(entityName)?.config.table ?? null;
  }

  /** Resolve a metric by canonical name or synonym (case-insensitive). Throws a structured refusal. */
  resolveMetric(requested: string): Metric {
    const direct = this.metrics.get(requested);
    if (direct) return direct;
    const lower = requested.toLowerCase();
    for (const [name, metric] of this.metrics) {
      if (name.toLowerCase() === lower) return metric;
    }
    const viaSynonym = this.metricSynonyms.get(lower);
    if (viaSynonym) return this.metrics.get(viaSynonym)!;
    throw undefinedMetric(
      requested,
      similarNames(requested, [...this.metrics.keys(), ...this.metricSynonyms.keys()]),
    );
  }

  /** Resolve a dimension by name (case-insensitive). Throws a structured refusal. */
  resolveDimension(requested: string): Dimension {
    const direct = this.dimensions.get(requested);
    if (direct) return direct;
    const lower = requested.toLowerCase();
    for (const [name, dimension] of this.dimensions) {
      if (name.toLowerCase() === lower) return dimension;
    }
    throw undefinedDimension(requested, similarNames(requested, [...this.dimensions.keys()]));
  }

  /** Names of dimensions reachable from a metric's entity without fan-out. */
  availableDimensions(metric: Metric): string[] {
    const baseTable = this.entityTable(metric.config.entity);
    if (!baseTable) return [];
    const names: string[] = [];
    for (const dimension of this.dimensions.values()) {
      const dimTable = this.entityTable(dimension.config.entity) ?? dimension.column.table;
      const path = this.graph.findPath(baseTable, dimTable);
      if (path && !path.fansOut) names.push(dimension.name);
    }
    return names;
  }

  /** Search metrics, dimensions and entities by name/synonym/description substring. */
  search(term: string): {
    metrics: string[];
    dimensions: string[];
    entities: string[];
  } {
    const q = term.toLowerCase();
    const matches = (...fields: (string | undefined)[]) =>
      fields.some((f) => f && f.toLowerCase().includes(q));
    return {
      metrics: [...this.metrics.values()]
        .filter((m) =>
          matches(m.name, m.config.description, ...m.config.synonyms),
        )
        .map((m) => m.name),
      dimensions: [...this.dimensions.values()]
        .filter((d) => matches(d.name, d.config.description))
        .map((d) => d.name),
      entities: [...this.entities.values()]
        .filter((e) => matches(e.name, e.config.description, e.config.table))
        .map((e) => e.name),
    };
  }
}
