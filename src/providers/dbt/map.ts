import type { DimensionConfig, MetricConfig, MetricType } from "../../config/schema.js";
import type { SemanticContribution } from "../types.js";
import { emptyContribution, withSource } from "../types.js";
import { translateMfFilter } from "./filters.js";
import { mapAgg, simpleColumn, type MetricFlowGraph, type MfMetric, type MfSemanticModel } from "./graph.js";

function sqlRef(table: string, column: string): string {
  return `\${${table}.${column}}`;
}

function timeColumn(model: MfSemanticModel, name: string | undefined): string | undefined {
  if (!name) return undefined;
  const dim = model.dimensions.find((d) => d.name === name || d.expr === name);
  return dim?.expr ?? (simpleColumn(name) ?? undefined);
}

export function mapMetricFlowGraph(graph: MetricFlowGraph, provider = "dbt"): SemanticContribution {
  const out = emptyContribution();
  out.warnings.push(...graph.warnings);

  const models = graph.models;
  const entityByPrimary = new Map<string, MfSemanticModel>();

  for (const model of models) {
    const source = { provider, path: model.sourcePath };
    let entityName = model.primaryEntity ?? model.name;
    const existing = out.entities[entityName];
    if (existing && existing.table !== model.table) {
      entityName = model.name;
    }
    const primary = model.entities.find((e) => e.type === "primary");
    out.entities[entityName] = withSource(
      {
        table: model.table,
        primary_key: primary?.expr ?? "id",
        description: model.description,
      },
      source,
    );
    entityByPrimary.set(model.primaryEntity ?? model.name, model);

    for (const dim of model.dimensions) {
      let dimName = dim.name;
      const clash = out.dimensions[dimName];
      if (clash && clash.sql !== sqlRef(model.table, dim.expr)) {
        dimName = `${entityName}_${dim.name}`;
      }
      const config: DimensionConfig = withSource(
        {
          description: undefined,
          entity: entityName,
          sql: sqlRef(model.table, dim.expr),
          type: dim.type === "time" ? "timestamp" : "string",
        },
        source,
      );
      if (!(dimName in out.dimensions)) {
        out.dimensions[dimName] = config;
      }
    }
  }

  for (const model of models) {
    const source = { provider, path: model.sourcePath };
    for (const entity of model.entities) {
      if (entity.type === "primary") continue;
      const target = models.find((m) => m.primaryEntity === entity.name || m.name === entity.name);
      if (!target || target.table === model.table) continue;
      const targetPrimary = target.entities.find((e) => e.type === "primary");
      const key = `${model.table}_to_${target.table}`;
      if (key in out.relationships) continue;
      out.relationships[key] = withSource(
        {
          from: `${model.table}.${entity.expr}`,
          to: `${target.table}.${targetPrimary?.expr ?? "id"}`,
          type: "many_to_one",
        },
        source,
      );
    }
  }

  const measureIndex = new Map<string, { model: MfSemanticModel; measure: MfSemanticModel["measures"][number] }>();
  for (const model of models) {
    for (const measure of model.measures) {
      measureIndex.set(measure.name, { model, measure });
    }
  }

  const emitSimple = (
    name: string,
    model: MfSemanticModel,
    agg: string,
    expr: string,
    opts: {
      description?: string;
      label?: string;
      filter?: string;
      aggTimeDimension?: string;
      sourcePath: string;
    },
  ): void => {
    const mapped = mapAgg(agg);
    if (!mapped) {
      out.warnings.push(`Skipping metric "${name}": aggregation "${agg}" is not supported by Grane.`);
      return;
    }
    const entityName = entityNameFor(model, out);
    const column =
      mapped === "count" && (expr === "1" || !expr)
        ? out.entities[entityName]?.primary_key ?? "id"
        : simpleColumn(expr, expr);
    if (!column) {
      out.warnings.push(
        `Skipping metric "${name}": expr "${expr}" is not a simple column. Grane compiles \${table.column} references only.`,
      );
      return;
    }
    const timeName = opts.aggTimeDimension ?? model.aggTimeDimension;
    const timeCol = timeColumn(model, timeName);
    let filters = undefined;
    if (opts.filter) {
      const translated = translateMfFilter(opts.filter, model, models);
      if ("error" in translated) {
        out.warnings.push(`Skipping metric "${name}": ${translated.error}.`);
        return;
      }
      filters = Object.fromEntries(translated.filters.map((f) => [f.field, f.value as string | number | boolean | null]));
    }
    const synonyms = opts.label && opts.label !== name ? [opts.label] : [];
    const config: MetricConfig = withSource(
      {
        description: opts.description,
        entity: entityName,
        type: mapped,
        sql: sqlRef(model.table, column),
        time_dimension: timeCol ? sqlRef(model.table, timeCol) : undefined,
        synonyms,
        filters: filters && Object.keys(filters).length > 0 ? filters : undefined,
        status: "approved",
      },
      { provider, path: opts.sourcePath },
    );
    out.metrics[name] = config;
  };

  for (const model of models) {
    for (const measure of model.measures) {
      if (!measure.createMetric) continue;
      emitSimple(measure.name, model, measure.agg, measure.expr, {
        description: measure.description,
        label: measure.label,
        filter: measure.filter,
        aggTimeDimension: measure.aggTimeDimension,
        sourcePath: model.sourcePath,
      });
    }
    for (const metric of model.metrics) {
      addMetric(metric, model, emitSimple, out, measureIndex, models, provider);
    }
  }

  for (const metric of graph.metrics) {
    const model =
      (metric.semanticModel ? models.find((m) => m.name === metric.semanticModel) : undefined) ??
      (metric.measure ? measureIndex.get(metric.measure)?.model : undefined) ??
      guessModelForMetric(metric, models);
    addMetric(metric, model, emitSimple, out, measureIndex, models, provider);
  }

  return out;
}

