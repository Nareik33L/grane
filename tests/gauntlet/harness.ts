/**
 * Gauntlet runner: compile / execute a scenario and classify the outcome.
 *
 * Gold numbers come from independent SQL or fixture reductions, never from
 * Grane. A structured refusal is a pass when the scenario says so. A
 * plausible number after an unsafe join is a critical failure.
 */

import { GraneKernel } from "../../src/kernel.js";
import { GraneError } from "../../src/errors.js";
import type { SemanticQueryInput, TrustLevel } from "../../src/query/model.js";
import { semanticQuerySchema } from "../../src/query/model.js";
import { executeCompiled } from "../../src/execute/executor.js";
import type { DatabaseSchema, WarehouseConnector } from "../../src/connectors/types.js";
import type { LimitsConfig } from "../../src/config/schema.js";
import { gauntletConfig } from "./model.js";
import { tablesMatchScalar } from "./gold.js";
import {
  errorLeaksSecrets,
  injectionEscaped,
  isWriteSql,
  sqlContainsBlockedColumn,
} from "./sql-invariants.js";
import type { GauntletWarehouse } from "./warehouse.js";
import {
  GAUNTLET_NOW,
  dispositionFromRefusal,
  expectedDispositions,
  passCodeForDisposition,
  type CustomContext,
  type Disposition,
  type Expectation,
  type GoldSpec,
  type Scenario,
  type Verdict,
  type VerdictCode,
} from "./types.js";

export interface Harness {
  kernel: GraneKernel;
  warehouse: GauntletWarehouse;
  schema: DatabaseSchema;
}

export function createKernel(warehouse: GauntletWarehouse, schema: DatabaseSchema): GraneKernel {
  const config = gauntletConfig();
  const kernel = new GraneKernel(config, {
    schema,
    now: GAUNTLET_NOW,
    connector: warehouse,
  });
  kernel.setSchema(schema);
  return kernel;
}

function kernelFor(scenario: Scenario, harness: Harness): GraneKernel {
  if (scenario.config) {
    const config = scenario.config(gauntletConfig());
    const kernel = new GraneKernel(config, {
      schema: harness.schema,
      now: scenario.now ?? GAUNTLET_NOW,
      connector: harness.warehouse,
    });
    kernel.setSchema(harness.schema);
    return scenario.agent ? kernel.bindAgent(scenario.agent) : kernel;
  }
  if (scenario.agent) return harness.kernel.bindAgent(scenario.agent);
  if (scenario.now) {
    const kernel = new GraneKernel(harness.kernel.config, {
      schema: harness.schema,
      now: scenario.now,
      connector: harness.warehouse,
    });
    kernel.setSchema(harness.schema);
    return kernel;
  }
  return harness.kernel;
}

function firstNumeric(rows: Record<string, unknown>[], column?: string): unknown {
  const row = rows[0];
  if (!row) return undefined;
  if (column && column in row) return row[column];
  for (const value of Object.values(row)) {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    const n = Number(value);
    if (Number.isFinite(n) && value !== null && String(value).trim() !== "") return n;
  }
  return Object.values(row)[0];
}

function normalizeCell(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  const n = Number(value);
  if (Number.isFinite(n) && String(value).trim() !== "") return n;
  return String(value);
}

async function resolveGold(
  warehouse: GauntletWarehouse,
  spec: GoldSpec,
): Promise<{ scalar?: number; rows?: Record<string, unknown>[] }> {
  if (spec.kind === "scalar") return { scalar: spec.value };
  if (spec.kind === "empty") return { rows: [] };
  if (spec.kind === "rows") return { rows: spec.rows };
  const rows = await warehouse.runGold(spec.sql);
  return { rows, scalar: Number(firstNumeric(rows)) };
}

function compareGold(
  rows: Record<string, unknown>[],
  gold: { scalar?: number; rows?: Record<string, unknown>[] },
  spec: GoldSpec,
): string | null {
  if (spec.kind === "empty") {
    return rows.length === 0 ? null : `expected no rows, got ${rows.length}`;
  }
  if (gold.scalar != null && (spec.kind === "scalar" || spec.kind === "sql")) {
    const actual = firstNumeric(rows, spec.kind === "scalar" ? spec.column : undefined);
    const tolerance = spec.kind === "scalar" ? (spec.tolerance ?? 0.005) : 0.005;
    if (!tablesMatchScalar(normalizeCell(actual), gold.scalar, tolerance)) {
      return `numeric ${String(actual)} !== gold ${gold.scalar}`;
    }
    return null;
  }
  if (gold.rows && spec.kind === "rows") {
    if (rows.length !== gold.rows.length) return `row count ${rows.length} !== ${gold.rows.length}`;
  }
  return null;
}

