import { trapScenarios } from "./scenarios/traps.js";
import { allGenerated } from "./generators.js";
import type { Scenario } from "./types.js";

export function allScenarios(): Scenario[] {
  const list = [...trapScenarios(), ...allGenerated()];
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const scenario of list) {
    if (seen.has(scenario.id)) dupes.push(scenario.id);
    seen.add(scenario.id);
  }
  if (dupes.length > 0) {
    throw new Error(`Duplicate Gauntlet scenario ids: ${[...new Set(dupes)].join(", ")}`);
  }
  return list;
}
