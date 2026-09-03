import {
  semiAdditiveGranularitySchema,
  type DimensionConfig,
  type MetricConfig,
  type MetricFilterItem,
  type SemiAdditiveConfig,
} from "../../config/schema.js";
import type { SemanticContribution } from "../types.js";
import { emptyContribution, skipDefinition, withSource } from "../types.js";
import { translateMfFilter } from "./filters.js";
import {
  isNumericLiteral,
  mapAgg,
  simpleColumn,
  SUPPORTED_AGGS,
  type MetricFlowGraph,
  type MfMeasure,
  type MfMetric,
  type MfMetricInput,
  type MfNonAdditive,
  type MfSemanticModel,
} from "./graph.js";

/**
 * Map a MetricFlow graph onto Grane maps.
 *
 * Only constructs whose semantics Grane can reproduce exactly are imported.
 * Everything else is recorded under `unsupported` with the reason, so agents
 * can see that the upstream definition exists without Grane approximating it.
 * No entity key, join key, snapshot key, or filter target is ever inferred
 * from naming conventions.
 */
export function mapMetricFlowGraph(graph: MetricFlowGraph, provider = "dbt"): SemanticContribution {
  const out = emptyContribution();
  out.warnings.push(...graph.warnings);
  const skip = (kind: "metric" | "dimension" | "entity" | "relationship", name: string, reason: string, path: string) =>
    skipDefinition(out, { kind, name, provider, path, reason });

  // ---- Entities: a primary entity backed by a plain column is required ----
  const models: MfSemanticModel[] = [];
  const dimensionCandidates: DimensionCandidate[] = [];
  for (const model of graph.models) {
    const primary = model.entities.find((e) => e.type === "primary");
    if (!primary?.column) {
      const reason = primary
        ? `semantic model "${model.name}" primary entity "${primary.name}" is a SQL expression ("${primary.expr}"); ` +
          `Grane joins and counts on plain columns only.`
        : `semantic model "${model.name}" has no primary entity backed by a column; ` +
          `Grane needs an explicit primary key and will not assume one.`;
      skip("entity", model.primaryEntity ?? model.name, reason, model.sourcePath);
      for (const measure of model.measures) {
        if (measure.createMetric) skip("metric", measure.name, reason, model.sourcePath);
      }
      for (const metric of model.metrics) skip("metric", metric.name, reason, model.sourcePath);
      continue;
    }
    models.push(model);
  }

  for (const model of models) {
    const source = { provider, path: model.sourcePath };
    let entityName = model.primaryEntity ?? model.name;
    const existing = out.entities[entityName];
    if (existing && existing.table !== model.table) {
      entityName = model.name;
    }
    const primary = model.entities.find((e) => e.type === "primary")!;
    out.entities[entityName] = withSource(
      {
        table: model.table,
        primary_key: primary.column!,
        description: model.description,
      },
      source,
    );

    for (const dim of model.dimensions) {
      if (!dim.column) {
        skip(
          "dimension",
          `${model.primaryEntity ?? model.name}__${dim.name}`,
          `dimension expr "${dim.expr}" is a SQL expression; Grane compiles plain column dimensions only.`,
          model.sourcePath,
        );
        continue;
      }
      dimensionCandidates.push({ model, entityName, dim, column: dim.column });
    }
  }

  // ---- Dimensions: one deterministic meaning per public name ----
  // MetricFlow's identity for a dimension is `<entity>__<dimension>`; the
  // bare dimension name is a convenience that MetricFlow itself refuses when
  // more than one semantic model declares it ("ambiguous"). Grane does the
  // same: a short name is exposed only when every declaration of it resolves
  // to the same physical column; otherwise every declaration is exposed under
  // its qualified name and the short name is recorded as unsupported with the
  // qualified alternatives. Nothing here depends on the order the models were
  // read in.
  const byShortName = new Map<string, DimensionCandidate[]>();
  for (const candidate of dimensionCandidates) {
    const list = byShortName.get(candidate.dim.name) ?? [];
    list.push(candidate);
    byShortName.set(candidate.dim.name, list);
  }
  // MetricFlow's public identity is `<primary entity>__<dimension>`, not the
  // Grane entity-map key (which can be remapped when two models share a name).
  const qualifiedName = (candidate: DimensionCandidate) =>
    `${candidate.model.primaryEntity ?? candidate.model.name}__${candidate.dim.name}`;
  const describe = (candidate: DimensionCandidate) =>
    `${candidate.model.primaryEntity ?? candidate.model.name}__${candidate.dim.name} on semantic model "${candidate.model.name}" (${candidate.model.table}.${candidate.column})`;
  const dimensionConfig = (candidate: DimensionCandidate): DimensionConfig =>
    withSource(
      {
        description: `MetricFlow dimension ${describe(candidate)}.`,
        entity: candidate.entityName,
        sql: sqlRef(candidate.model.table, candidate.column),
        type: candidate.dim.type === "time" ? "timestamp" : "string",
      },
      { provider, path: candidate.model.sourcePath },
    );
  const planned = new Map<string, { candidate: DimensionCandidate }>();
  const ambiguousShortNames: { name: string; candidates: DimensionCandidate[] }[] = [];
  for (const [shortName, candidates] of byShortName) {
    const sqls = new Set(candidates.map((c) => sqlRef(c.model.table, c.column)));
    if (sqls.size === 1) {
      // Same physical column everywhere it is declared: one meaning, keep the short name.
      const [first] = [...candidates].sort((a, b) => a.entityName.localeCompare(b.entityName));
      planned.set(shortName, { candidate: first! });
      continue;
    }
    ambiguousShortNames.push({ name: shortName, candidates });
    for (const candidate of candidates) {
      const qualified = qualifiedName(candidate);
      // A qualified name that another declaration uses as its short name would be two meanings again.
      if (byShortName.has(qualified) && qualified !== shortName) {
        skip(
          "dimension",
          qualified,
          `qualified name "${qualified}" collides with a dimension of that name declared by another semantic model.`,
          candidate.model.sourcePath,
        );
        continue;
      }
      const existing = planned.get(qualified);
      if (existing) {
        const existingSql = sqlRef(existing.candidate.model.table, existing.candidate.column);
        const nextSql = sqlRef(candidate.model.table, candidate.column);
        if (existingSql !== nextSql) {
          planned.delete(qualified);
          skip(
            "dimension",
            qualified,
            `"${qualified}" is declared by semantic models "${existing.candidate.model.name}" (${existingSql}) and "${candidate.model.name}" (${nextSql}); the name has no single meaning.`,
            candidate.model.sourcePath,
          );
        }
        continue;
      }
      planned.set(qualified, { candidate });
    }
  }
  for (const { name, candidates } of ambiguousShortNames) {
    const sorted = [...candidates].sort((a, b) => a.entityName.localeCompare(b.entityName));
    skip(
      "dimension",
      name,
      `"${name}" is declared by ${sorted.length} semantic models with different columns (${sorted
        .map((c) => `${c.model.name}: ${c.model.table}.${c.column}`)
        .join("; ")}), so the short name has no single meaning. Use ${sorted.map((c) => `"${qualifiedName(c)}"`).join(" or ")}.`,
      sorted[0]!.model.sourcePath,
    );
  }
  for (const [name, { candidate }] of [...planned].sort(([a], [b]) => a.localeCompare(b))) {
    out.dimensions[name] = dimensionConfig(candidate);
  }

  // ---- Relationships ----
  // MetricFlow joins two semantic models on an entity that BOTH declare by
  // name: the left side's entity expr equals the right side's entity expr,
  // and the right side must declare it as primary or unique (a natural key
  // needs validity windows, which Grane does not model). Semantic model names
  // and table names play no part — see metricflow_semantics/model/semantics/
  // semantic_model_join_evaluator.py (_VALID_ENTITY_JOINS).
  //
  // Grane imports the many-to-one shape (foreign or natural on the left).
  // Primary/unique-to-primary/unique joins are one-to-one upstream; Grane's
  // path resolver would treat such an edge as a second route to tables a fact
  // already reaches directly and refuse as ambiguous, so they are recorded as
  // unsupported rather than imported.
  const seenPairs = new Set<string>();
  for (const model of models) {
    const source = { provider, path: model.sourcePath };
    for (const entity of model.entities) {
      if (entity.type === "primary") continue;
      const subject = `${model.name}.${entity.name}`;
      const candidates = models.filter((m) => m.table !== model.table && m.entities.some((e) => e.name === entity.name));
      if (candidates.length === 0) {
        const namesake = graph.models.find((m) => m !== model && (m.name === entity.name || m.table === entity.name));
        skip(
          "relationship",
          subject,
          `no other semantic model declares entity "${entity.name}"` +
            (namesake ? `; semantic model "${namesake.name}" is only named like it, which is not a join key` : "") +
            `.`,
          model.sourcePath,
        );
        continue;
      }
      if (!entity.column) {
        skip(
          "relationship",
          subject,
          `entity "${entity.name}" expr "${entity.expr}" is a SQL expression; Grane joins on plain columns only.`,
          model.sourcePath,
        );
        continue;
      }
      let imported = 0;
      const blocked: string[] = [];
      for (const target of candidates) {
        const right = target.entities.find((e) => e.name === entity.name)!;
        if (right.type === "foreign") continue; // foreign -> foreign never joins (fan-out); not a declared target
        if (right.type === "natural") {
          blocked.push(`"${target.name}" declares it as a natural key and Grane does not model validity windows`);
          continue;
        }
        if (!right.column) {
          blocked.push(`"${target.name}" declares it with a SQL expression ("${right.expr}") and Grane joins on plain columns only`);
          continue;
        }
        if (entity.type === "unique") {
          blocked.push(`"${target.name}" declares it as ${right.type} and one-to-one joins between primary/unique entities are not imported`);
          continue;
        }
        const from = `${model.table}.${entity.column}`;
        const to = `${target.table}.${right.column}`;
        // One relationship per column pair; the graph adds the inverse edge itself.
        const pairKey = [from, to].sort().join("|");
        imported++;
        if (seenPairs.has(pairKey)) continue;
        seenPairs.add(pairKey);
        const base = `${model.table}_to_${target.table}`;
        out.relationships[base in out.relationships ? `${base}_via_${entity.name}` : base] = withSource(
          { from, to, type: "many_to_one" },
          source,
        );
      }
      if (imported === 0) {
        skip(
          "relationship",
          subject,
          blocked.length > 0
            ? `entity "${entity.name}" has no joinable target: ${blocked.join("; ")}.`
            : `entity "${entity.name}" is only a foreign key on every semantic model that declares it; no primary or unique declaration to join to.`,
          model.sourcePath,
        );
      }
    }
  }

  const measureIndex = new Map<string, { model: MfSemanticModel; measure: MfMeasure }>();
  for (const model of models) {
    for (const measure of model.measures) {
      measureIndex.set(measure.name, { model, measure });
    }
  }

  const ctx: MapContext = { out, provider, models, measureIndex, skip };

  // ---- Simple metrics first (measures with create_metric, embedded, top-level) ----
  const pending: { metric: MfMetric; model: MfSemanticModel | undefined }[] = [];
  for (const model of models) {
    for (const measure of model.measures) {
      if (!measure.createMetric) continue;
      emitSimple(ctx, measure.name, model, measure.agg, measure.expr, {
        description: measure.description,
        label: measure.label,
        filters: [measure.filter],
        aggTimeDimension: measure.aggTimeDimension,
        nonAdditive: measure.nonAdditive,
        sourcePath: model.sourcePath,
      });
    }
    for (const metric of model.metrics) pending.push({ metric, model });
  }
  for (const metric of graph.metrics) {
    const model =
      (metric.semanticModel ? models.find((m) => m.name === metric.semanticModel) : undefined) ??
      (metric.measure ? measureIndex.get(metric.measure.name)?.model : undefined);
    pending.push({ metric, model });
  }

  const compound: typeof pending = [];
  for (const item of pending) {
    const type = item.metric.type;
    if (type === "ratio" || type === "derived") {
      compound.push(item);
    } else {
      addSimpleMetric(ctx, item.metric, item.model);
    }
  }
  // ---- Ratios and simple derived ratios, after every component is known ----
  for (const item of compound) addCompoundMetric(ctx, item.metric);

  return out;
}

