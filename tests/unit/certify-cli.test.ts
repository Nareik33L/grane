import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CertifyPrivilegeError, createSchemaRequiredMessage } from "../../src/certify/errors.js";
import {
  CERT_ENV_CONTRACT,
  CLOUD_CERT_ENGINES,
  cloudCertCredentialsAvailable,
  missingCertEnvVars,
  parseWarehouseType,
  skipMissingCloudEnvMessage,
} from "../../src/certify/env.js";
import { formatCertifySummary, writeCertificationReport } from "../../src/certify/report.js";
import { runCertify } from "../../src/certify/run.js";
import { isCertifySchemaName, newCertifySchemaName } from "../../src/certify/schema.js";
import { snowflakeCertEngine } from "../helpers/engines/snowflake-cert.js";
import { bigqueryCertEngine } from "../helpers/engines/bigquery-cert.js";
import { databricksCertEngine } from "../helpers/engines/databricks-cert.js";
import { redshiftCertEngine } from "../helpers/engines/redshift-cert.js";

function emptyCloudEnv(): NodeJS.Dict<string> {
  const env: NodeJS.Dict<string> = { ...process.env };
  for (const type of CLOUD_CERT_ENGINES) {
    for (const v of CERT_ENV_CONTRACT[type].vars) {
      delete env[v.name];
    }
  }
  return env;
}

