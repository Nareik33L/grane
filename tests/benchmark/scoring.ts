import type { BenchCase } from "./cases.js";
import { tablesMatch, formatTable, type Outcome, type Table } from "./harness.js";
import type { TrustLevel } from "../../src/query/model.js";

/** Order statuses in the example shop. Only `completed` is revenue. */
const ORDER_STATUSES = ["completed", "cancelled", "pending"] as const;

/** The four graded dimensions. Each is scored independently, with its own denominator. */
export const DIMENSIONS = ["numeric", "definition", "grain", "refusal"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export const PATHS = ["A", "B", "C"] as const;
export type PathId = (typeof PATHS)[number];

export const PATH_LABELS: Record<PathId, string> = {
  A: "A direct warehouse SQL",
  B: "B SKILL.md-guided SQL",
  C: "C Grane Query Model v1",
};

export interface Check {
  dimension: Dimension;
  applicable: boolean;
  passed: boolean;
  detail: string;
}

export interface CaseScore {
  caseId: string;
  path: PathId;
  /** answered | refused | error */
  outcome: Outcome["kind"];
  checks: Check[];
  trust: TrustLevel | null;
  answer: string;
}

function na(dimension: Dimension, detail: string): Check {
  return { dimension, applicable: false, passed: false, detail };
}

function check(dimension: Dimension, passed: boolean, detail: string): Check {
  return { dimension, applicable: true, passed, detail };
}

export function scoreCase(
  kase: BenchCase,
  path: PathId,
  outcome: Outcome,
  gold: Table | null,
): CaseScore {
  const checks: Check[] = [];

  // --- refusal correctness (always graded) ---
  const didRefuse = outcome.kind === "refused";
  checks.push(
    check(
      "refusal",
      didRefuse === kase.shouldRefuse,
      kase.shouldRefuse
        ? didRefuse
          ? "refused, as required"
          : outcome.kind === "answered"
            ? "returned a number for a question with no correct answer"
            : "failed instead of refusing"
        : didRefuse
          ? "refused an answerable question"
          : "answered, as required",
    ),
  );

  // --- numeric correctness ---
  if (gold === null) {
    checks.push(na("numeric", "no correct numeric answer exists"));
  } else if (outcome.kind !== "answered") {
    checks.push(check("numeric", false, `no answer (${outcome.kind})`));
  } else {
    const matched = tablesMatch(outcome.table, gold);
    checks.push(
      check(
        "numeric",
        matched,
        matched ? "matches gold" : `got ${formatTable(outcome.table)} vs gold ${formatTable(gold)}`,
      ),
    );
  }

  // --- definition adherence ---
  if (!kase.requires || outcome.kind !== "answered") {
    checks.push(na("definition", "no definition requirements graded"));
  } else {
    const { analysis } = outcome;
    const problems: string[] = [];
    for (const value of kase.requires.statusValues ?? []) {
      if (!analysis.statusLiterals.has(value)) problems.push(`missing status = '${value}'`);
    }
    const allowed = new Set(kase.requires.statusValues ?? []);
    for (const value of ORDER_STATUSES) {
      if (!allowed.has(value) && analysis.statusLiterals.has(value)) {
        problems.push(`counts status '${value}'`);
      }
    }
    const required = kase.requires.timeColumn;
    if (required) {
      const measured = analysis.boundsOn.has(required) || analysis.truncatesOn.has(required);
      if (!measured) problems.push(`period not measured on ${required}`);
      for (const other of analysis.boundsOn) {
        if (other !== required) problems.push(`period measured on ${other}`);
      }
    }
    checks.push(
      check(
        "definition",
        problems.length === 0,
        problems.length === 0 ? "follows the definition" : problems.join("; "),
      ),
    );
  }

  // --- join / grain correctness ---
  if (outcome.kind !== "answered") {
    checks.push(na("grain", "no SQL to inspect"));
  } else {
    const fanOut = outcome.analysis.fanOutJoins;
    checks.push(
      check(
        "grain",
        fanOut.length === 0,
        fanOut.length === 0
          ? "no fan-out join at the query grain"
          : `joins ${fanOut.join(", ")} at the ${outcome.analysis.baseTable} grain`,
      ),
    );
  }

  return {
    caseId: kase.id,
    path,
    outcome: outcome.kind,
    checks,
    trust: outcome.kind === "answered" ? (outcome.trust ?? null) : null,
    answer:
      outcome.kind === "answered"
        ? formatTable(outcome.table, 2)
        : outcome.kind === "refused"
          ? `refused (${outcome.status})`
          : `error: ${outcome.message.slice(0, 80)}`,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Tally {
  passed: number;
  applicable: number;
}

export interface PathSummary {
  path: PathId;
  byDimension: Record<Dimension, Tally>;
  overall: Tally;
  answered: number;
  refused: number;
  errored: number;
  /** Cases where the path returned a number for a question that has no correct answer. */
  wrongNumberOnRefusalCase: string[];
}

export function pct(tally: Tally): number {
  return tally.applicable === 0 ? 0 : (100 * tally.passed) / tally.applicable;
}

export function summarize(cases: BenchCase[], scores: CaseScore[]): Record<PathId, PathSummary> {
  const byId = new Map(cases.map((c) => [c.id, c]));
  const summaries = {} as Record<PathId, PathSummary>;
  for (const path of PATHS) {
    const byDimension = Object.fromEntries(
      DIMENSIONS.map((d) => [d, { passed: 0, applicable: 0 }]),
    ) as Record<Dimension, Tally>;
    const summary: PathSummary = {
      path,
      byDimension,
      overall: { passed: 0, applicable: 0 },
      answered: 0,
      refused: 0,
      errored: 0,
      wrongNumberOnRefusalCase: [],
    };
    for (const score of scores.filter((s) => s.path === path)) {
      if (score.outcome === "answered") summary.answered += 1;
      if (score.outcome === "refused") summary.refused += 1;
      if (score.outcome === "error") summary.errored += 1;
      if (byId.get(score.caseId)?.shouldRefuse && score.outcome === "answered") {
        summary.wrongNumberOnRefusalCase.push(score.caseId);
      }
      for (const c of score.checks) {
        if (!c.applicable) continue;
        byDimension[c.dimension].applicable += 1;
        summary.overall.applicable += 1;
        if (c.passed) {
          byDimension[c.dimension].passed += 1;
          summary.overall.passed += 1;
        }
      }
    }
    summaries[path] = summary;
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function padTo(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function padStart(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function row(cells: string[], widths: number[]): string {
  return cells.map((c, i) => (i === 0 ? padTo(c, widths[i]!) : padStart(c, widths[i]!))).join("  ");
}

const MARK: Record<string, string> = { pass: "ok", fail: "XX", na: " ." };

function markFor(check: Check | undefined): string {
  if (!check || !check.applicable) return MARK.na!;
  return check.passed ? MARK.pass! : MARK.fail!;
}

export function renderPerCaseTable(cases: BenchCase[], scores: CaseScore[]): string {
  const index = new Map(scores.map((s) => [`${s.caseId}:${s.path}`, s]));
  const idWidth = Math.max(4, ...cases.map((c) => c.id.length));
  const header = row(
    ["case", "A num/def/grain/ref", "B num/def/grain/ref", "C num/def/grain/ref", "C trust"],
    [idWidth, 21, 21, 21, 12],
  );
  const lines = [header, "-".repeat(header.length)];
  for (const kase of cases) {
    const cells = PATHS.map((path) => {
      const score = index.get(`${kase.id}:${path}`);
      const marks = DIMENSIONS.map((d) => markFor(score?.checks.find((c) => c.dimension === d)));
      // numeric / definition / grain / refusal
      return `${marks[0]} ${marks[1]} ${marks[2]} ${marks[3]}`;
    });
    const cScore = index.get(`${kase.id}:C`);
    const trust = cScore?.trust ?? (cScore?.outcome === "refused" ? "refused" : "-");
    lines.push(row([kase.id, cells[0]!, cells[1]!, cells[2]!, trust], [idWidth, 21, 21, 21, 12]));
  }
  return lines.join("\n");
}

export function renderScoreTable(summaries: Record<PathId, PathSummary>): string {
  const widths = [26, 10, 12, 9, 10, 10];
  const lines = [
    row(["path", "numeric", "definition", "grain", "refusal", "overall"], widths),
    "-".repeat(widths.reduce((a, b) => a + b + 2, -2)),
  ];
  for (const path of PATHS) {
    const s = summaries[path];
    const cell = (t: Tally) => `${pct(t).toFixed(0)}% ${t.passed}/${t.applicable}`;
    lines.push(
      row(
        [
          PATH_LABELS[path],
          cell(s.byDimension.numeric),
          cell(s.byDimension.definition),
          cell(s.byDimension.grain),
          cell(s.byDimension.refusal),
          cell(s.overall),
        ],
        widths,
      ),
    );
  }
  return lines.join("\n");
}

export function renderFindings(cases: BenchCase[], scores: CaseScore[]): string {
  const index = new Map(scores.map((s) => [`${s.caseId}:${s.path}`, s]));
  const lines: string[] = [];
  for (const kase of cases) {
    const c = index.get(`${kase.id}:C`)!;
    const cNumeric = c.checks.find((x) => x.dimension === "numeric");
    const cOk =
      (cNumeric?.applicable ? cNumeric.passed : true) &&
      c.checks.find((x) => x.dimension === "refusal")!.passed;
    if (!cOk) continue;
    for (const path of ["A", "B"] as const) {
      const other = index.get(`${kase.id}:${path}`)!;
      const numeric = other.checks.find((x) => x.dimension === "numeric");
      const refusal = other.checks.find((x) => x.dimension === "refusal")!;
      const wrongNumber = numeric?.applicable && !numeric.passed;
      if (!wrongNumber && refusal.passed) continue;
      lines.push(
        `  ${kase.id} [${path}] ${wrongNumber ? numeric!.detail : refusal.detail}` +
          `\n      C: ${c.answer}${c.trust ? ` (trust ${c.trust})` : ""}`,
      );
    }
  }
  return lines.length === 0 ? "  (none)" : lines.join("\n");
}
