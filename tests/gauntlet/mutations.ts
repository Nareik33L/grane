/**
 * Mutation testing of the Gauntlet itself.
 *
 * If we deliberately break Grane and the suite stays green, the suite is too
 * weak. These helpers inject known defect classes and return the verdicts
 * the Gauntlet would record.
 */

import type { GraneKernel } from "../../src/kernel.js";
import { runScenario, type Harness } from "./harness.js";
import type { Scenario, Verdict } from "./types.js";

export async function withDisabledFanout<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
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
  try {
    return await fn();
  } finally {
    graph.findPath = original;
  }
}

export async function withEmptyExclude<T>(kernel: GraneKernel, fn: () => Promise<T>): Promise<T> {
  const previous = kernel.config.exploration.exclude;
  kernel.config.exploration.exclude = [];
  try {
    return await fn();
  } finally {
    kernel.config.exploration.exclude = previous;
  }
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