interface MapContext {
  out: SemanticContribution;
  provider: string;
  models: MfSemanticModel[];
  measureIndex: Map<string, { model: MfSemanticModel; measure: MfMeasure }>;
  skip: (kind: "metric" | "dimension" | "entity" | "relationship", name: string, reason: string, path: string) => void;
}

interface SimpleOptions {
  description?: string;
  label?: string;
  /** Filters from every layer (measure, metric, metric input) — all are applied. */
  filters: (string | undefined)[];
  aggTimeDimension?: string;
  nonAdditive?: MfNonAdditive;
  /** Raw `fill_nulls_with`; MetricFlow accepts an integer only. */
  fillNullsWith?: unknown;
  joinToTimespine?: boolean;
  sourcePath: string;
}

function sqlRef(table: string, column: string): string {
  return `\${${table}.${column}}`;
}

interface DimensionCandidate {
  model: MfSemanticModel;
  entityName: string;
  dim: MfSemanticModel["dimensions"][number];
  column: string;
}

function entityNameFor(model: MfSemanticModel, out: SemanticContribution): string {
  const primary = model.primaryEntity ?? model.name;
  if (out.entities[primary]?.table === model.table) return primary;
  if (out.entities[model.name]?.table === model.table) return model.name;
  return primary;
}