function entityNameFor(model: MfSemanticModel, out: SemanticContribution): string {
  const primary = model.primaryEntity ?? model.name;
  if (out.entities[primary]?.table === model.table) return primary;
  if (out.entities[model.name]?.table === model.table) return model.name;
  return primary;
}

function addMetric(
  metric: MfMetric,
  model: MfSemanticModel | undefined,
  emitSimple: (
    name: string,
    model: MfSemanticModel,
    agg: string,
    expr: string,
    opts: {
      description?: string;
      label?: string;
      filter?: string;
      aggTimeDimension?: string;
      sourcePath: string;
    },
  ) => void,
  out: SemanticContribution,
  measureIndex: Map<string, { model: MfSemanticModel; measure: MfSemanticModel["measures"][number] }>,
  models: MfSemanticModel[],
  provider: string,
): void {
  const type = metric.type.toLowerCase();
  if (type === "derived" || type === "cumulative" || type === "conversion") {
    out.warnings.push(
      `Skipping metric "${metric.name}": MetricFlow type "${metric.type}" is not compiled by Grane yet.`,
    );
    return;
  }
  if (type === "ratio") {
    const numerator = metric.numerator;
    const denominator = metric.denominator;
    if (!numerator || !denominator) {
      out.warnings.push(`Skipping ratio metric "${metric.name}": numerator and denominator are required.`);
      return;
    }
    const numModel =
      model ??
      measureIndex.get(numerator)?.model ??
      (out.metrics[numerator]
        ? models.find((m) => m.table === tableFromSql(out.metrics[numerator]?.sql))
        : undefined);
    const entity = numModel ? entityNameFor(numModel, out) : out.metrics[numerator]?.entity;
    if (!entity) {
      out.warnings.push(`Skipping ratio metric "${metric.name}": could not resolve an entity.`);
      return;
    }
    out.metrics[metric.name] = withSource(
      {
        description: metric.description,
        entity,
        type: "ratio" as MetricType,
        numerator,
        denominator,
        synonyms: metric.label && metric.label !== metric.name ? [metric.label] : [],
        status: "approved",
      },
      { provider, path: metric.sourcePath },
    );
    return;
  }

  // simple
  if (metric.measure) {
    const found = measureIndex.get(metric.measure);
    if (!found) {
      out.warnings.push(`Skipping metric "${metric.name}": measure "${metric.measure}" was not found.`);
      return;
    }
    emitSimple(metric.name, found.model, found.measure.agg, found.measure.expr, {
      description: metric.description ?? found.measure.description,
      label: metric.label ?? found.measure.label,
      filter: metric.filter ?? found.measure.filter,
      aggTimeDimension: metric.aggTimeDimension ?? found.measure.aggTimeDimension,
      sourcePath: metric.sourcePath,
    });
    return;
  }
  if (!model) {
    out.warnings.push(`Skipping metric "${metric.name}": no semantic model to bind it to.`);
    return;
  }
  if (!metric.agg) {
    out.warnings.push(`Skipping metric "${metric.name}": simple metrics need agg or a measure.`);
    return;
  }
  emitSimple(metric.name, model, metric.agg, metric.expr ?? metric.name, {
    description: metric.description,
    label: metric.label,
    filter: metric.filter,
    aggTimeDimension: metric.aggTimeDimension,
    sourcePath: metric.sourcePath,
  });
}

function guessModelForMetric(metric: MfMetric, models: MfSemanticModel[]): MfSemanticModel | undefined {
  if (metric.semanticModel) return models.find((m) => m.name === metric.semanticModel);
  return undefined;
}

function tableFromSql(sql: string | undefined): string | undefined {
  const match = sql?.match(/\$\{([A-Za-z_][A-Za-z0-9_]*)\./);
  return match?.[1];
}
