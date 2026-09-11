import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { GraneKernel } from "../kernel.js";
import { GraneError, type RefusalStatus } from "../errors.js";
import { semanticQuerySchema, type SemanticQueryInput, type TrustLevel } from "../query/model.js";
import { toGrant } from "../auth/agents.js";

const dispositionSchema = z.enum([
  "execute",
  "explore",
  "refuse",
  "EXECUTE",
  "EXPLORE",
  "REFUSE",
  "REFUSE_SAFETY",
  "REFUSE_POLICY",
  "CLARIFY",
  "UNSUPPORTED",
]);

const goldSchema = z.union([
  z.number(),
  z.object({
    kind: z.literal("scalar"),
    value: z.number(),
    tolerance: z.number().optional(),
    column: z.string().optional(),
  }),
  z.object({ kind: z.literal("empty") }),
  z.object({ kind: z.literal("rows"), rows: z.array(z.record(z.string(), z.unknown())) }),
]);

const scenarioSchema = z.object({
  id: z.string().min(1),
  query: semanticQuerySchema,
  disposition: dispositionSchema.optional(),
  expectation: z
    .object({
      kind: dispositionSchema.optional(),
      trust: z.enum(["governed", "mixed", "exploratory"]).optional(),
      status: z.string().optional(),
      statuses: z.array(z.string()).optional(),
      gold: goldSchema.optional(),
      reason: z.string().optional(),
    })
    .optional(),
  now: z.string().optional(),
  agent: z.string().optional(),
});

export type UserScenario = z.infer<typeof scenarioSchema>;

export interface UserTestCase {
  file: string;
  scenario: UserScenario;
}

export interface UserTestResult {
  id: string;
  file: string;
  ok: boolean;
  detail: string;
  disposition: string;
  status: string | null;
  trust: TrustLevel | null;
}

export interface UserTestReport {
  ok: boolean;
  passed: number;
  failed: number;
  results: UserTestResult[];
}

function normalizeDisposition(raw: string | undefined): "execute" | "explore" | "refuse" {
  const value = (raw ?? "execute").toLowerCase();
  if (value === "explore") return "explore";
  if (value.startsWith("refuse") || value === "clarify" || value === "unsupported") return "refuse";
  return "execute";
}

export function expectedDisposition(scenario: UserScenario): "execute" | "explore" | "refuse" {
  return normalizeDisposition(scenario.disposition ?? scenario.expectation?.kind);
}

export function parseUserTestDocument(raw: unknown, file: string): UserScenario[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) {
    return raw.map((item, i) => parseOne(item, `${file}[${i}]`));
  }
  if (typeof raw === "object" && raw !== null && "scenarios" in raw) {
    const list = (raw as { scenarios: unknown }).scenarios;
    if (!Array.isArray(list)) throw new Error(`${file}: "scenarios" must be a list`);
    return list.map((item, i) => parseOne(item, `${file}[${i}]`));
  }
  return [parseOne(raw, file)];
}

function parseOne(raw: unknown, label: string): UserScenario {
  const parsed = scenarioSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.length ? issue.path.join(".") : "scenario";
    throw new Error(`${label}: ${path}: ${issue?.message ?? "invalid scenario"}`);
  }
  return parsed.data;
}

export function discoverUserTestFiles(target: string): string[] {
  const path = resolve(target);
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  const files: string[] = [];
  for (const name of readdirSync(path).sort()) {
    if (!name.endsWith(".yml") && !name.endsWith(".yaml")) continue;
    const full = join(path, name);
    if (statSync(full).isFile()) files.push(full);
  }
  return files;
}

export function defaultUserTestTargets(projectDir: string): string[] {
  const candidates = [join(projectDir, "grane-tests.yml"), join(projectDir, "grane-tests.yaml"), join(projectDir, "grane-tests")];
  return candidates.filter((path) => existsSync(path));
}

export function loadUserTestCases(paths: string[]): UserTestCase[] {
  const cases: UserTestCase[] = [];
  for (const file of paths.flatMap(discoverUserTestFiles)) {
    const doc = parseYaml(readFileSync(file, "utf8"));
    for (const scenario of parseUserTestDocument(doc, file)) {
      cases.push({ file, scenario });
    }
  }
  return cases;
}

export async function runUserTests(kernel: GraneKernel, cases: UserTestCase[]): Promise<UserTestReport> {
  const results: UserTestResult[] = [];
  for (const { file, scenario } of cases) {
    results.push(await runOne(kernel, file, scenario));
  }
  const failed = results.filter((r) => !r.ok).length;
  return { ok: failed === 0, passed: results.length - failed, failed, results };
}

