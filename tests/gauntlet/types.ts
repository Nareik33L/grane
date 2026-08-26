/**
 * Grane Gauntlet types.
 *
 * The suite is an internal robustness gauntlet, not the public A/B/C
 * usefulness benchmark. Every scenario has a known interpretation and a
 * known acceptable outcome before Grane runs. Grane is wrong until the
 * scenario fails to prove it wrong.
 */

import type { SemanticQueryInput, TrustLevel } from "../../src/query/model.js";
import type { RefusalStatus } from "../../src/errors.js";
import type { GraneConfig } from "../../src/config/schema.js";
import type { GraneKernel } from "../../src/kernel.js";
import type { AgentGrant } from "../../src/auth/agents.js";

export const CATEGORIES = [
  "join",
  "grain",
  "distinct",
  "metrics",
  "time",
  "permissions",
  "hostile",
  "exploration",
  "ambiguity",
  "dirty",
  "schema_mutation",
  "semantic_mutation",
  "provenance",
  "trust",
  "determinism",
  "equivalent",
  "readonly",
  "resources",
  "mcp",
  "concurrency",
  "cache",
  "leakage",
  "properties",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type VerdictCode =
  | "PASS"
  | "PASS — SAFE REFUSAL"
  | "PASS — EXPLORATORY"
  | "PASS — CLARIFY"
  | "PASS — POLICY"
  | "PASS — UNSUPPORTED"
  | "PASS — INVALID"
  | "FAIL"
  | "CRITICAL FAIL"
  | "SECURITY CRITICAL";

/**
 * Expected kernel behaviour. A refusal must not pass a scenario whose
 * expected disposition is EXECUTE or EXPLORE.
 */
export type Disposition =
  | "EXECUTE"
  | "EXPLORE"
  | "CLARIFY"
  | "REFUSE_SAFETY"
  | "REFUSE_POLICY"
  | "UNSUPPORTED"
  | "INVALID";

export type GoldSpec =
  | { kind: "scalar"; value: number; tolerance?: number; column?: string }
  | { kind: "sql"; sql: string }
  | { kind: "rows"; rows: Array<Record<string, unknown>> }
  | { kind: "empty" };

export type Expectation =
  | {
      kind: "execute";
      gold?: GoldSpec;
      trust: TrustLevel;
      /** Optional independent check that generated SQL must / must not contain. */
      sqlMustInclude?: string[];
      sqlMustNotInclude?: string[];
    }
  | {
      kind: "refuse";
      /** Any of these refusal statuses is acceptable. Empty = any structured refusal. */
      statuses?: RefusalStatus[];
      reason: string;
    }
  | {
      kind: "explore";
      gold?: GoldSpec;
      trust: "mixed" | "exploratory";
    };

export type ScenarioMode = "compile" | "execute" | "catalog" | "validate" | "custom";

export interface Scenario {
  id: string;
  category: Category;
  question: string;
  interpretation: string;
  expectedSqlBehaviour: string;
  permittedTables?: string[];
  prohibitedTables?: string[];
  prohibitedColumns?: string[];
  /** Query Model v1 request. Hostile tests may pass structurally invalid objects. */
  query?: SemanticQueryInput | Record<string, unknown>;
  expectation: Expectation;
  /**
   * Required behavioural class. Inferred from `expectation` when omitted.
   * A refusal cannot pass EXECUTE / EXPLORE.
   */
  disposition?: Disposition | Disposition[];
  mode?: ScenarioMode;
  /** If Grane answers when it should refuse, use this severity. */
  guessSeverity?: "critical" | "security" | "standard";
  /** Override exploration / metrics / agents for this scenario. */
  config?: (base: GraneConfig) => GraneConfig;
  agent?: AgentGrant | null;
  /** Pin the kernel clock. */
  now?: Date;
  /** Run after compile/query to inspect provenance, catalog, validation, etc. */
  custom?: (ctx: CustomContext) => Promise<Verdict> | Verdict;
}

export interface CustomContext {
  kernel: GraneKernel;
  compileSql: string | null;
  compileParams: unknown[] | null;
  trust: TrustLevel | null;
  rows: Record<string, unknown>[] | null;
  error: unknown | null;
  catalogText?: string;
}

export interface Verdict {
  code: VerdictCode;
  detail: string;
}

export interface ScenarioResult {
  scenario: Scenario;
  verdict: Verdict;
  durationMs: number;
  sql: string | null;
  trust: TrustLevel | null;
  refusalStatus: string | null;
}

export interface CategoryTally {
  category: Category;
  total: number;
  pass: number;
  passRefusal: number;
  passExploratory: number;
  passClarify: number;
  passPolicy: number;
  passUnsupported: number;
  passInvalid: number;
  fail: number;
  critical: number;
  security: number;
}

export interface Scorecard {
  scenarios: number;
  correctExecution: number;
  correctExploration: number;
  correctClarification: number;
  correctRefuseSafety: number;
  correctRefusePolicy: number;
  unsupported: number;
  invalidInput: number;
  /** @deprecated split into clarification / safety / policy / unsupported / invalid */
  correctRefusal: number;
  safeExploration: number;
  standardFailures: number;
  criticalFailures: number;
  securityCriticalFailures: number;
  wrongNumericResults: number;
  silentFanOuts: number;
  unsafeJoins: number;
  permissionViolations: number;
  trustMisclassifications: number;
  writeAttemptsExecuted: number;
  /** Correct disposition + behaviour / all scenarios. Target 100%. */
  behaviouralCorrectnessPct: number;
  /**
   * EXECUTE+EXPLORE / (EXECUTE+EXPLORE+true UNSUPPORTED). Excludes
   * deliberate refusal, policy, clarify, and invalid-input tests.
   */
  answerableTotal: number;
  answerableCovered: number;
  answerableCapabilityPct: number;
  safetyExpected: number;
  safetyCorrect: number;
  safetyAccuracyPct: number;
  policyExpected: number;
  policyCorrect: number;
  policyAccuracyPct: number;
  clarifyExpected: number;
  clarifyCorrect: number;
  clarifyAccuracyPct: number;
  byCategory: CategoryTally[];
  findings: ScenarioResult[];
  report: string;
}

export const GAUNTLET_NOW = new Date("2024-03-15T12:00:00.000Z");
export const GAUNTLET_TZ = "Europe/London";

export function expectedDispositions(scenario: Pick<Scenario, "disposition" | "expectation" | "category" | "guessSeverity" | "agent">): Disposition[] {
  if (scenario.disposition) {
    return Array.isArray(scenario.disposition) ? scenario.disposition : [scenario.disposition];
  }
  return [inferDisposition(scenario)];
}

export function inferDisposition(
  scenario: Pick<Scenario, "expectation" | "category" | "guessSeverity" | "agent">,
): Disposition {
  if (scenario.expectation.kind === "execute") return "EXECUTE";
  if (scenario.expectation.kind === "explore") return "EXPLORE";
  const statuses = scenario.expectation.kind === "refuse" ? (scenario.expectation.statuses ?? []) : [];
  if (
    scenario.guessSeverity === "security" ||
    scenario.category === "permissions" ||
    scenario.category === "cache" ||
    scenario.category === "readonly" ||
    scenario.category === "leakage" ||
    statuses.includes("column_not_permitted") ||
    statuses.includes("exploration_disabled")
  ) {
    return "REFUSE_POLICY";
  }
  if (statuses.includes("ambiguous_query") || scenario.category === "ambiguity") return "CLARIFY";
  if (
    statuses.includes("unsafe_query") ||
    scenario.category === "grain" ||
    scenario.category === "distinct" ||
    scenario.category === "join"
  ) {
    return "REFUSE_SAFETY";
  }
  if (statuses.includes("undefined_metric") || statuses.includes("undefined_dimension")) return "CLARIFY";
  if (scenario.category === "schema_mutation") return "REFUSE_SAFETY";
  if (scenario.category === "mcp" || scenario.category === "hostile" || scenario.category === "time") {
    return "INVALID";
  }
  if (statuses.includes("invalid_query")) return "INVALID";
  return "REFUSE_SAFETY";
}

export function dispositionFromRefusal(
  status: string,
  scenario: Pick<Scenario, "agent">,
  message = "",
): Disposition {
  if (status === "ambiguous_query") return "CLARIFY";
  if (status === "unsafe_query") return "REFUSE_SAFETY";
  if (status === "column_not_permitted" || status === "exploration_disabled") return "REFUSE_POLICY";
  if (status === "undefined_metric" || status === "undefined_dimension") {
    return scenario.agent ? "REFUSE_POLICY" : "CLARIFY";
  }
  if (status === "invalid_query" && /ambiguous/i.test(message)) return "CLARIFY";
  if (status === "invalid_query") return "INVALID";
  return "INVALID";
}

export function isAnswerableScenario(scenario: Parameters<typeof expectedDispositions>[0]): boolean {
  const expected = expectedDispositions(scenario);
  return expected.length > 0 && expected.every((d) => d === "EXECUTE" || d === "EXPLORE" || d === "UNSUPPORTED");
}

export function expectedRole(scenario: Parameters<typeof expectedDispositions>[0]): Disposition {
  const expected = expectedDispositions(scenario);
  if (expected.length === 1) return expected[0]!;
  if (expected.every((d) => d === "EXECUTE" || d === "EXPLORE")) return "EXECUTE";
  return expected[0]!;
}

export function passCodeForDisposition(disposition: Disposition): VerdictCode {
  switch (disposition) {
    case "EXECUTE":
      return "PASS";
    case "EXPLORE":
      return "PASS — EXPLORATORY";
    case "CLARIFY":
      return "PASS — CLARIFY";
    case "REFUSE_SAFETY":
      return "PASS — SAFE REFUSAL";
    case "REFUSE_POLICY":
      return "PASS — POLICY";
    case "UNSUPPORTED":
      return "PASS — UNSUPPORTED";
    case "INVALID":
      return "PASS — INVALID";
  }
}
