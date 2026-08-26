/**
 * Mutation testing of the Gauntlet itself.
 *
 * If we deliberately break Grane and the suite stays green, the suite is too
 * weak. These helpers inject known defect classes and return the verdicts
 * the Gauntlet would record.
 */

import type { GraneKernel } from "../../src/kernel.js";
import type { SemanticQueryInput } from "../../src/query/model.js";
import { compileQuery } from "../../src/compile/compiler.js";
import { isValidCivilDate } from "../../src/query/time.js";
import { executionPolicy } from "../../src/execute/executor.js";
import { runScenario, type Harness } from "./harness.js";
import type { Scenario, Verdict } from "./types.js";

async function restoreAfter<T>(fn: () => Promise<T>, restore: () => void): Promise<T> {
  try {
    return await fn();
  } finally {
    restore();
  }
}

export async function withDisabledFanout<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const graph = kernel.model.graph;
  const original = graph.findPath.bind(graph);
  graph.findPath = (from, to) => {
    const path = original(from, to);
    if (!path) return path;
    return {
      ...path,
      fansOut: false,
    };
  };
  return restoreAfter(fn, () => {
    graph.findPath = original;
  });
}

export async function withDisabledCardinalityValidation<T>(
  kernel: GraneKernel,
  fn: () => Promise<T>,
): Promise<T> {
  const graph = kernel.model.graph;
  const original = graph.findPath.bind(graph);
  graph.findPath = (from, to) => {
    const path = original(from, to);
    if (!path) return path;
    return {
      ...path,
      fansOut: false,
      edges: path.edges.map((edge) => ({
        ...edge,
        cardinality: edge.cardinality === "one_to_many" ? "many_to_one" : edge.cardinality,
      })),
    };
  };
  return restoreAfter(fn, () => {
    graph.findPath = original;
  });
}

export async function withDisabledGrainValidation<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const original = kernel.resolve.bind(kernel);
  kernel.resolve = (input) => {
    try {
      return original(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/same entity\/grain|span/i.test(message) && input.metrics && input.metrics.length > 1) {
        return original({ ...input, metrics: [input.metrics[0]!] });
      }
      throw err;
    }
  };
  return restoreAfter(fn, () => {
    kernel.resolve = original;
  });
}

export async function withEmptyExclude<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const previous = kernel.config.exploration.exclude;
  kernel.config.exploration.exclude = [];
  return restoreAfter(fn, () => {
    kernel.config.exploration.exclude = previous;
  });
}

export async function withNaiveSemiAdditive<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const restored: Array<{ metric: { config: { additive?: "full" | "semi" | "none" } }; additive: "semi" }> = [];
  for (const metric of kernel.model.metrics.values()) {
    if (metric.config.additive === "semi") {
      restored.push({ metric, additive: "semi" });
      metric.config.additive = "full";
    }
  }
  return restoreAfter(fn, () => {
    for (const item of restored) item.metric.config.additive = item.additive;
  });
}

export async function withForcedGovernedTrust<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const original = kernel.compile.bind(kernel);
  kernel.compile = (input) => {
    const result = original(input);
    result.compiled.trust = "governed";
    result.resolved.trust = "governed";
    result.compiled.ungoverned = [];
    result.resolved.ungoverned = [];
    return result;
  };
  return restoreAfter(fn, () => {
    kernel.compile = original;
  });
}

export async function withDisabledExploratoryDowngrade<T>(
  kernel: GraneKernel,
  fn: () => Promise<T>,
): Promise<T> {
  return withForcedGovernedTrust(kernel, fn);
}

export async function withDisabledAmbiguousPaths<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const graph = kernel.model.graph;
  const original = graph.findPath.bind(graph);
  graph.findPath = (from, to) => {
    const path = original(from, to);
    if (!path) return path;
    return { ...path, ambiguous: false, alternatives: undefined };
  };
  return restoreAfter(fn, () => {
    graph.findPath = original;
  });
}

export async function withFirstAmbiguousPath<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  return withDisabledAmbiguousPaths(kernel, fn);
}

