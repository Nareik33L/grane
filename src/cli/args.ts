import type { QueryFilter, SemanticQueryInput, TimeGrain } from "../query/model.js";

/**
 * `--filter` accepts `field=value`, `field!=value` and `field<>value`. The
 * field is everything before the first operator, so a `=`, `!` or `<>` inside
 * the value is kept verbatim (`status=a=b` → field `status`, value `a=b`).
 * Only operators the kernel already compiles are recognised.
 */
export function parseFilterSpec(expr: string): QueryFilter {
  const match = /^([^=!<>]+)(!=|<>|=)(.*)$/s.exec(expr);
  if (!match) {
    throw new Error(`Invalid --filter "${expr}"; use field=value, field!=value or field<>value.`);
  }
  const [, field, op, value] = match as unknown as [string, string, string, string];
  return { field, operator: op === "=" ? "=" : "!=", value };
}

export function parseRawMetricSpec(spec: string): {
  field: string;
  type: "sum" | "count" | "count_distinct" | "avg" | "min" | "max";
} {
  const types = ["count_distinct", "count", "sum", "avg", "min", "max"] as const;
  for (const type of types) {
    if (spec.startsWith(`${type}:`)) {
      return { field: spec.slice(type.length + 1), type };
    }
  }
  return { field: spec, type: "count" };
}

export interface CliQueryFlags {
  dimension?: string[];
  rawDimension?: string[];
  rawMetric?: string[];
  filter?: string[];
  last?: string;
  from?: string;
  to?: string;
  grain?: string;
  timeDimension?: string;
  limit?: string;
}

/**
 * Map CLI flags onto the public Query Model. Does not add time semantics —
 * it only exposes fields the kernel already accepts, including `time.dimension`.
 */
export function buildCliQuery(metrics: string[], options: CliQueryFlags): SemanticQueryInput {
  const query: SemanticQueryInput = { metrics: metrics ?? [] };
  if (options.dimension) query.dimensions = options.dimension;
  if (options.rawDimension) query.raw_dimensions = options.rawDimension;
  if (options.rawMetric) query.raw_metrics = options.rawMetric.map(parseRawMetricSpec);
  if (options.filter) query.filters = options.filter.map(parseFilterSpec);
  const time = buildCliTime(options);
  if (time) query.time = time;
  if (options.limit) query.limit = Number(options.limit);
  return query;
}

function buildCliTime(options: CliQueryFlags): SemanticQueryInput["time"] | undefined {
  const hasRange = Boolean(options.last || options.from || options.to);
  if (!hasRange) {
    if (options.grain) throw new Error("--grain requires --last or --from/--to.");
    if (options.timeDimension) throw new Error("--time-dimension requires --last or --from/--to.");
    return undefined;
  }
  const grain = options.grain ? (options.grain as TimeGrain) : undefined;
  const dimension = options.timeDimension;
  if (options.last) {
    if (options.from || options.to) {
      throw new Error("Provide either --last, or both --from and --to.");
    }
    return {
      period: options.last,
      ...(grain ? { grain } : {}),
      ...(dimension ? { dimension } : {}),
    };
  }
  if (!options.from || !options.to) {
    throw new Error("Provide either --last, or both --from and --to.");
  }
  return {
    from: options.from,
    to: options.to,
    ...(grain ? { grain } : {}),
    ...(dimension ? { dimension } : {}),
  };
}