/** A declared time dimension's column, or null when the name is not a declared time dimension. */
function timeDimensionColumn(model: MfSemanticModel, name: string | undefined): string | null {
  if (!name) return null;
  const dim = model.dimensions.find((d) => d.type === "time" && (d.name === name || d.column === name));
  return dim?.column ?? null;
}

function emitSimple(
  ctx: MapContext,
  name: string,
  model: MfSemanticModel,
  agg: string,
  expr: string,
  opts: SimpleOptions,
): void {
  const { out } = ctx;
  const fail = (reason: string) => ctx.skip("metric", name, reason, opts.sourcePath);

  const mapped = mapAgg(agg);
  if (!mapped) {
    return fail(`aggregation "${agg}" is not compiled by Grane (supported: ${SUPPORTED_AGGS.join(", ")}).`);
  }
  const entityName = entityNameFor(model, out);

  // Measure expression: a column, or a literal for row counts (COUNT(1)).
  let column: string | null = null;
  let countsRows = false;
  if (isNumericLiteral(expr)) {
    if (mapped !== "count") {
      return fail(`expr "${expr}" is a literal; only agg: count over a literal (a row count) is compiled.`);
    }
    countsRows = true;
  } else {
    column = simpleColumn(expr);
    if (!column) {
      return fail(`expr "${expr}" is not a plain column; Grane compiles \${table.column} references only.`);
    }
  }

  // Time: must be a declared time dimension of this model, never a guessed column.
  const timeName = opts.aggTimeDimension ?? model.aggTimeDimension;
  const timeCol = timeDimensionColumn(model, timeName);
  if (timeName && !timeCol) {
    return fail(`agg_time_dimension "${timeName}" is not a declared time dimension on semantic model "${model.name}".`);
  }

  // Filters from every layer, operator preserved.
  const filters: MetricFilterItem[] = [];
  for (const raw of opts.filters) {
    if (!raw) continue;
    const translated = translateMfFilter(raw, model);
    if ("error" in translated) return fail(`${translated.error}.`);
    filters.push(...translated.filters);
  }

  // Semi-additive: everything comes from non_additive_dimension, explicitly.
  let semi: SemiAdditiveConfig | undefined;
  if (opts.nonAdditive) {
    const na = opts.nonAdditive;
    if (mapped !== "sum" && mapped !== "min" && mapped !== "max") {
      return fail(`non_additive_dimension with agg "${agg}" is not compiled; Grane supports semi-additive sum, min, and max.`);
    }
    if (!timeCol) {
      return fail(`non_additive_dimension "${na.name}" needs an agg_time_dimension on the metric or semantic model.`);
    }
    const asOfDim = model.dimensions.find((d) => d.type === "time" && (d.name === na.name || d.column === na.name));
    if (!asOfDim?.column) {
      return fail(`non_additive_dimension "${na.name}" is not a declared time dimension on semantic model "${model.name}".`);
    }
    if (asOfDim.column !== timeCol) {
      return fail(
        `non_additive_dimension "${na.name}" differs from agg_time_dimension "${timeName}"; ` +
          `Grane chooses the snapshot on the metric's own time dimension only.`,
      );
    }
    const window = na.windowAgg === "max" ? "last" : na.windowAgg === "min" ? "first" : null;
    if (!window) {
      return fail(`non_additive_dimension window "${na.windowAgg || "(missing)"}" is not min or max.`);
    }
    // MetricFlow compares the snapshot date at the dimension's declared granularity.
    const granularity = semiAdditiveGranularitySchema.safeParse(asOfDim.granularity);
    if (!granularity.success) {
      return fail(
        `non_additive_dimension "${na.name}" has time granularity "${asOfDim.granularity ?? "(missing)"}"; ` +
          `Grane compiles snapshot selection at day, week, month, quarter, or year granularity only.`,
      );
    }
    const groupBy: string[] = [];
    for (const entityRef of na.groupBy) {
      const entity = model.entities.find((e) => e.name === entityRef);
      if (!entity) {
        return fail(
          `non_additive_dimension group_by "${entityRef}" is not an entity on semantic model "${model.name}"; ` +
            `Grane will not infer the snapshot key.`,
        );
      }
      if (entity.type === "primary" || entity.type === "unique") {
        return fail(
          `non_additive_dimension group_by "${entityRef}" is a ${entity.type} entity of semantic model "${model.name}"; ` +
            `that key identifies one snapshot row, so first/last would keep every historical row. ` +
            `Group by a foreign entity (a continuing series) or omit group_by for one global snapshot.`,
        );
      }
      if (!entity.column) {
        return fail(
          `non_additive_dimension group_by "${entityRef}" expr "${entity.expr}" is a SQL expression; Grane keys snapshots on plain columns only.`,
        );
      }
      groupBy.push(sqlRef(model.table, entity.column));
    }
    semi = { window, group_by: groupBy, granularity: granularity.data };
  }

  // fill_nulls_with is COALESCE over the aggregate in MetricFlow; anything but an integer is not its semantics.
  let fillNullsWith: number | undefined;
  if (opts.fillNullsWith !== undefined && opts.fillNullsWith !== null) {
    if (typeof opts.fillNullsWith !== "number" || !Number.isInteger(opts.fillNullsWith)) {
      return fail(`fill_nulls_with ${JSON.stringify(opts.fillNullsWith)} is not an integer; MetricFlow accepts integers only.`);
    }
    fillNullsWith = opts.fillNullsWith;
  }

  const synonyms = opts.label && opts.label !== name ? [opts.label] : [];
  const config: MetricConfig = withSource(
    {
      description: opts.description,
      entity: entityName,
      type: mapped,
      sql: countsRows ? undefined : sqlRef(model.table, column!),
      time_dimension: timeCol ? sqlRef(model.table, timeCol) : undefined,
      synonyms,
      filters: filters.length > 0 ? filters : undefined,
      additive: semi ? "semi" : undefined,
      semi_additive: semi,
      fill_nulls_with: fillNullsWith,
      join_to_timespine: opts.joinToTimespine ? true : undefined,
      status: "approved",
    },
    { provider: ctx.provider, path: opts.sourcePath },
  );
  out.metrics[name] = config;
}

