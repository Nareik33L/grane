import { describe, expect, it } from "vitest";
import { criticalGateFindings, isCriticalVerdict } from "../gauntlet/scoring.js";
import type { ScenarioResult, VerdictCode } from "../gauntlet/types.js";

function result(code: VerdictCode, id = "sample"): ScenarioResult {
  return {
    scenario: {
      id,
      category: "join",
      question: "",
      interpretation: "",
      expectedSqlBehaviour: "",
      expectation: { kind: "execute", trust: "governed" },
    },
    verdict: { code, detail: code },
    durationMs: 0,
    sql: null,
    trust: null,
    refusalStatus: null,
  };
}

describe("gauntlet CRITICAL CI gate", () => {
  it("treats only SECURITY CRITICAL and CRITICAL FAIL as gate verdicts", () => {
    expect(isCriticalVerdict("SECURITY CRITICAL")).toBe(true);
    expect(isCriticalVerdict("CRITICAL FAIL")).toBe(true);
    expect(isCriticalVerdict("FAIL")).toBe(false);
    expect(isCriticalVerdict("PASS")).toBe(false);
    expect(isCriticalVerdict("PASS — SAFE REFUSAL")).toBe(false);
  });

  it("does not gate on ordinary FAIL", () => {
    const findings = criticalGateFindings([
      result("FAIL", "crash"),
      result("PASS", "ok"),
      result("PASS — UNSUPPORTED", "unsup"),
    ]);
    expect(findings).toEqual([]);
  });

  it("collects CRITICAL FAIL and SECURITY CRITICAL", () => {
    const findings = criticalGateFindings([
      result("FAIL", "noise"),
      result("CRITICAL FAIL", "wrong-number"),
      result("SECURITY CRITICAL", "blocked-col"),
      result("PASS", "ok"),
    ]);
    expect(findings.map((r) => r.scenario.id)).toEqual(["wrong-number", "blocked-col"]);
  });
});
