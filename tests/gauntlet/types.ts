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
  | "FAIL"
  | "CRITICAL FAIL"
  | "SECURITY CRITICAL";

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
  fail: number;
  critical: number;
  security: number;
}

export interface Scorecard {
  scenarios: number;
  correctExecution: number;
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
  byCategory: CategoryTally[];
  findings: ScenarioResult[];
  report: string;
}

export const GAUNTLET_NOW = new Date("2024-03-15T12:00:00.000Z");
export const GAUNTLET_TZ = "Europe/London";
