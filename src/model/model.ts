import { createHash } from "node:crypto";
import type {
  DimensionConfig,
  EntityConfig,
  GraneConfig,
  MetricConfig,
  MetricFilterItem,
  SemiAdditiveGranularity,
  UnsupportedDefinition,
} from "../config/schema.js";
import { RelationshipGraph } from "./graph.js";
import { parseColumnRef, type ColumnRef } from "./refs.js";
import { undefinedDimension, undefinedMetric, unsupportedDimension, unsupportedMetric } from "../errors.js";

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

/**
 * Resolved semi-additive behaviour. `keys` is the explicit series key set
 * (empty = one snapshot for all rows); `granularity` truncates snapshot dates
 * before comparing them (null = raw values).
 */
export interface SemiAdditiveSpec {
  window: "last" | "first";
  keys: ColumnRef[];
  granularity: SemiAdditiveGranularity | null;
}

export interface Metric {
  name: string;
  config: MetricConfig;
  /** Short content hash identifying this exact definition (provenance). */
  definitionVersion: string;
  /**
   * Parsed measure column for non-ratio metrics. For a row-count metric
   * (`type: count` without `sql`) this is the entity table with `column: ""`;
   * see `countsRows`.
   */
  measure: ColumnRef | null;
  /** `COUNT(1)` over the entity table rather than `COUNT(column)`. */
  countsRows: boolean;
  timeDimension: ColumnRef | null;
  filters: MetricFilterItem[];
  /** Present only when `additive: semi`. Null keys entries are unparseable references (validation reports them). */
  semiAdditive: SemiAdditiveSpec | null;
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

function resolveSemiAdditive(metric: MetricConfig, entity: EntityConfig | undefined): SemiAdditiveSpec | null {
  if (metric.additive !== "semi") return null;
  const window = metric.semi_additive?.window ?? "last";
  const groupBy = metric.semi_additive?.group_by ?? "entity";
  const granularity = metric.semi_additive?.granularity ?? null;
  if (groupBy === "entity") {
    return { window, granularity, keys: entity ? [{ table: entity.table, column: entity.primary_key }] : [] };
  }
  const keys: ColumnRef[] = [];
  for (const ref of groupBy) {
    const parsed = parseColumnRef(ref);
    keys.push(parsed ?? { table: "", column: ref });
  }
  return { window, granularity, keys };
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
  /** Upstream definitions providers saw but did not import, by lower-cased name. */
  readonly unsupported = new Map<string, UnsupportedDefinition>();
  readonly unsupportedDimensions = new Map<string, UnsupportedDefinition>();
  private readonly metricSynonyms = new Map<string, string>();

  constructor(config: GraneConfig) {
    this.config = config;
    this.graph = new RelationshipGraph(config.relationships);

    for (const [name, entity] of Object.entries(config.entities)) {
      this.entities.set(name, { name, config: entity });
    }
    for (const item of config.unsupported) {
      if (item.kind === "metric") this.unsupported.set(item.name.toLowerCase(), item);
      if (item.kind === "dimension") this.unsupportedDimensions.set(item.name.toLowerCase(), item);
    }

    for (const [name, metric] of Object.entries(config.metrics)) {
      const entityTable = config.entities[metric.entity]?.table;
      const countsRows = metric.type === "count" && !metric.sql;
      const measure = metric.sql
        ? parseColumnRef(metric.sql)
        : countsRows && entityTable
          ? { table: entityTable, column: "" }
          : null;
      const timeDimension = metric.time_dimension ? parseColumnRef(metric.time_dimension) : null;
      this.metrics.set(name, {
        name,
        config: metric,
        definitionVersion: hashDefinition(name, metric),
        measure,
        countsRows,
        timeDimension,
        filters: normaliseMetricFilters(metric),
        semiAdditive: resolveSemiAdditive(metric, config.entities[metric.entity]),
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
    const similar = similarNames(requested, [...this.metrics.keys(), ...this.metricSynonyms.keys()]);
    const skipped = this.unsupported.get(lower);
    if (skipped) throw unsupportedMetric(requested, skipped, similar);
    throw undefinedMetric(requested, similar);
  }

  /** Resolve a dimension by name (case-insensitive). Throws a structured refusal. */
  resolveDimension(requested: string): Dimension {
    const direct = this.dimensions.get(requested);
    if (direct) return direct;
    const lower = requested.toLowerCase();
    for (const [name, dimension] of this.dimensions) {
      if (name.toLowerCase() === lower) return dimension;
    }
    const skipped = this.unsupportedDimensions.get(lower);
    if (skipped) {
      // An ambiguous short name: point at the qualified names that carry each meaning.
      const qualified = [...this.dimensions.keys()].filter((name) => name.toLowerCase().endsWith(`__${lower}`));
      throw unsupportedDimension(requested, skipped, qualified.length > 0 ? qualified : similarNames(requested, [...this.dimensions.keys()]));
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
      if (path && !path.fansOut && !path.ambiguous) names.push(dimension.name);
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

/**
 * Semi-additive series-key proof.
 *
 * What Grane can prove from current metadata:
 *   - An entity `primary_key` is the declared grain of that entity. Using it
 *     as a first/last partition makes the snapshot operation vacuous: at most
 *     one row per key already exists by that declaration, so MIN/MAX(time)
 *     cannot collapse history.
 *   - Empty `group_by` is a global snapshot (time-only). It is never vacuous.
 *   - Native `group_by: [columns]` that do not include the metric entity's
 *     primary key is the YAML contract for naming a continuing series. Grane
 *     has no uniqueness or temporal-stability field on those columns, so the
 *     declaration is authoritative: first/last is executed per those columns.
 *   - A relationship (many_to_one / one_to_one / unique) proves joinability
 *     and cardinality for fan-out guards. It does not prove the source key
 *     is temporally stable across snapshot observations. A per-observation
 *     1:1 dimension can be declared many_to_one.
 *
 * Therefore a series key is refused only when it is the metric entity's
 * primary key (default `group_by: entity` or an explicit list that includes
 * it). A relationship on that key does not save it. A vacuous companion in a
 * multi-key list cannot be rescued; order does not matter.
 */
export function vacuousSnapshotSeriesKeys(model: SemanticModel, metric: Metric): ColumnRef[] {
  const spec = metric.semiAdditive;
  if (!spec || spec.keys.length === 0) return [];
  const entity = model.entities.get(metric.config.entity);
  if (!entity) return [];
  return spec.keys.filter(
    (key) => key.table === entity.config.table && key.column === entity.config.primary_key,
  );
}

export function vacuousSnapshotSeriesMessage(metric: Metric, keys: ColumnRef[]): string {
  const named = keys.map((key) => `${key.table}.${key.column}`).join(", ");
  return (
    `Semi-additive metric "${metric.name}" uses semi_additive.group_by on the snapshot ` +
    `entity's own primary key (${named}). That key is the declared grain of the entity, ` +
    `so first/last cannot collapse history and the query would sum every matching row as ` +
    `if it were additive. A relationship on that key does not prove it is a continuing ` +
    `series. Use group_by: [] for one global snapshot, or name series columns that are ` +
    `not the entity primary key.`
  );
}
