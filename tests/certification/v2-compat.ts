/**
 * V2-15: compare example/ (postgres) and demo/ (duckdb) certify reports
 * to the pre-V2 main baseline (7a7ffc6).
 *
 * Volatile fields (generatedAt, engineVersion, schemaName, sessionSettings)
 * are stripped. Scenario names must match the frozen list; each must pass.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CertReport, CertScenarioResult } from "../../src/certify/report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const baselineScenarios = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/v2-compat/pre-v2-certify-scenarios.json"), "utf8"),
) as { baseline: string; engines: string[]; scenarios: string[] };

export const PRE_V2_CERTIFY_BASELINE = baselineScenarios.baseline;
export const PRE_V2_CERTIFY_ENGINES = baselineScenarios.engines;
export const PRE_V2_CERTIFY_SCENARIOS = baselineScenarios.scenarios;

export const EXAMPLE_CERTIFY_ENGINE = "postgres";
export const DEMO_CERTIFY_ENGINE = "duckdb";

export type CompatCertPayload = {
  engine: string;
  scenarios: Array<{ name: string; status: string }>;
  connectorSafety: { writeSqlRefused: boolean; hiddenColumnsAbsent: boolean; utcSession: boolean };
};

export function normalizeCertReport(report: Pick<CertReport, "engine" | "scenarios" | "connectorSafety">): CompatCertPayload {
  const byName = new Map<string, CertScenarioResult>();
  for (const scenario of report.scenarios ?? []) {
    byName.set(scenario.name, scenario);
  }
  return {
    engine: report.engine,
    scenarios: PRE_V2_CERTIFY_SCENARIOS.map((name) => {
      const hit = byName.get(name);
      return { name, status: hit?.status ?? "missing" };
    }),
    connectorSafety: {
      writeSqlRefused: Boolean(report.connectorSafety?.writeSqlRefused),
      hiddenColumnsAbsent: Boolean(report.connectorSafety?.hiddenColumnsAbsent),
      utcSession: Boolean(report.connectorSafety?.utcSession),
    },
  };
}

export function assertPreV2CertifyCompat(
  report: Pick<CertReport, "engine" | "scenarios" | "connectorSafety">,
): string[] {
  const errors: string[] = [];
  const names = (report.scenarios ?? []).map((s) => s.name);
  const extra = names.filter((name) => !PRE_V2_CERTIFY_SCENARIOS.includes(name));
  const missing = PRE_V2_CERTIFY_SCENARIOS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    errors.push(`${report.engine}: missing pre-V2 scenarios: ${missing.join(" | ")}`);
  }
  if (extra.length > 0) {
    errors.push(`${report.engine}: extra scenarios vs pre-V2 ${PRE_V2_CERTIFY_BASELINE}: ${extra.join(" | ")}`);
  }
  for (const scenario of report.scenarios ?? []) {
    if (!PRE_V2_CERTIFY_SCENARIOS.includes(scenario.name)) continue;
    if (scenario.status !== "pass") {
      errors.push(`${report.engine}: ${scenario.name} is ${scenario.status} (pre-V2 required pass)`);
    }
  }
  const safety = report.connectorSafety;
  if (!safety?.writeSqlRefused || !safety.hiddenColumnsAbsent || !safety.utcSession) {
    errors.push(
      `${report.engine}: connectorSafety drifted: writeSqlRefused=${safety?.writeSqlRefused} hiddenColumnsAbsent=${safety?.hiddenColumnsAbsent} utcSession=${safety?.utcSession}`,
    );
  }
  return errors;
}

export function readCertifyReport(engine: string, dir = join(ROOT, "certification")): CertReport | null {
  const path = join(dir, `${engine}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as CertReport;
}

export function requiredCertEngines(env: NodeJS.Dict<string> = process.env): string[] {
  return (env.GRANE_CERT_REQUIRE ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