async function runOne(base: GraneKernel, file: string, scenario: UserScenario): Promise<UserTestResult> {
  const want = expectedDisposition(scenario);
  let kernel = base;
  if (scenario.now) {
    const now = new Date(scenario.now);
    if (Number.isNaN(now.getTime())) {
      return fail(scenario, file, want, `invalid now timestamp "${scenario.now}"`);
    }
    kernel = new GraneKernel(base.config, {
      projectDir: base.projectDir,
      schema: undefined,
      providerWarnings: base.providerWarnings,
      now,
      agent: base.agent,
      connector: base.getConnector(),
      http: base.http,
    });
  }
  if (scenario.agent) {
    const agent = kernel.config.auth.agents.find((item) => item.id === scenario.agent);
    if (!agent) {
      return fail(scenario, file, want, `unknown agent "${scenario.agent}"`);
    }
    kernel = kernel.bindAgent(toGrant(agent));
  }

  const query = scenario.query as SemanticQueryInput;
  const expected = scenario.expectation;
  try {
    const result = await kernel.query(query);
    if (want === "refuse") {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: `expected a refusal, got ${result.rows.length} row(s) trust=${result.trust}`,
        disposition: "execute",
        status: null,
        trust: result.trust,
      };
    }
    if (want === "explore" && result.trust === "governed") {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: `expected exploratory/mixed trust, got governed`,
        disposition: "execute",
        status: null,
        trust: result.trust,
      };
    }
    if (want === "execute" && expected?.trust && result.trust !== expected.trust) {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: `trust ${result.trust} !== ${expected.trust}`,
        disposition: "execute",
        status: null,
        trust: result.trust,
      };
    }
    const goldError = checkGold(result.rows, expected?.gold);
    if (goldError) {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: goldError,
        disposition: want,
        status: null,
        trust: result.trust,
      };
    }
    return {
      id: scenario.id,
      file,
      ok: true,
      detail: `${result.rows.length} row(s) trust=${result.trust}`,
      disposition: want,
      status: null,
      trust: result.trust,
    };
  } catch (err) {
    const status = err instanceof GraneError ? err.refusal.status : null;
    if (want !== "refuse") {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        disposition: "refuse",
        status,
        trust: null,
      };
    }
    const allowed = expected?.statuses ?? (expected?.status ? [expected.status] : []);
    if (allowed.length > 0 && (!status || !allowed.includes(status))) {
      return {
        id: scenario.id,
        file,
        ok: false,
        detail: `refusal ${status ?? "unstructured"} not in ${allowed.join("|")}`,
        disposition: "refuse",
        status,
        trust: null,
      };
    }
    return {
      id: scenario.id,
      file,
      ok: true,
      detail: status ? `refused ${status as RefusalStatus}` : "refused",
      disposition: "refuse",
      status,
      trust: null,
    };
  }
}

function fail(
  scenario: UserScenario,
  file: string,
  disposition: string,
  detail: string,
): UserTestResult {
  return { id: scenario.id, file, ok: false, detail, disposition, status: null, trust: null };
}

function checkGold(rows: Record<string, unknown>[], gold: z.infer<typeof goldSchema> | undefined): string | null {
  if (gold == null) return null;
  if (typeof gold === "number") {
    return compareScalar(rows, gold, undefined, undefined);
  }
  if (gold.kind === "empty") {
    return rows.length === 0 ? null : `expected empty result, got ${rows.length} row(s)`;
  }
  if (gold.kind === "rows") {
    if (rows.length !== gold.rows.length) {
      return `row count ${rows.length} !== ${gold.rows.length}`;
    }
    for (let i = 0; i < gold.rows.length; i++) {
      const got = normalizeRow(rows[i]!);
      const want = normalizeRow(gold.rows[i]!);
      if (JSON.stringify(got) !== JSON.stringify(want)) {
        return `row ${i} ${JSON.stringify(got)} !== ${JSON.stringify(want)}`;
      }
    }
    return null;
  }
  return compareScalar(rows, gold.value, gold.tolerance, gold.column);
}

function compareScalar(
  rows: Record<string, unknown>[],
  expected: number,
  tolerance: number | undefined,
  column: string | undefined,
): string | null {
  const actual = firstNumeric(rows, column);
  if (typeof actual !== "number" || !Number.isFinite(actual)) {
    return `no numeric gold cell (got ${String(actual)})`;
  }
  const tol = tolerance ?? 1e-6;
  if (Math.abs(actual - expected) > tol) {
    return `gold ${actual} !== ${expected} (±${tol})`;
  }
  return null;
}

function firstNumeric(rows: Record<string, unknown>[], column?: string): unknown {
  const row = rows[0];
  if (!row) return undefined;
  if (column && column in row) return Number(row[column]);
  for (const value of Object.values(row)) {
    if (typeof value === "number") return value;
    if (typeof value === "bigint") return Number(value);
    const n = Number(value);
    if (Number.isFinite(n) && value !== null && String(value).trim() !== "") return n;
  }
  return undefined;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (typeof value === "bigint") out[key] = Number(value);
    else if (value instanceof Date) out[key] = value.toISOString().slice(0, 10);
    else out[key] = value ?? null;
  }
  return out;
}

export function formatUserTestReport(report: UserTestReport): string {
  const lines = report.results.map((result) => {
    const tag = result.ok ? "PASS" : "FAIL";
    return `${tag}  ${result.id.padEnd(24)} ${result.detail}`;
  });
  lines.push("");
  lines.push(`${report.passed} passed, ${report.failed} failed, ${report.results.length} total`);
  return lines.join("\n");
}
