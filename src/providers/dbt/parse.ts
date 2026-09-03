import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  exprText,
  extractRef,
  simpleColumn,
  type MetricFlowGraph,
  type MfDimension,
  type MfEntity,
  type MfMeasure,
  type MfMetric,
  type MfMetricInput,
  type MfNonAdditive,
  type MfSemanticModel,
} from "./graph.js";

const SKIP_DIRS = new Set([
  "target",
  "dbt_packages",
  "logs",
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "macros",
  "tests",
  "analyses",
  "snapshots",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function walkYamlFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path);
      } else if (entry.isFile() && /\.ya?ml$/i.test(entry.name) && entry.name !== "dbt_project.yml") {
        out.push(path);
      }
    }
  };
  visit(root);
  return out.sort();
}

export function parseDbtYamlFiles(projectRoot: string): MetricFlowGraph {
  const graph: MetricFlowGraph = { models: [], metrics: [], warnings: [] };
  for (const file of walkYamlFiles(projectRoot)) {
    const rel = relative(projectRoot, file);
    let doc: unknown;
    try {
      doc = parseYaml(readFileSync(file, "utf8"));
    } catch (err) {
      graph.warnings.push(`Skipped ${rel}: ${(err as Error).message}`);
      continue;
    }
    if (!isRecord(doc)) continue;
    for (const model of asArray(doc.semantic_models)) {
      const parsed = parseLegacySemanticModel(model, rel);
      if (parsed) graph.models.push(parsed);
    }
    for (const model of asArray(doc.models)) {
      const parsed = parseLatestSemanticModel(model, rel);
      if (parsed) graph.models.push(parsed);
    }
    for (const metric of asArray(doc.metrics)) {
      const parsed = parseTopLevelMetric(metric, rel);
      if (parsed) graph.metrics.push(parsed);
    }
  }
  return graph;
}

function parseLegacySemanticModel(raw: unknown, sourcePath: string): MfSemanticModel | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const table = extractRef(raw.model) ?? name;
  const defaults = isRecord(raw.defaults) ? raw.defaults : {};
  const entities = asArray(raw.entities).map(parseEntity).filter((e): e is MfEntity => e !== null);
  const primary = entities.find((e) => e.type === "primary");
  return {
    name,
    description: str(raw.description),
    table,
    dbtModel: extractRef(raw.model) ?? name,
    primaryEntity: str(raw.primary_entity) ?? primary?.name ?? name,
    aggTimeDimension: str(defaults.agg_time_dimension) ?? str(raw.agg_time_dimension),
    entities,
    dimensions: asArray(raw.dimensions).map(parseLegacyDimension).filter((d): d is MfDimension => d !== null),
    measures: asArray(raw.measures).map(parseMeasure).filter((m): m is MfMeasure => m !== null),
    metrics: [],
    sourcePath,
  };
}

function parseLatestSemanticModel(raw: unknown, sourcePath: string): MfSemanticModel | null {
  if (!isRecord(raw)) return null;
  const semantic = raw.semantic_model;
  if (semantic === false) return null;
  if (semantic === undefined) return null;
  const block = semantic === true ? {} : isRecord(semantic) ? semantic : null;
  if (!block) return null;
  if (block.enabled === false) return null;
  const modelName = str(raw.name);
  if (!modelName) return null;
  const name = str(block.name) ?? modelName;
  const entities: MfEntity[] = [];
  const dimensions: MfDimension[] = [];
  for (const column of asArray(raw.columns)) {
    if (!isRecord(column)) continue;
    const colName = str(column.name);
    if (!colName) continue;
    if (column.entity !== undefined) {
      const entity = parseEntity(
        isRecord(column.entity) ? { ...column.entity, expr: column.entity.expr ?? colName } : null,
      );
      if (entity) entities.push(entity);
    }
    if (column.dimension !== undefined || column.granularity !== undefined) {
      const dimRaw = isRecord(column.dimension) ? column.dimension : {};
      const dim = parseLegacyDimension({
        name: str(dimRaw.name) ?? colName,
        type: str(dimRaw.type) ?? (column.granularity ? "time" : "categorical"),
        expr: str(dimRaw.expr) ?? colName,
        type_params: dimRaw.type_params,
        granularity: dimRaw.granularity ?? column.granularity,
      });
      if (dim) dimensions.push(dim);
    }
  }
  const derived = isRecord(raw.derived_semantics) ? raw.derived_semantics : {};
  for (const extra of asArray(derived.dimensions)) {
    const dim = parseLegacyDimension(extra);
    if (dim) dimensions.push(dim);
  }
  for (const extra of asArray(derived.entities)) {
    const entity = parseEntity(extra);
    if (entity) entities.push(entity);
  }
  const primary = entities.find((e) => e.type === "primary");
  const metrics: MfMetric[] = [];
  for (const metric of asArray(raw.metrics)) {
    const parsed = parseEmbeddedMetric(metric, sourcePath, name);
    if (parsed) metrics.push(parsed);
  }
  return {
    name,
    description: str(raw.description) ?? str(block.description),
    table: modelName,
    dbtModel: modelName,
    primaryEntity: str(raw.primary_entity) ?? str(block.primary_entity) ?? primary?.name ?? name,
    aggTimeDimension:
      str(raw.agg_time_dimension) ?? str(block.agg_time_dimension) ?? str(raw.defaults && isRecord(raw.defaults) ? raw.defaults.agg_time_dimension : undefined),
    entities,
    dimensions,
    measures: asArray(raw.measures).map(parseMeasure).filter((m): m is MfMeasure => m !== null),
    metrics,
    sourcePath,
  };
}