function alignCustomVerdict(scenario: Scenario, verdict: Verdict): Verdict {
  if (!verdict.code.startsWith("PASS")) return verdict;
  const expected = expectedDispositions(scenario);
  const requiresExecution = expected.some((d) => d === "EXECUTE" || d === "EXPLORE");
  const refusalPass =
    verdict.code === "PASS — SAFE REFUSAL" ||
    verdict.code === "PASS — CLARIFY" ||
    verdict.code === "PASS — POLICY" ||
    verdict.code === "PASS — UNSUPPORTED";
  if (requiresExecution && expected.length === 1 && refusalPass) {
    return {
      code: "FAIL",
      detail: `incorrect refusal; expected ${expected.join("|")}: ${verdict.detail}`,
    };
  }
  if (refusalPass && !requiresExecution) {
    const preferred =
      expected.find((d) => d !== "EXECUTE" && d !== "EXPLORE") ?? "REFUSE_SAFETY";
    return { code: passCodeForDisposition(preferred), detail: verdict.detail };
  }
  if (verdict.code === "PASS" && expected.length === 1 && expected[0] === "EXPLORE") {
    return { code: "PASS — EXPLORATORY", detail: verdict.detail };
  }
  return verdict;
}
  if (scenario.guessSeverity === "security") return "SECURITY CRITICAL";
  if (scenario.guessSeverity === "standard") return "FAIL";
  return "CRITICAL FAIL";
}

function sqlSafety(scenario: Scenario, sql: string | null, params: unknown[]): Verdict | null {
  if (!sql) return null;
  if (isWriteSql(sql)) {
    return { code: "SECURITY CRITICAL", detail: "generated SQL is a write" };
  }
  const blocked = sqlContainsBlockedColumn(sql, scenario.prohibitedColumns);
  if (blocked.length > 0) {
    return { code: "SECURITY CRITICAL", detail: `SQL references blocked ${blocked.join(", ")}` };
  }
  if (scenario.prohibitedTables) {
    const blob = sql.toLowerCase();
    for (const table of scenario.prohibitedTables) {
      if (blob.includes(`"${table.toLowerCase()}"`) || blob.includes(`.${table.toLowerCase()}`)) {
        return { code: "CRITICAL FAIL", detail: `SQL joined prohibited table ${table}` };
      }
    }
  }
  const hostile =
    typeof (scenario.query as { filters?: { value?: unknown }[] })?.filters?.[0]?.value === "string"
      ? String((scenario.query as { filters: { value: string }[] }).filters[0]!.value)
      : "";
  if (hostile && !injectionEscaped(sql, hostile)) {
    return { code: "SECURITY CRITICAL", detail: "hostile filter escaped into SQL text" };
  }
  void params;
  return null;
}

function judgeExecute(
  scenario: Scenario,
  expectation: Extract<Expectation, { kind: "execute" | "explore" }>,
  rows: Record<string, unknown>[],
  trust: TrustLevel | null,
  goldError: string | null,
): Verdict {
  if (expectation.kind === "execute" && trust && trust !== expectation.trust) {
    return {
      code: trust === "governed" && expectation.trust !== "governed" ? "CRITICAL FAIL" : "CRITICAL FAIL",
      detail: `trust ${trust} !== expected ${expectation.trust}`,
    };
  }
  if (expectation.kind === "explore") {
    if (trust === "governed") {
      return { code: "CRITICAL FAIL", detail: "exploratory/mixed query labelled governed" };
    }
    if (trust && trust !== expectation.trust) {
      return { code: "CRITICAL FAIL", detail: `trust ${trust} !== expected ${expectation.trust}` };
    }
  }
  if (goldError) {
    return { code: "CRITICAL FAIL", detail: goldError };
  }
  if (expectation.kind === "explore") {
    return { code: "PASS — EXPLORATORY", detail: `trust ${trust}` };
  }
  return { code: "PASS", detail: `trust ${trust}, ${rows.length} row(s)` };
}

