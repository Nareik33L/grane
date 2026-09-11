import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CertCapabilities } from "../helpers/cert-engine.js";

export type CertScenarioResult = {
  name: string;
  status: "pass" | "fail" | "skip";
};

export type CertReport = {
  engine: string;
  engineVersion: string;
  sessionSettings: Record<string, string>;
  capabilities: CertCapabilities;
  generatedAt: string;
  scenarios: CertScenarioResult[];
  connectorSafety: {
    writeSqlRefused: boolean;
    hiddenColumnsAbsent: boolean;
    utcSession: boolean;
  };
};

/** Writes `certification/<engine>.json` (gitignored). Returns the path. */
export function writeCertificationReport(report: CertReport, dir = "certification"): string {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${report.engine}.json`);
  writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
  return dest;
}