function describeInput(input: MfMetricInput, measureInput = false): string | null {
  const parts: string[] = [];
  if (input.offsetWindow) parts.push(`offset_window "${input.offsetWindow}"`);
  if (input.offsetToGrain) parts.push(`offset_to_grain "${input.offsetToGrain}"`);
  if (input.alias) parts.push(`alias "${input.alias}"`);
  // Only a measure input may carry fill_nulls_with / join_to_timespine in MetricFlow.
  if (!measureInput && input.fillNullsWith !== undefined) parts.push(`"fill_nulls_with"`);
  if (!measureInput && input.joinToTimespine) parts.push(`"join_to_timespine"`);
  for (const key of input.extraKeys) parts.push(`"${key}"`);
  return parts.length > 0 ? parts.join(", ") : null;
}

function addSimpleMetric(ctx: MapContext, metric: MfMetric, model: MfSemanticModel | undefined): void {
  const fail = (reason: string) => ctx.skip("metric", metric.name, reason, metric.sourcePath);
  const type = metric.type;
  if (type === "cumulative" || type === "conversion") {
    return fail(`MetricFlow type "${type}" is not compiled by Grane.`);
  }
  if (type !== "simple") {
    return fail(`MetricFlow type "${type}" is not recognised by Grane.`);
  }

  if (metric.measure) {
    const found = ctx.measureIndex.get(metric.measure.name);
    if (!found) {
      return fail(`measure "${metric.measure.name}" was not found on any imported semantic model.`);
    }
    const unsupportedInput = describeInput(metric.measure, true);
    if (unsupportedInput) return fail(`measure input uses ${unsupportedInput}, which Grane does not model.`);
    if (metric.nonAdditive && found.measure.nonAdditive) {
      return fail(`non_additive_dimension is declared on both the metric and measure "${found.measure.name}".`);
    }
    // With a measure input, MetricFlow takes fill_nulls_with / join_to_timespine from the input and ignores
    // the metric-level fields (validation warns about them).
    emitSimple(ctx, metric.name, found.model, found.measure.agg, found.measure.expr, {
      description: metric.description ?? found.measure.description,
      label: metric.label ?? found.measure.label,
      filters: [found.measure.filter, metric.measure.filter, metric.filter],
      aggTimeDimension: metric.aggTimeDimension ?? found.measure.aggTimeDimension,
      nonAdditive: metric.nonAdditive ?? found.measure.nonAdditive,
      fillNullsWith: metric.measure.fillNullsWith,
      joinToTimespine: metric.measure.joinToTimespine,
      sourcePath: metric.sourcePath,
    });
    return;
  }
  if (!model) {
    return fail(`no semantic model to bind it to.`);
  }
  if (!metric.agg) {
    return fail(`simple metrics need agg or a measure.`);
  }
  emitSimple(ctx, metric.name, model, metric.agg, metric.expr ?? metric.name, {
    description: metric.description,
    label: metric.label,
    filters: [metric.filter],
    aggTimeDimension: metric.aggTimeDimension,
    nonAdditive: metric.nonAdditive,
    fillNullsWith: metric.fillNullsWith,
    joinToTimespine: metric.joinToTimespine,
    sourcePath: metric.sourcePath,
  });
}