function parseEntity(raw: unknown): MfEntity | null {
  if (!isRecord(raw)) return null;
  const type = (str(raw.type) ?? "foreign").toLowerCase();
  if (type !== "primary" && type !== "foreign" && type !== "unique" && type !== "natural") return null;
  const name = str(raw.name);
  const expr = simpleColumn(str(raw.expr), name ?? undefined);
  if (!name || !expr) return null;
  return { name, type, expr };
}

function parseLegacyDimension(raw: unknown): MfDimension | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const typeRaw = (str(raw.type) ?? "categorical").toLowerCase();
  const type = typeRaw === "time" ? "time" : "categorical";
  const expr = str(raw.expr) ?? name;
  const params = isRecord(raw.type_params) ? raw.type_params : {};
  const granularity = type === "time" ? (str(params.time_granularity) ?? str(raw.granularity))?.toLowerCase() : undefined;
  return { name, type, expr, column: simpleColumn(expr), ...(granularity ? { granularity } : {}) };
}

function parseNonAdditive(raw: unknown): MfNonAdditive | undefined {
  if (!isRecord(raw)) return undefined;
  const name = str(raw.name);
  if (!name) return undefined;
  const windowAgg = (str(raw.window_agg) ?? str(raw.window_choice) ?? "").toLowerCase();
  const groupings = raw.group_by ?? raw.window_groupings;
  const groupBy = asArray(groupings)
    .map((g) => (typeof g === "string" ? g.trim() : isRecord(g) ? str(g.name) : undefined))
    .filter((g): g is string => Boolean(g));
  return { name, windowAgg, groupBy };
}

function parseMeasure(raw: unknown): MfMeasure | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  const agg = str(raw.agg);
  if (!name || !agg) return null;
  return {
    name,
    agg,
    expr: exprText(raw.expr) ?? name,
    createMetric: bool(raw.create_metric, false),
    aggTimeDimension: str(raw.agg_time_dimension),
    filter: str(raw.filter),
    description: str(raw.description),
    label: str(raw.label),
    nonAdditive: parseNonAdditive(raw.non_additive_dimension),
  };
}

function parseEmbeddedMetric(raw: unknown, sourcePath: string, semanticModel: string): MfMetric | null {
  if (!isRecord(raw)) return null;
  const name = str(raw.name);
  if (!name) return null;
  const params = isRecord(raw.type_params) ? raw.type_params : {};
  return {
    name,
    type: (str(raw.type) ?? "simple").toLowerCase(),
    description: str(raw.description),
    label: str(raw.label),
    filter: str(raw.filter),
    agg: str(raw.agg),
    expr: exprText(raw.expr) ?? exprText(params.expr),
    measure: metricInput(raw.measure ?? params.measure),
    aggTimeDimension: str(raw.agg_time_dimension),
    numerator: metricInput(raw.numerator ?? params.numerator),
    denominator: metricInput(raw.denominator ?? params.denominator),
    inputMetrics: metricInputs(raw.input_metrics ?? params.metrics),
    nonAdditive: parseNonAdditive(raw.non_additive_dimension ?? params.non_additive_dimension),
    semanticModel,
    sourcePath,
  };
}

