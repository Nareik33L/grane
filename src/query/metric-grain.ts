import type { SemiAdditiveGranularity, WeekStarts } from "../config/schema.js";
import { unsafeQuery } from "../errors.js";
import type { Metric } from "../model/model.js";
import type { TimeGrain } from "./model.js";
import { alignCivilRangeToGrain, TIME_GRAIN_ORDER } from "./time.js";

/**
 * Native grain of a metric's agg time dimension. Omitted or `day` means
 * civil `from`/`to` bounds (no MetricFlow period expansion).
 */
export function nativeTimeGranularity(metric: Metric): SemiAdditiveGranularity | null {
  return metric.config.time_granularity ?? null;
}

function isCoarseGrain(grain: SemiAdditiveGranularity | null): grain is Exclude<SemiAdditiveGranularity, "day"> {
  return grain !== null && grain !== "day";
}

/**
 * Align a requested civil range to the native grain of the query's metrics.
 *
 * MetricFlow 0.212 expands a query window to complete periods of the agg
 * time dimension's granularity (Aug 2–15 on a month-grain snapshot becomes
 * Aug 1–31). Grane's default civil bounds would clip that snapshot DATE
 * out of the range and still return `trust: governed`. When every component
 * shares one coarse grain, expand here so the compiled bounds match that
 * provider. Mixed coarse grains, or coarse mixed with civil-day metrics,
 * refuse rather than aligning one and clipping the other.
 */
export function alignQueryTimeToMetricGrains(
  components: Metric[],
  from: string,
  to: string,
  weekStarts: WeekStarts,
): { from: string; to: string; note: string | null } {
  const coarse = new Map<string, Exclude<SemiAdditiveGranularity, "day">>();
  const civil: string[] = [];
  for (const metric of components) {
    const grain = nativeTimeGranularity(metric);
    if (isCoarseGrain(grain)) coarse.set(metric.name, grain);
    else civil.push(metric.name);
  }
  const uniqueCoarse = [...new Set(coarse.values())];
  if (uniqueCoarse.length === 0) return { from, to, note: null };
  if (uniqueCoarse.length > 1) {
    const listed = [...coarse.entries()].map(([name, grain]) => `"${name}" (${grain})`).join(", ");
    throw unsafeQuery(
      `This query mixes metrics at different native time grains (${listed}). ` +
        `Grane will not align one civil range two ways. Query them separately.`,
      { metrics: Object.fromEntries(coarse) },
    );
  }
  const grain = uniqueCoarse[0]!;
  if (civil.length > 0) {
    throw unsafeQuery(
      `This query mixes ${grain}-grain metric(s) (${[...coarse.keys()].join(", ")}) ` +
        `with metric(s) that use civil day bounds (${civil.join(", ")}). ` +
        `Aligning the range to ${grain} would change the day-grain metrics; ` +
        `leaving it unaligned would change the ${grain}-grain metrics. Query them separately.`,
      { coarse_metrics: [...coarse.keys()], civil_metrics: civil, time_granularity: grain },
    );
  }
  const aligned = alignCivilRangeToGrain(from, to, grain, weekStarts);
  if (aligned.from === from && aligned.to === to) return { from, to, note: null };
  return {
    from: aligned.from,
    to: aligned.to,
    note:
      `time range ${from}..${to} aligned to ${grain} grain ${aligned.from}..${aligned.to} ` +
      `so a ${grain}-grain time column is not clipped to a partial period ` +
      `(MetricFlow query-window alignment).`,
  };
}

/**
 * Grouping by a grain finer than the metric's native grain would put one
 * period-grain value into several output buckets. Refuse rather than let
 * `GROUP BY DATE_TRUNC(day, month_start)` silently redefine the metric.
 */
export function assertOutputGrainCompatible(components: Metric[], grain: TimeGrain | null): void {
  if (!grain) return;
  for (const metric of components) {
    const native = nativeTimeGranularity(metric);
    if (!isCoarseGrain(native)) continue;
    if (TIME_GRAIN_ORDER[grain] < TIME_GRAIN_ORDER[native]) {
      throw unsafeQuery(
        `Metric "${metric.name}" is defined at ${native} grain; ` +
          `a ${grain} grouping would split one ${native} period across buckets. Use ${native} or coarser.`,
        { metric: metric.name, time_granularity: native, requested_grain: grain },
      );
    }
  }
}
