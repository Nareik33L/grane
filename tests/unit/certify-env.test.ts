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
const WORKFLOW = join(ROOT, ".github/workflows/certify-cloud.yml");

function workflowText(): string {
  return readFileSync(WORKFLOW, "utf8");
}

function trimmedLines(text: string): string[] {
  return text.split("\n").map((line) => line.trimEnd().trimStart());
}

function sliceStep(wf: string, name: string, nextName: string): string {
  const start = wf.indexOf(`- name: ${name}`);
  const end = wf.indexOf(`- name: ${nextName}`);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`workflow step "${name}" .. "${nextName}" not found`);
  }
  return wf.slice(start, end);
}

function cleanupCertKeysBody(wf: string): string {
  const match = wf.match(/cleanup_cert_keys\(\) \{([\s\S]*?)\n          \}/);
  if (!match?.[1]) throw new Error("cleanup_cert_keys() not found");
  return match[1];
}

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
    expect(wf).toMatch(/mktemp -p "\$\{RUNNER_TEMP:-\/tmp\}" grane-bq-XXXXXX/);
    expect(trimmedLines(wf)).toContain('chmod 0600 "$GRANE_BQ_KEY_FILE"');
    expect(wf).not.toMatch(/chmod 0644 "\$GRANE_BQ_KEY_FILE"/);
    expect(wf).toMatch(/cleanup_bq_key\(\)/);
    expect(wf).toMatch(/trap cleanup_cert_keys EXIT/);
    expect(cleanupCertKeysBody(wf)).toMatch(/^\s*cleanup_bq_key\s*$/m);
    expect(wf).toMatch(/name: Remove Snowflake and BigQuery key files\n {8}if: always\(\)/);
    expect(trimmedLines(sliceStep(wf, "Remove Snowflake and BigQuery key files", "Upload certification report"))).toContain(
      'rm -f -- "$GRANE_BQ_KEY_FILE"',
    );
    expect(wf).toMatch(/printf '%s' "\$GRANE_CERT_BIGQUERY_JSON"/);
    expect(wf).toMatch(/unset GRANE_CERT_BIGQUERY_JSON/);
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
    expect(wf.indexOf("Remove Snowflake and BigQuery key files")).toBeLessThan(wf.indexOf("Upload certification report"));
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

  it("P0-2: Snowflake private key is materialized at 0600; password-only MFA failure is named", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    const grants = readFileSync(join(ROOT, "docs/certify-grants.md"), "utf8");
    expect(wf).toMatch(/password-only sign-in is being phased out/);
    expect(wf).toMatch(/user with no\n# TYPE counts as human and needs MFA, so an automated certify run will fail/);
    expect(grants).toMatch(/TYPE = SERVICE/);
    expect(grants).toMatch(/RSA_PUBLIC_KEY/);
    expect(grants).toMatch(/PROGRAMMATIC ACCESS TOKEN/);
    expect(grants).toMatch(/NETWORK POLICY/);
    expect(grants).toMatch(/only objects it created inside the isolated parent/);
    expect(grants).toMatch(/CREATE USER` needs a superuser or\na role with the `CREATE USER` privilege/);
    expect(grants).toMatch(/TEMP` is still granted to `PUBLIC`/);
    expect(grants).toMatch(/disableServiceAccountKeyCreation/);
    expect(grants).toMatch(/GRANE_CERT_DATABRICKS_CATALOG/);
    expect(grants).toMatch(/falls back to `main`/);
    expect(grants).toMatch(/MANAGED LOCATION/);
    expect(grants).toMatch(/databricks-sql-access/);
    expect(wf).toMatch(/mktemp -p "\$\{RUNNER_TEMP:-\/tmp\}" grane-sf-XXXXXX/);
    expect(trimmedLines(wf)).toContain('chmod 0600 "$GRANE_SF_KEY_FILE"');
    expect(wf).not.toMatch(/chmod 0644 "\$GRANE_SF_KEY_FILE"/);
    expect(wf).toMatch(/cleanup_sf_key\(\)/);
    expect(wf).toMatch(/trap cleanup_cert_keys EXIT/);
    expect(cleanupCertKeysBody(wf)).toMatch(/^\s*cleanup_sf_key\s*$/m);
    expect(wf).toMatch(/name: Remove Snowflake and BigQuery key files\n {8}if: always\(\)/);
    expect(wf).toMatch(/printf '%s' "\$GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM"/);
    expect(wf).toMatch(/unset GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM/);
    expect(trimmedLines(sliceStep(wf, "Remove Snowflake and BigQuery key files", "Upload certification report"))).toContain(
      'rm -f -- "$GRANE_SF_KEY_FILE"',
    );
    expect(grants).toMatch(
      /openssl genrsa 2048 \| openssl pkcs8 -topk8 -v2 aes-256-cbc -inform PEM -out rsa_key\.p8/,
    );
    expect(wf).not.toMatch(
      /GRANE_CERT_SNOWFLAKE_PRIVATE_KEY:\s*\$\{\{\s*secrets\.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY/,
    );
    expect(wf).not.toMatch(/echo\s+"\$GRANE_CERT_SNOWFLAKE_PRIVATE_KEY/);
    const withoutComments = wf.replace(/^\s*#.*$/gm, "");
    expect(withoutComments).not.toMatch(/pull_request_target/);
    expect(wf.indexOf("Remove Snowflake and BigQuery key files")).toBeLessThan(wf.indexOf("Upload certification report"));
  });

  it("unsets GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM after writing the 0600 file", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    expect(wf).toMatch(/unset GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM/);
  });

  it("forks do not receive GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM", () => {
    const wf = workflowText();
    expect(wf).toMatch(
      /GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PEM:\s*\$\{\{ \(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) && secrets\.GRANE_CERT_SNOWFLAKE_PRIVATE_KEY \|\| '' \}\}/,
    );
  });

  it("forks do not receive GRANE_CERT_BIGQUERY_JSON", () => {
    const wf = workflowText();
    expect(wf).toMatch(
      /GRANE_CERT_BIGQUERY_JSON:\s*\$\{\{ \(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) && secrets\.GRANE_CERT_BIGQUERY_CREDENTIALS \|\| '' \}\}/,
    );
  });

  it("certify-cloud key handling: exact chmod, trap, always() rm, fork guard, set +x", () => {
    // Mutations this test must catch: chmod 0644 or removed per engine,
    // trap dropping cleanup_sf_key or cleanup_bq_key, always() dropping an rm,
    // missing BigQuery fork guard, missing set +x.
    const wf = workflowText();
    const lines = trimmedLines(wf);
    expect(lines, "Snowflake chmod 0600 removed or not 0600").toContain('chmod 0600 "$GRANE_SF_KEY_FILE"');
    expect(lines, "BigQuery chmod 0600 removed or not 0600").toContain('chmod 0600 "$GRANE_BQ_KEY_FILE"');
    expect(wf).not.toMatch(/chmod 0644 "\$GRANE_SF_KEY_FILE"/);
    expect(wf).not.toMatch(/chmod 0644 "\$GRANE_BQ_KEY_FILE"/);

    expect(wf).toContain("trap cleanup_cert_keys EXIT");
    const trapBody = cleanupCertKeysBody(wf);
    expect(trapBody, "trap/cleanup_cert_keys dropped cleanup_sf_key").toMatch(/^\s*cleanup_sf_key\s*$/m);
    expect(trapBody, "trap/cleanup_cert_keys dropped cleanup_bq_key").toMatch(/^\s*cleanup_bq_key\s*$/m);

    const always = sliceStep(wf, "Remove Snowflake and BigQuery key files", "Upload certification report");
    expect(always).toMatch(/if: always\(\)/);
    const alwaysLines = trimmedLines(always);
    expect(alwaysLines, "always() missing Snowflake rm").toContain('rm -f -- "$GRANE_SF_KEY_FILE"');
    expect(alwaysLines, "always() missing BigQuery rm").toContain('rm -f -- "$GRANE_BQ_KEY_FILE"');
    expect(alwaysLines, "always() missing set +x").toContain("set +x");

    const certify = sliceStep(wf, "Certify ${{ matrix.engine }}", "Remove Snowflake and BigQuery key files");
    expect(trimmedLines(certify), "certify step missing set +x").toContain("set +x");

    expect(wf).toMatch(
      /GRANE_CERT_BIGQUERY_JSON:\s*\$\{\{ \(github\.event_name != 'pull_request' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\) && secrets\.GRANE_CERT_BIGQUERY_CREDENTIALS \|\| '' \}\}/,
    );
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
