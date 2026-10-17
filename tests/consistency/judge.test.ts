/**
 * Judge contracts for #117 QA: governed mismatch, unsafe_query-only refusal,
 * empty/trivial/row-count guards. No warehouse.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judge } from "./harness.js";
import { REFUSE_STATUS, type ConsistencyQuestion } from "./questions.js";
import type { PathAnswer } from "./harness.js";

const matchQ = {
  id: "orders_completed",
  question: "n",
  category: "simple",
  expect: "match",
  allTime: true,
  grane: { metrics: ["orders"] },
  rawSql: "SELECT 1",
} as ConsistencyQuestion;

const refuseQ = {
  id: "revenue_by_product_category",
  question: "n",
  category: "grain trap",
  expect: "grane_refuses",
  allTime: true,
  grane: { metrics: ["revenue"] },
  rawSql: "SELECT 1",
} as ConsistencyQuestion;

const mismatchQ = {
  id: "customers_ordered_last_month",
  question: "n",
  category: "definition",
  expect: "mismatch",
  allTime: false,
  grane: { metrics: ["customers"] },
  rawSql: "SELECT 1",
  governedSql: "SELECT 0",
} as ConsistencyQuestion;

const answered = (rows: (string | number | boolean | null)[][]): PathAnswer => ({
  kind: "answered",
  rows,
  duration_ms: 0,
});

const refused = (status: string): PathAnswer => ({
  kind: "refused",
  status,
  message: status,
  duration_ms: 0,
});

describe("independent SQL source", () => {
  it("does not import Grane time.ts", () => {
    const src = readFileSync(fileURLToPath(new URL("./questions.ts", import.meta.url)), "utf8");
    expect(src).not.toMatch(/from ["'].*query\/time/);
    expect(src).not.toMatch(/resolveRelativeRange|namedQuarterRange|exclusiveEnd/);
  });
});

describe("consistency judge", () => {
  it("match rejects empty and all-zero tables", () => {
    expect(judge(matchQ, answered([]), answered([[1789]])).ok).toBe(false);
    expect(judge(matchQ, answered([[0]]), answered([[0]])).ok).toBe(false);
    expect(judge(matchQ, answered([[1789]]), answered([[1789]])).ok).toBe(true);
  });

  it("match rejects row-count disagreement", () => {
    const left = answered([["UK", 1], ["US", 2]]);
    const right = answered([["UK", 1]]);
    expect(judge(matchQ, left, right).ok).toBe(false);
    expect(judge(matchQ, left, right).detail).toMatch(/row count/);
  });

  it("refusal requires unsafe_query, not invalid_query", () => {
    const raw = answered([["home", 100]]);
    expect(judge(refuseQ, refused("invalid_query"), raw).ok).toBe(false);
    expect(judge(refuseQ, refused(REFUSE_STATUS), raw).ok).toBe(true);
    expect(judge(refuseQ, answered([["home", 100]]), raw).ok).toBe(false);
  });

  it("mismatch requires Grane to equal governed SQL, not any difference", () => {
    const governed = answered([[0]]);
    const raw = answered([[181]]);
    const graneWrong = answered([[1]]);
    const graneRight = answered([[0]]);
    expect(judge(mismatchQ, graneWrong, raw, governed).ok).toBe(false);
    expect(judge(mismatchQ, graneWrong, raw, governed).detail).toMatch(/governed SQL/);
    expect(judge(mismatchQ, graneRight, raw, governed).ok).toBe(true);
    expect(judge(mismatchQ, answered([[181]]), raw, governed).ok).toBe(false);
  });

  it("mismatch fails when cells matched, so not a mismatch", () => {
    const same = answered([[181]]);
    const result = judge(mismatchQ, same, same, same);
    expect(result.ok).toBe(false);
    expect(result.tables_match).toBe(true);
    expect(result.detail).toMatch(/cells matched/);
  });
});