export async function runScenario(scenario: Scenario, harness: Harness): Promise<Verdict> {
  const kernel = kernelFor(scenario, harness);
  if (scenario.custom && scenario.mode === "custom") {
    try {
      return alignCustomVerdict(
        scenario,
        await scenario.custom({
          kernel,
          compileSql: null,
          compileParams: null,
          trust: null,
          rows: null,
          error: null,
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const leaks = errorLeaksSecrets(message);
      if (leaks.length) return { code: "SECURITY CRITICAL", detail: `error leaked ${leaks.join(", ")}` };
      return { code: "FAIL", detail: message };
    }
  }

  const rawQuery = scenario.query ?? {};
  const parsed = semanticQuerySchema.safeParse(rawQuery);

  if (scenario.mode === "catalog") {
    try {
      const catalog = await kernel.catalog();
      const ctx: CustomContext = {
        kernel,
        compileSql: null,
        compileParams: null,
        trust: null,
        rows: null,
        error: null,
        catalogText: JSON.stringify(catalog),
      };
      if (scenario.custom) return await scenario.custom(ctx);
      const blob = ctx.catalogText ?? "";
      const blockedHits = sqlContainsBlockedColumn(blob);
      if (blockedHits.length && scenario.expectation.kind === "refuse") {
        return { code: "SECURITY CRITICAL", detail: `catalog revealed ${blockedHits.join(", ")}` };
      }
      return { code: "PASS", detail: "catalog returned" };
    } catch (err) {
      return refuseOrFail(scenario, err);
    }
  }

  if (!parsed.success) {
    const expected = expectedDispositions(scenario);
    if (expected.some((d) => d === "EXECUTE" || d === "EXPLORE")) {
      return { code: "FAIL", detail: `invalid query: ${parsed.error.issues[0]?.message ?? "parse"}` };
    }
    if (expected.includes("UNSUPPORTED") || scenario.expectation.kind === "refuse") {
      const disposition: Disposition = expected.includes("CLARIFY")
        ? "CLARIFY"
        : expected.includes("REFUSE_POLICY")
          ? "REFUSE_POLICY"
          : expected.includes("REFUSE_SAFETY")
            ? "REFUSE_SAFETY"
            : "UNSUPPORTED";
      return {
        code: passCodeForDisposition(disposition),
        detail: `Query Model v1 rejected the payload: ${parsed.error.issues[0]?.message ?? "parse"}`,
      };
    }
    return { code: "FAIL", detail: `invalid query: ${parsed.error.issues[0]?.message ?? "parse"}` };
  }

  const input = parsed.data as SemanticQueryInput;
  let sql: string | null = null;
  let params: unknown[] = [];
  let trust: TrustLevel | null = null;
  let rows: Record<string, unknown>[] | null = null;

  try {
    const compiled = kernel.compile(input);
    sql = compiled.compiled.sql;
    params = compiled.compiled.params;
    trust = compiled.compiled.trust;
    const safety = sqlSafety(scenario, sql, params);
    if (safety) return safety;
    if (scenario.expectation.kind === "execute") {
      for (const frag of scenario.expectation.sqlMustInclude ?? []) {
        if (!sql.toLowerCase().includes(frag.toLowerCase())) {
          return { code: "FAIL", detail: `SQL missing ${frag}` };
        }
      }
      for (const frag of scenario.expectation.sqlMustNotInclude ?? []) {
        if (sql.toLowerCase().includes(frag.toLowerCase())) {
          return { code: "CRITICAL FAIL", detail: `SQL contains forbidden ${frag}` };
        }
      }
    }

    if (scenario.mode === "compile") {
      if (scenario.custom) {
        return alignCustomVerdict(
          scenario,
          await scenario.custom({
            kernel,
            compileSql: sql,
            compileParams: params,
            trust,
            rows: null,
            error: null,
          }),
        );
      }
      if (scenario.expectation.kind === "refuse") {
        return { code: guessCode(scenario), detail: "compiled when a refusal was required" };
      }
      const expected = expectedDispositions(scenario);
      if (
        expected.every(
          (d) => d === "CLARIFY" || d === "REFUSE_SAFETY" || d === "REFUSE_POLICY" || d === "UNSUPPORTED",
        )
      ) {
        return { code: guessCode(scenario), detail: `compiled when ${expected.join("|")} was required` };
      }
      if (scenario.expectation.kind === "explore") {
        if (trust === "governed") {
          return { code: "CRITICAL FAIL", detail: "exploratory compile labelled governed" };
        }
        return { code: "PASS — EXPLORATORY", detail: `compiled trust ${trust}` };
      }
      if (trust && scenario.expectation.kind === "execute" && trust !== scenario.expectation.trust) {
        return { code: "CRITICAL FAIL", detail: `trust ${trust} !== ${scenario.expectation.trust}` };
      }
      return { code: "PASS", detail: "compiled" };
    }

    const result = await kernel.query(input);
    rows = result.rows;
    trust = result.trust;
    sql = result.provenance.generated_sql;
    const after = sqlSafety(scenario, sql, result.provenance.params);
    if (after) return after;

    if (scenario.expectation.kind === "refuse") {
      return {
        code: guessCode(scenario),
        detail: `answered (${rows.length} rows, trust ${trust}) when refusal required: ${scenario.expectation.reason}`,
      };
    }

    let goldError: string | null = null;
    const goldSpec =
      scenario.expectation.kind === "execute" || scenario.expectation.kind === "explore"
        ? scenario.expectation.gold
        : undefined;
    if (goldSpec) {
      const gold = await resolveGold(harness.warehouse, goldSpec);
      goldError = compareGold(rows, gold, goldSpec);
    }
    if (scenario.custom) {
      return alignCustomVerdict(
        scenario,
        await scenario.custom({
          kernel,
          compileSql: sql,
          compileParams: params,
          trust,
          rows,
          error: null,
        }),
      );
    }
    return judgeExecute(
      scenario,
      scenario.expectation as Extract<Expectation, { kind: "execute" | "explore" }>,
      rows,
      trust,
      goldError,
    );
  } catch (err) {
    if (scenario.custom) {
      try {
        return alignCustomVerdict(
          scenario,
          await scenario.custom({
            kernel,
            compileSql: sql,
            compileParams: params,
            trust,
            rows,
            error: err,
          }),
        );
      } catch (inner) {
        return refuseOrFail(scenario, inner);
      }
    }
    return refuseOrFail(scenario, err);
  }
}

function refuseOrFail(scenario: Scenario, err: unknown): Verdict {
  const message = err instanceof Error ? err.message : String(err);
  const leaks = errorLeaksSecrets(message);
  if (leaks.length) {
    return { code: "SECURITY CRITICAL", detail: `error leaked ${leaks.join(", ")}: ${message}` };
  }
  const expected = expectedDispositions(scenario);
  const wantsExecution = expected.some((d) => d === "EXECUTE" || d === "EXPLORE") && expected.length === 1;
  if (err instanceof GraneError) {
    const actual = dispositionFromRefusal(err.refusal.status, scenario, err.refusal.message);
    if (wantsExecution) {
      return {
        code: "FAIL",
        detail: `incorrect refusal ${err.refusal.status}: ${err.refusal.message}`,
      };
    }
    if (scenario.expectation?.kind === "refuse") {
      const allowed = scenario.expectation.statuses;
      if (allowed && allowed.length > 0 && !allowed.includes(err.refusal.status)) {
        return {
          code: "FAIL",
          detail: `refused as ${err.refusal.status}, expected ${allowed.join("|")}`,
        };
      }
    }
    if (!expected.includes(actual) && scenario.expectation?.kind === "refuse") {
      // Status was allowed (or unspecified); retag to an expected refusal class.
      const preferred = expected.find((d) => d !== "EXECUTE" && d !== "EXPLORE") ?? actual;
      return {
        code: passCodeForDisposition(preferred),
        detail: `${err.refusal.status}: ${err.refusal.message}`,
      };
    }
    if (expected.includes(actual)) {
      return {
        code: passCodeForDisposition(actual),
        detail: `${err.refusal.status}: ${err.refusal.message}`,
      };
    }
    if (scenario.expectation?.kind === "refuse") {
      return {
        code: passCodeForDisposition(expected.find((d) => d !== "EXECUTE" && d !== "EXPLORE") ?? actual),
        detail: `${err.refusal.status}: ${err.refusal.message}`,
      };
    }
    return { code: "FAIL", detail: `incorrect refusal ${err.refusal.status}: ${err.refusal.message}` };
  }
  if (wantsExecution) {
    return { code: "FAIL", detail: message };
  }
  if (scenario.expectation?.kind === "refuse") {
    return { code: "FAIL", detail: `non-structured error instead of refusal: ${message}` };
  }
  return { code: "FAIL", detail: message };
}

/** Injected-SQL execution used by read-only and MCP-abuse cases. */
export async function tryExecuteRawSql(
  connector: WarehouseConnector,
  sql: string,
  limits: LimitsConfig,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; message: string }> {
  try {
    const result = await executeCompiled(
      connector,
      {
        sql,
        params: [],
        plan: { baseTable: "orders", joins: [], preAggregations: [], columns: [] },
        metricVersions: {},
        metricSources: {},
        trust: "exploratory",
        governed: [],
        ungoverned: [],
        warning: null,
      },
      limits,
    );
    return { ok: true, rows: result.rows };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
