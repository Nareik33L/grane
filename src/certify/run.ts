import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import type { WarehouseType } from "../config/schema.js";
import { WAREHOUSE_CERTIFICATION } from "../connectors/certification.js";
import {
  cloudCertCredentialsAvailable,
  isCloudCertEngine,
  parseWarehouseType,
  skipMissingCloudEnvMessage,
  type CloudCertEngine,
} from "./env.js";
import { isCertifyPrivilegeError } from "./errors.js";
import {
  emptyRefusedReport,
  emptySkipReport,
  formatCertifySummary,
  writeCertificationReport,
  type CertReport,
} from "./report.js";
import { spawnVitestCorpus } from "./corpus-runner.js";

export type CertifyCliOutcome = "pass" | "fail" | "skipped" | "refused";

export type CertifyCliResult = {
  engine: WarehouseType;
  outcome: CertifyCliOutcome;
  exitCode: number;
  summary: string;
  reportPath?: string;
  report: CertReport;
};

export type CorpusRunOutcome = {
  status: number;
  stdout: string;
  stderr: string;
  error?: unknown;
};

export type CertifyDeps = {
  runCorpus?: (engine: WarehouseType, cwd: string) => Promise<CorpusRunOutcome>;
  loadProjectType?: (projectDir: string) => WarehouseType | undefined;
  env?: NodeJS.Dict<string>;
  writeReport?: typeof writeCertificationReport;
};

export type CertifyOptions = {
  engine?: string;
  projectDir?: string;
  outDir?: string;
  json?: boolean;
};

function loadProjectConnectionType(projectDir: string): WarehouseType | undefined {
  try {
    const loaded = loadConfig(projectDir);
    return loaded.config.connection.type;
  } catch {
    return undefined;
  }
}

export function resolveCertifyEngine(options: CertifyOptions, deps: CertifyDeps = {}): WarehouseType {
  if (options.engine) return parseWarehouseType(options.engine);
  const loader = deps.loadProjectType ?? loadProjectConnectionType;
  const fromProject = loader(options.projectDir ?? ".");
  if (fromProject) return fromProject;
  throw new Error("Pass --engine <type> or run inside a Grane project with grane.yml.");
}

function readExistingReport(outDir: string, engine: string): CertReport | null {
  const path = join(outDir, `${engine}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CertReport;
  } catch {
    return null;
  }
}

function reportOutcome(report: CertReport): CertifyCliOutcome {
  if (report.status === "skipped" || report.status === "refused") return report.status;
  if (report.scenarios.some((s) => s.status === "fail")) return "fail";
  return "pass";
}

function exitCodeFor(outcome: CertifyCliOutcome): number {
  if (outcome === "pass" || outcome === "skipped") return 0;
  return 1;
}

/**
 * Run the shared certification corpus against one engine.
 *
 * Cloud engines without `GRANE_CERT_*` skip (exit 0). Connections that cannot
 * CREATE SCHEMA refuse (exit 1) and never seed into an existing adopter schema.
 */
export async function runCertify(options: CertifyOptions, deps: CertifyDeps = {}): Promise<CertifyCliResult> {
  const env = deps.env ?? process.env;
  const outDir = options.outDir ?? "certification";
  const write = deps.writeReport ?? writeCertificationReport;
  const engine = resolveCertifyEngine(options, deps);
  const cert = WAREHOUSE_CERTIFICATION[engine];

  if (isCloudCertEngine(engine)) {
    const creds = cloudCertCredentialsAvailable(engine, env);
    if (!creds.available) {
      const reason = skipMissingCloudEnvMessage(engine, creds.missing);
      const report = emptySkipReport(engine, reason);
      const reportPath = write(report, outDir);
      return {
        engine,
        outcome: "skipped",
        exitCode: 0,
        summary: formatCertifySummary(report),
        reportPath,
        report,
      };
    }
  }

  const cwd = options.projectDir ?? process.cwd();
  const runCorpus = deps.runCorpus ?? ((type, dir) => spawnVitestCorpus(type, { cwd: dir, extraEnv: env as NodeJS.ProcessEnv }));

  let spawned: CorpusRunOutcome;
  try {
    spawned = await runCorpus(engine, cwd);
  } catch (err) {
    if (isCertifyPrivilegeError(err)) {
      const report = emptyRefusedReport(engine, err.message, undefined);
      const reportPath = write(report, outDir);
      return {
        engine,
        outcome: "refused",
        exitCode: 1,
        summary: formatCertifySummary(report),
        reportPath,
        report,
      };
    }
    throw err;
  }

  const combined = `${spawned.stdout}\n${spawned.stderr}`;
  if (spawned.error && isCertifyPrivilegeError(spawned.error)) {
    const report = emptyRefusedReport(engine, spawned.error.message);
    const reportPath = write(report, outDir);
    return {
      engine,
      outcome: "refused",
      exitCode: 1,
      summary: formatCertifySummary(report),
      reportPath,
      report,
    };
  }
  if (/never writes to existing adopter tables/i.test(combined)) {
    const report = emptyRefusedReport(engine, combined.trim().slice(0, 2000));
    const reportPath = write(report, outDir);
    return {
      engine,
      outcome: "refused",
      exitCode: 1,
      summary: formatCertifySummary(report),
      reportPath,
      report,
    };
  }

  const fromCorpus =
    readExistingReport(outDir, engine) ?? readExistingReport(join(cwd, "certification"), engine);
  if (fromCorpus) {
    const outcome = spawned.status === 0 ? reportOutcome(fromCorpus) : "fail";
    if (!fromCorpus.schemaName) {
      fromCorpus.schemaName = fromCorpus.sessionSettings.schema ?? fromCorpus.sessionSettings.database;
    }
    fromCorpus.status = outcome === "pass" ? "pass" : outcome === "skipped" ? "skipped" : "fail";
    const reportPath = write(fromCorpus, outDir);
    const summary = `${formatCertifySummary(fromCorpus)}\n\nWrote ${reportPath}\nCertification map: ${cert.certification}${
      cert.certified_version ? ` (CI ${cert.certified_version})` : " — not flipped to certified without CI evidence"
    }`;
    return {
      engine,
      outcome,
      exitCode: exitCodeFor(outcome),
      summary,
      reportPath,
      report: fromCorpus,
    };
  }

  if (spawned.status === 0) {
    const reason = `${engine} did not enroll (adapter available() is false). ${
      isCloudCertEngine(engine)
        ? skipMissingCloudEnvMessage(engine as CloudCertEngine, [])
        : "Start the warehouse or set the documented env vars (docs/certify.md)."
    }`;
    const report = emptySkipReport(engine, reason);
    const reportPath = write(report, outDir);
    return {
      engine,
      outcome: "skipped",
      exitCode: 0,
      summary: formatCertifySummary(report),
      reportPath,
      report,
    };
  }

  const failReport: CertReport = {
    engine,
    engineVersion: "",
    sessionSettings: {},
    capabilities: {},
    generatedAt: new Date().toISOString(),
    scenarios: [{ name: "shared corpus", status: "fail" }],
    connectorSafety: { writeSqlRefused: false, hiddenColumnsAbsent: false, utcSession: false },
    status: "fail",
    skipReason: combined.trim().slice(0, 2000) || `vitest exited ${spawned.status}`,
  };
  const reportPath = write(failReport, outDir);
  return {
    engine,
    outcome: "fail",
    exitCode: 1,
    summary: formatCertifySummary(failReport),
    reportPath,
    report: failReport,
  };
}