describe("grane certify CLI", () => {
  it("skips Snowflake / BigQuery / Databricks / Redshift when GRANE_CERT_* is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-certify-"));
    const env = emptyCloudEnv();
    for (const engine of CLOUD_CERT_ENGINES) {
      const result = await runCertify({ engine, outDir: dir }, { env, runCorpus: async () => {
        throw new Error("corpus must not run when cloud secrets are absent");
      }});
      expect(result.outcome).toBe("skipped");
      expect(result.exitCode).toBe(0);
      expect(result.summary).toMatch(/Skipping/);
      expect(result.report.status).toBe("skipped");
      const written = JSON.parse(readFileSync(join(dir, `${engine}.json`), "utf8")) as { status: string };
      expect(written.status).toBe("skipped");
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat GRANE_PG_* as Redshift credentials", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-certify-"));
    const env = emptyCloudEnv();
    env.GRANE_PG_WRITE_URL = "postgres://grane:grane@127.0.0.1:5432/grane_demo";
    env.GRANE_PG_READ_URL = "postgres://grane_readonly:grane_readonly@127.0.0.1:5432/grane_demo";
    const result = await runCertify({ engine: "redshift", outDir: dir }, { env, runCorpus: async () => {
      throw new Error("Postgres URLs must not enroll Redshift");
    }});
    expect(result.outcome).toBe("skipped");
    expect(result.summary).toMatch(/GRANE_CERT_REDSHIFT_URL/);
    expect(result.summary).not.toMatch(/GRANE_PG_WRITE_URL/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses when CREATE SCHEMA is denied and never seeds adopter tables", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-certify-"));
    const env = { ...emptyCloudEnv(), GRANE_CERT_REDSHIFT_URL: "postgres://readonly@example/db" };
    const err = new CertifyPrivilegeError("redshift", "grane_cert_test", "permission denied for database");
    const result = await runCertify(
      { engine: "redshift", outDir: dir },
      {
        env,
        runCorpus: async () => {
          throw err;
        },
      },
    );
    expect(result.outcome).toBe("refused");
    expect(result.exitCode).toBe(1);
    expect(result.summary).toMatch(/never writes to existing adopter tables/);
    expect(result.report.scenarios[0]?.status).toBe("fail");
    rmSync(dir, { recursive: true, force: true });
  });

  it("resolves --engine and rejects unknown types", () => {
    expect(parseWarehouseType("Redshift")).toBe("redshift");
    expect(() => parseWarehouseType("oracle")).toThrow(/Unknown engine/);
  });

  it("uses grane.yml connection.type when --engine is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-certify-"));
    const result = await runCertify(
      { outDir: dir },
      {
        env: emptyCloudEnv(),
        loadProjectType: () => "snowflake",
        runCorpus: async () => {
          throw new Error("should skip before corpus");
        },
      },
    );
    expect(result.engine).toBe("snowflake");
    expect(result.outcome).toBe("skipped");
    rmSync(dir, { recursive: true, force: true });
  });

  it("picks up the shared corpus report from the project certification/ directory", async () => {
    const project = mkdtempSync(join(tmpdir(), "grane-certify-proj-"));
    const out = mkdtempSync(join(tmpdir(), "grane-certify-out-"));
    mkdirSync(join(project, "certification"));
    writeFileSync(
      join(project, "certification", "duckdb.json"),
      `${JSON.stringify({
        engine: "duckdb",
        engineVersion: "v1.5",
        sessionSettings: { schema: "main" },
        capabilities: {},
        generatedAt: "2026-09-11T00:00:00.000Z",
        scenarios: [{ name: "SUM gold", status: "pass" }],
        connectorSafety: { writeSqlRefused: true, hiddenColumnsAbsent: true, utcSession: true },
        schemaName: "main",
      })}\n`,
    );
    const result = await runCertify(
      { engine: "duckdb", projectDir: project, outDir: out },
      {
        env: emptyCloudEnv(),
        runCorpus: async () => ({ status: 0, stdout: "", stderr: "" }),
      },
    );
    expect(result.outcome).toBe("pass");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toMatch(/SUM gold/);
    expect(result.summary).toMatch(/Wrote /);
    rmSync(project, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it("writes a human summary from a corpus report", () => {
    const report = {
      engine: "duckdb",
      engineVersion: "v1.5",
      sessionSettings: {},
      capabilities: {},
      generatedAt: "2026-09-11T00:00:00.000Z",
      schemaName: "grane_cert_abc",
      scenarios: [
        { name: "SUM gold", status: "pass" as const },
        { name: "contains", status: "skip" as const },
      ],
      connectorSafety: { writeSqlRefused: true, hiddenColumnsAbsent: true, utcSession: true },
    };
    const dir = mkdtempSync(join(tmpdir(), "grane-certify-"));
    const path = writeCertificationReport(report, dir);
    expect(path).toBe(join(dir, "duckdb.json"));
    const summary = formatCertifySummary(report);
    expect(summary).toMatch(/Grane certification: duckdb/);
    expect(summary).toMatch(/1 pass \/ 0 fail \/ 1 skip/);
    expect(summary).toMatch(/grane_cert_abc/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("names isolated schemas grane_cert_<runid>", () => {
    const name = newCertifySchemaName();
    expect(isCertifySchemaName(name)).toBe(true);
    expect(name.startsWith("grane_cert_")).toBe(true);
  });

  it("prints a CREATE SCHEMA refusal that forbids touching adopter tables", () => {
    const msg = createSchemaRequiredMessage("snowflake", "grane_cert_x", "403");
    expect(msg).toMatch(/CREATE SCHEMA/);
    expect(msg).toMatch(/never writes to existing adopter tables/);
  });
});

describe("cloud CertEngine adapters", () => {
  it("available() is false without GRANE_CERT_* (in-repo skip, not OSS CI)", async () => {
    const saved: Record<string, string | undefined> = {};
    for (const type of CLOUD_CERT_ENGINES) {
      for (const v of CERT_ENV_CONTRACT[type].vars) {
        saved[v.name] = process.env[v.name];
        delete process.env[v.name];
      }
    }
    try {
      expect(await snowflakeCertEngine.available()).toBe(false);
      expect(await bigqueryCertEngine.available()).toBe(false);
      expect(await databricksCertEngine.available()).toBe(false);
      expect(await redshiftCertEngine.available()).toBe(false);
      expect(cloudCertCredentialsAvailable("snowflake").missing).toContain("GRANE_CERT_SNOWFLAKE_ACCOUNT");
      expect(missingCertEnvVars("redshift")).toEqual(["GRANE_CERT_REDSHIFT_URL"]);
      expect(skipMissingCloudEnvMessage("bigquery", ["GRANE_CERT_BIGQUERY_PROJECT"])).toMatch(/self_certifiable/);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
