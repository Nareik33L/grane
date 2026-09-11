import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type CertScenarioResult = {
  name: string;
  status: "pass" | "fail" | "skip";
};

export type CertCapabilitiesReport = {
  readOnlyTransaction: boolean;
  timestamptz: boolean;
  fkIntrospection: boolean;
  postgresReadonlyRole: boolean;
  mutateSeed: boolean;
  sessionTimezoneLocal: boolean;
  mcpCli: boolean;
  filterClause: boolean;
};

export type CertReport = {
  engine: string;
  engineVersion: string;
  sessionSettings: Record<string, string>;
  capabilities: CertCapabilitiesReport | Record<string, boolean>;
  generatedAt: string;
  scenarios: CertScenarioResult[];
  connectorSafety: {
    writeSqlRefused: boolean;
    hiddenColumnsAbsent: boolean;
    utcSession: boolean;
  };
  /** Isolated namespace this run created (and should drop). */
  schemaName?: string;
  /** Overall CLI outcome. Corpus writes omit this; skip reports set `skipped`. */
  status?: "pass" | "fail" | "skipped" | "refused";
  skipReason?: string;
};

/** Writes `certification/<engine>.json` (gitignored). Returns the path. */
export function writeCertificationReport(report: CertReport, dir = "certification"): string {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${report.engine}.json`);
  writeFileSync(dest, `${JSON.stringify(report, null, 2)}\n`);
  return dest;
}

export function formatCertifySummary(report: CertReport): string {
  const scenarios = report.scenarios ?? [];
  const pass = scenarios.filter((s) => s.status === "pass").length;
  const fail = scenarios.filter((s) => s.status === "fail").length;
  const skip = scenarios.filter((s) => s.status === "skip").length;
  const overall =
    report.status ?? (fail > 0 ? "fail" : report.skipReason ? "skipped" : "pass");
  const lines = [
    `Grane certification: ${report.engine}`,
    "",
    `Engine:    ${report.engine} (${report.engineVersion || "unknown"})`,
    `Namespace: ${report.schemaName ?? "(see sessionSettings)"} — created and dropped by this run; adopter tables are not used`,
    `Status:    ${overall}`,
  ];
  if (report.skipReason) {
    lines.push(`Reason:    ${report.skipReason}`);
  }
  if (scenarios.length > 0) {
    lines.push(`Scenarios: ${pass} pass / ${fail} fail / ${skip} skip (${scenarios.length} total)`);
    lines.push("");
    for (const s of scenarios) {
      const tag = s.status === "pass" ? "PASS" : s.status === "skip" ? "SKIP" : "FAIL";
      lines.push(`${tag.padEnd(4)} ${s.name}`);
    }
  }
  lines.push("");
  const safety = report.connectorSafety;
  if (safety) {
    lines.push(
      `Connector safety: writeSqlRefused=${safety.writeSqlRefused} hiddenColumnsAbsent=${safety.hiddenColumnsAbsent} utcSession=${safety.utcSession}`,
    );
  }
  return lines.join("\n");
}

export function emptySkipReport(engine: string, reason: string): CertReport {
  return {
    engine,
    engineVersion: "",
    sessionSettings: {},
    capabilities: {},
    generatedAt: new Date().toISOString(),
    scenarios: [],
    connectorSafety: { writeSqlRefused: false, hiddenColumnsAbsent: false, utcSession: false },
    status: "skipped",
    skipReason: reason,
  };
}

export function emptyRefusedReport(engine: string, reason: string, schemaName?: string): CertReport {
  return {
    engine,
    engineVersion: "",
    sessionSettings: {},
    capabilities: {},
    generatedAt: new Date().toISOString(),
    scenarios: [{ name: "create-schema privilege", status: "fail" }],
    connectorSafety: { writeSqlRefused: false, hiddenColumnsAbsent: false, utcSession: false },
    schemaName,
    status: "refused",
    skipReason: reason,
  };
}