function parseTopLevelMetric(raw: unknown, sourcePath: string): MfMetric | null {
  const parsed = parseEmbeddedMetric(raw, sourcePath, "");
  if (!parsed || !isRecord(raw)) return parsed;
  const params = isRecord(raw.type_params) ? raw.type_params : {};
  parsed.semanticModel = parsed.semanticModel || str(params.semantic_model) || undefined;
  return parsed;
}

const KNOWN_INPUT_KEYS = new Set(["name", "alias", "filter", "offset_window", "offset_to_grain"]);

/** A metric/measure input: bare name or `{ name, filter, alias, offset_window, ... }`. Nothing is dropped silently. */
function metricInput(value: unknown): MfMetricInput | undefined {
  if (typeof value === "string" && value.trim()) return { name: value.trim(), extraKeys: [] };
  if (!isRecord(value)) return undefined;
  const name = str(value.name);
  if (!name) return undefined;
  const extraKeys = Object.keys(value).filter(
    (key) => !KNOWN_INPUT_KEYS.has(key) && !["join_to_timespine", "fill_nulls_with"].includes(key),
  );
  return {
    name,
    alias: str(value.alias),
    filter: str(value.filter),
    offsetWindow: str(value.offset_window),
    offsetToGrain: str(value.offset_to_grain),
    extraKeys,
  };
}

function metricInputs(value: unknown): MfMetricInput[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(metricInput).filter((input): input is MfMetricInput => input !== undefined);
}

export function parseSemanticManifest(path: string, contents?: string): MetricFlowGraph {
  const rawText = contents ?? readFileSync(path, "utf8");
  const doc = JSON.parse(rawText) as unknown;
  const graph: MetricFlowGraph = { models: [], metrics: [], warnings: [] };
  if (!isRecord(doc)) {
    graph.warnings.push(`semantic_manifest.json at ${path} is not an object.`);
    return graph;
  }
  for (const model of asArray(doc.semantic_models)) {
    if (!isRecord(model)) continue;
    const name = str(model.name);
    if (!name) continue;
    const relation = isRecord(model.node_relation) ? model.node_relation : {};
    const table = str(relation.alias) ?? name;
    const entities = asArray(model.entities).map(parseEntity).filter((e): e is MfEntity => e !== null);
    const primary = entities.find((e) => e.type === "primary");
    const defaults = isRecord(model.defaults) ? model.defaults : {};
    graph.models.push({
      name,
      description: str(model.description),
      table,
      dbtModel: table,
      primaryEntity: str(model.primary_entity) ?? primary?.name ?? name,
      aggTimeDimension: str(defaults.agg_time_dimension) ?? str(model.agg_time_dimension),
      entities,
      dimensions: asArray(model.dimensions)
        .map(parseLegacyDimension)
        .filter((d): d is MfDimension => d !== null),
      measures: asArray(model.measures).map(parseMeasure).filter((m): m is MfMeasure => m !== null),
      metrics: [],
      sourcePath: path,
    });
  }
  for (const metric of asArray(doc.metrics)) {
    const parsed = parseTopLevelMetric(metric, path);
    if (parsed) graph.metrics.push(parsed);
  }
  return graph;
}

export function parseDbtManifestRelations(path: string): Map<string, string> {
  const tables = new Map<string, string>();
  if (!existsSync(path) || !statSync(path).isFile()) return tables;
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(doc) || !isRecord(doc.nodes)) return tables;
    for (const node of Object.values(doc.nodes)) {
      if (!isRecord(node)) continue;
      const resource = str(node.resource_type);
      if (resource && resource !== "model") continue;
      const name = str(node.alias) ?? str(node.name);
      if (!name) continue;
      const unique = str(node.unique_id) ?? "";
      const modelName = unique.includes(".") ? unique.split(".").pop() : str(node.name);
      if (modelName) tables.set(modelName, name);
      tables.set(name, name);
    }
  } catch {
    // Relation names are optional; YAML still loads.
  }
  return tables;
}

export function applyRelationNames(graph: MetricFlowGraph, relations: Map<string, string>): void {
  if (relations.size === 0) return;
  for (const model of graph.models) {
    const key = model.dbtModel ?? model.name;
    const table = relations.get(key) ?? relations.get(model.name);
    if (table) model.table = table;
  }
}