export async function withDisabledDateValidation<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const original = kernel.resolve.bind(kernel);
  kernel.resolve = (input) => {
    const clone = structuredClone(input) as SemanticQueryInput;
    if (clone.time?.from && !isValidCivilDate(clone.time.from)) clone.time.from = "2023-02-28";
    if (clone.time?.to && !isValidCivilDate(clone.time.to)) clone.time.to = "2023-02-28";
    return original(clone);
  };
  return restoreAfter(fn, () => {
    kernel.resolve = original;
  });
}

export async function withAlteredTimeBoundaries<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const original = kernel.compile.bind(kernel);
  kernel.compile = (input) => {
    const resolved = kernel.resolve(input);
    if (resolved.time) {
      resolved.time = { ...resolved.time, to: resolved.time.from };
    }
    const compiled = compileQuery(kernel.model, resolved);
    return { resolved, compiled };
  };
  return restoreAfter(fn, () => {
    kernel.compile = original;
  });
}

export async function withStrippedMetricFilters<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const restored: Array<{ metric: { filters: unknown[] }; filters: unknown[] }> = [];
  for (const metric of kernel.model.metrics.values()) {
    restored.push({ metric, filters: [...metric.filters] });
    metric.filters = [];
  }
  return restoreAfter(fn, () => {
    for (const item of restored) {
      item.metric.filters = item.filters as typeof item.metric.filters;
    }
  });
}

export async function withDisabledReadOnly<T>(fn: () => Promise<T>): Promise<T> {
  const previous = executionPolicy.refuseWrites;
  executionPolicy.refuseWrites = false;
  return restoreAfter(fn, () => {
    executionPolicy.refuseWrites = previous;
  });
}

export async function expectGauntletToCatch(
  harness: Harness,
  scenario: Scenario,
  inject: (kernel: GraneKernel, fn: () => Promise<Verdict>) => Promise<Verdict>,
): Promise<{ detected: boolean; verdict: Verdict }> {
  const verdict = await inject(harness.kernel, () => runScenario(scenario, harness));
  const detected = verdict.code === "CRITICAL FAIL" || verdict.code === "SECURITY CRITICAL" || verdict.code === "FAIL";
  return { detected, verdict };
}

export interface MutationCase {
  id: string;
  scenarioId: string;
  inject: (kernel: GraneKernel, fn: () => Promise<Verdict>) => Promise<Verdict>;
}

export const MUTATION_CASES: MutationCase[] = [
  {
    id: "disable-fanout-detection",
    scenarioId: "join/revenue-by-product-category",
    inject: withDisabledFanout,
  },
  {
    id: "disable-cardinality-validation",
    scenarioId: "join/revenue-by-product-category",
    inject: withDisabledCardinalityValidation,
  },
  {
    id: "disable-grain-validation",
    scenarioId: "join/revenue-plus-customers",
    inject: withDisabledGrainValidation,
  },
  {
    id: "disable-blocked-column-enforcement",
    scenarioId: "perm/raw-dim/customers-email",
    inject: withEmptyExclude,
  },
  {
    id: "disable-trust-propagation",
    scenarioId: "explore/mixed-discount",
    inject: withForcedGovernedTrust,
  },
  {
    id: "disable-exploratory-trust-downgrade",
    scenarioId: "explore/mixed-discount",
    inject: withDisabledExploratoryDowngrade,
  },
  {
    id: "disable-ambiguous-path-detection",
    scenarioId: "ambig/countries-name-raw",
    inject: withDisabledAmbiguousPaths,
  },
  {
    id: "select-arbitrary-relationship-path",
    scenarioId: "ambig/countries-name-raw",
    inject: withFirstAmbiguousPath,
  },
  {
    id: "disable-date-validation",
    scenarioId: "time/kernel/non-leap-29-feb",
    inject: withDisabledDateValidation,
  },
  {
    id: "alter-time-boundaries",
    scenarioId: "time/last-month",
    inject: withAlteredTimeBoundaries,
  },
  {
    id: "alter-semi-additive-behaviour",
    scenarioId: "semi/unbounded-not-naive-sum",
    inject: withNaiveSemiAdditive,
  },
  {
    id: "remove-metric-filters",
    scenarioId: "join/revenue-total",
    inject: withStrippedMetricFilters,
  },
  {
    id: "disable-read-only-enforcement",
    scenarioId: "readonly/create-table-pwned",
    inject: (kernel, fn) => {
      void kernel;
      return withDisabledReadOnly(fn);
    },
  },
];
