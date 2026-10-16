import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
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
    expect(ci).toMatch(/GRANE_CERT_REQUIRE:\s*postgres,duckdb,mysql,clickhouse/);
  });

  it("P0-1: BigQuery Actions secret is a JSON document materialized to a 0600 path", () => {
    // Named failure: treating the GitHub secret JSON as keyFilename silently
    // fails BigQuery authentication.
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    const docs = readFileSync(join(ROOT, "docs/certify.md"), "utf8");
    expect(wf).toMatch(/silently fails to authenticate/);
    expect(docs).toMatch(/silently fails to authenticate/);
    expect(docs).toMatch(/service-account JSON document/);
    expect(wf).toMatch(/mktemp -p "\$\{RUNNER_TEMP:-\/tmp\}"/);
    expect(wf).toMatch(/chmod 0600/);
    expect(wf).toMatch(/trap cleanup_bq_key EXIT/);
    expect(wf).toMatch(/name: Remove BigQuery key file\n {8}if: always\(\)/);
    expect(wf).toMatch(/rm -f -- "\$GRANE_BQ_KEY_FILE"/);
    expect(wf).toMatch(/printf '%s' "\$GRANE_CERT_BIGQUERY_JSON"/);
    expect(wf).toMatch(/GRANE_CERT_BIGQUERY_JSON:/);
    expect(wf).not.toMatch(
      /GRANE_CERT_BIGQUERY_CREDENTIALS:\s*\$\{\{\s*secrets\.GRANE_CERT_BIGQUERY_CREDENTIALS/,
    );
    expect(wf).not.toMatch(/echo\s+"\$GRANE_CERT_BIGQUERY/);
    expect(wf).not.toMatch(/echo\s+\$GRANE_CERT_BIGQUERY/);
    expect(wf).not.toMatch(/cat\s+"\$GRANE_CERT_BIGQUERY/);
    expect(wf).not.toMatch(/cat\s+"\$GRANE_BQ_KEY_FILE"/);
    expect(wf).toMatch(/head\.repo\.fork/);
    expect(wf).toMatch(/head\.repo\.full_name/);
    const withoutComments = wf.replace(/^\s*#.*$/gm, "");
    expect(withoutComments).not.toMatch(/pull_request_target/);
    expect(wf).toMatch(/path: certification\/\$\{\{ matrix\.engine \}\}\.json/);
    expect(wf).not.toMatch(/path:.*GRANE_BQ_KEY/);
    expect(wf).not.toMatch(/path:.*RUNNER_TEMP/);
    expect(wf.indexOf("Remove BigQuery key file")).toBeLessThan(wf.indexOf("Upload certification report"));
  });

  it("P0-1 materialize helper: mktemp 0600 under RUNNER_TEMP, trap deletes on failure", () => {
    const runnerTemp = mkdtempSync(join(tmpdir(), "grane-runner-temp-"));
    const workspace = mkdtempSync(join(tmpdir(), "grane-workspace-"));
    const script = `
      set +x
      set +o xtrace
      cleanup_bq_key() {
        if [ -n "\${GRANE_BQ_KEY_FILE:-}" ]; then
          rm -f -- "\$GRANE_BQ_KEY_FILE"
        fi
      }
      trap cleanup_bq_key EXIT
      GRANE_CERT_BIGQUERY_JSON='{"type":"service_account","private_key":"TEST"}'
      GRANE_BQ_KEY_FILE="$(mktemp -p "\${RUNNER_TEMP:-/tmp}" grane-bq-XXXXXX)"
      chmod 0600 "\$GRANE_BQ_KEY_FILE"
      printf '%s' "\$GRANE_CERT_BIGQUERY_JSON" > "\$GRANE_BQ_KEY_FILE"
      unset GRANE_CERT_BIGQUERY_JSON
      export GRANE_CERT_BIGQUERY_CREDENTIALS="\$GRANE_BQ_KEY_FILE"
      case "\$GRANE_BQ_KEY_FILE" in
        "\$RUNNER_TEMP"/*) ;;
        *) echo "key not under RUNNER_TEMP" >&2; exit 2 ;;
      esac
      case "\$GRANE_BQ_KEY_FILE" in
        "\$PWD"/*) echo "key under workspace" >&2; exit 3 ;;
      esac
      mode=\$(stat -c '%a' "\$GRANE_BQ_KEY_FILE")
      [ "\$mode" = "600" ] || { echo "mode=\$mode" >&2; exit 4; }
      printf '%s' '{"type":"service_account","private_key":"TEST"}' | cmp -s - "\$GRANE_BQ_KEY_FILE" || exit 5
      echo ok-path-mode
      false
    `;
    try {
      try {
        execFileSync("bash", ["-c", script], {
          cwd: workspace,
          env: { ...process.env, RUNNER_TEMP: runnerTemp },
          encoding: "utf8",
        });
        throw new Error("expected materialize script to fail after writing the key");
      } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        if (e.status === undefined) throw err;
        expect(e.status, e.stderr).toBe(1);
        expect(e.stdout ?? "").toMatch(/ok-path-mode/);
        expect(`${e.stdout ?? ""}${e.stderr ?? ""}`).not.toMatch(/private_key/);
      }
      expect(readdirSync(runnerTemp).filter((name) => name.startsWith("grane-bq-"))).toEqual([]);
      expect(readdirSync(workspace).filter((name) => name.includes("grane-bq"))).toEqual([]);
    } finally {
      rmSync(runnerTemp, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    }
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
