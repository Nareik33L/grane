import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { certEnvContractMarkdown, CLOUD_CERT_ENGINES } from "../../src/certify/env.js";
import { WAREHOUSE_CERTIFICATION } from "../../src/connectors/certification.js";
import { ddl } from "../certification/ddl.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

describe("certify env-var contract", () => {
  it("docs/certify.md is the single source rendered from src/certify/env.ts", () => {
    const docs = readFileSync(join(ROOT, "docs/certify.md"), "utf8");
    expect(docs).toContain(certEnvContractMarkdown());
    expect(docs).toMatch(/grane certify --engine/);
    expect(docs).toMatch(/Postgres certification does\s+not cover Redshift/);
  });

  it("certify-cloud.yml is dormant: dispatch + skip without secrets + continue-on-error false only on certify", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).toMatch(/cron: "0 6 \* \* 1"/);
    expect(wf).toMatch(/certify-cloud/);
    expect(wf).toMatch(/continue-on-error: false/);
    expect(wf).toMatch(/GRANE_CERT_REDSHIFT_URL/);
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toMatch(/GRANE_CERT_SNOWFLAKE/);
    expect(ci).not.toMatch(/GRANE_CERT_BIGQUERY/);
    expect(ci).not.toMatch(/GRANE_CERT_DATABRICKS/);
    expect(ci).not.toMatch(/GRANE_CERT_REDSHIFT/);
  });

  it("cloud engines stay self_certifiable (no CI-certified flip)", () => {
    for (const type of CLOUD_CERT_ENGINES) {
      expect(WAREHOUSE_CERTIFICATION[type].certification).toBe("self_certifiable");
      expect(WAREHOUSE_CERTIFICATION[type].certified_version).toBeNull();
    }
  });

  it("shared ddl quotes BigQuery/Databricks with backticks and keeps a Redshift path", () => {
    expect(ddl("bigquery").some((s) => s.includes("`orders`"))).toBe(true);
    expect(ddl("databricks").some((s) => s.includes("`orders`"))).toBe(true);
    expect(ddl("redshift").some((s) => s.includes("VARCHAR(65535)"))).toBe(true);
    expect(ddl("snowflake").some((s) => s.includes("TIMESTAMP_NTZ"))).toBe(true);
  });
});