function addCompoundMetric(ctx: MapContext, metric: MfMetric): void {
  const { out } = ctx;
  const fail = (reason: string) => ctx.skip("metric", metric.name, reason, metric.sourcePath);

  if (metric.fillNullsWith !== undefined || metric.joinToTimespine) {
    return fail(`fill_nulls_with / join_to_timespine are only defined for simple metrics; MetricFlow rejects them on type "${metric.type}".`);
  }
  let numerator = metric.numerator;
  let denominator = metric.denominator;
  if (metric.type === "derived") {
    const complexInput = (metric.inputMetrics ?? []).map((input) => describeInput(input)).find((d) => d !== null);
    if (complexInput) {
      return fail(`derived metric inputs use ${complexInput}; offsets and aliases are not compiled by Grane.`);
    }
    const ratio = parseDerivedRatio(metric.expr);
    if (!ratio) {
      return fail(`MetricFlow derived expr is not a simple metric / metric ratio; Grane does not compile derived expressions.`);
    }
    numerator = { name: ratio.numerator, extraKeys: [] };
    denominator = { name: ratio.denominator, extraKeys: [] };
  }
  if (!numerator || !denominator) {
    return fail(`ratio metrics need a numerator and a denominator.`);
  }
  if (metric.filter) {
    return fail(`a filter on a ratio metric is not compiled by Grane; filter the components instead.`);
  }
  for (const [role, input] of [
    ["numerator", numerator],
    ["denominator", denominator],
  ] as const) {
    const unsupportedInput = describeInput(input);
    if (unsupportedInput || input.filter) {
      return fail(`${role} "${input.name}" carries ${unsupportedInput ?? "a filter"}, which Grane does not apply to ratio components.`);
    }
    if (!out.metrics[input.name]) {
      const skipped = out.unsupported.find((u) => u.kind === "metric" && u.name === input.name);
      return fail(
        skipped
          ? `${role} "${input.name}" was not imported (${skipped.reason.replace(/\.$/, "")}).`
          : `${role} "${input.name}" is not an imported metric.`,
      );
    }
  }
  const num = out.metrics[numerator.name]!;
  const den = out.metrics[denominator.name]!;
  if (num.entity !== den.entity) {
    return fail(
      `numerator "${numerator.name}" is at entity "${num.entity}" and denominator "${denominator.name}" at "${den.entity}"; ` +
        `cross-grain ratios are not compiled by Grane.`,
    );
  }
  if (num.type === "ratio" || den.type === "ratio") {
    return fail(`nested ratios are not compiled by Grane.`);
  }
  if ((num.additive === "semi") !== (den.additive === "semi")) {
    return fail(`mixes a semi-additive component with an additive one; the snapshot selection would apply to both.`);
  }
  if (num.additive === "semi" && snapshotSignature(num) !== snapshotSignature(den)) {
    return fail(`its semi-additive components choose different snapshot rows (filters, window, or group_by differ).`);
  }
  out.metrics[metric.name] = withSource(
    {
      description: metric.description,
      entity: num.entity,
      type: "ratio",
      numerator: numerator.name,
      denominator: denominator.name,
      synonyms: metric.label && metric.label !== metric.name ? [metric.label] : [],
      status: "approved",
    },
    { provider: ctx.provider, path: metric.sourcePath },
  );
}

function snapshotSignature(metric: MetricConfig): string {
  return JSON.stringify({
    time: metric.time_dimension,
    semi: metric.semi_additive,
    filters: metric.filters,
  });
}

/** `{{ Metric('a') }} / {{ Metric('b') }}` or `a / b` → a Grane ratio. */
export function parseDerivedRatio(expr: string | undefined): { numerator: string; denominator: string } | null {
  if (!expr) return null;
  const cleaned = expr
    .replace(/\{\{\s*Metric\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/gi, "$1")
    .replace(/\s+/g, "");
  const match = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)\/([A-Za-z_][A-Za-z0-9_]*)$/);
  if (!match) return null;
  return { numerator: match[1]!, denominator: match[2]! };
}
