/**
 * CI entry: compare certification/postgres.json (example/) and
 * certification/duckdb.json (demo/) to the pre-V2 scenario baseline.
 *
 * Run after `npm run test:unit`, which writes those reports.
 */
import {
  assertPreV2CertifyCompat,
  DEMO_CERTIFY_ENGINE,
  EXAMPLE_CERTIFY_ENGINE,
  PRE_V2_CERTIFY_BASELINE,
  readCertifyReport,
  requiredCertEngines,
} from "./v2-compat.js";

const targets = [
  { engine: EXAMPLE_CERTIFY_ENGINE, project: "example/analytics" },
  { engine: DEMO_CERTIFY_ENGINE, project: "demo/analytics" },
] as const;

const required = requiredCertEngines();
const errors: string[] = [];

for (const { engine, project } of targets) {
  const report = readCertifyReport(engine);
  if (!report) {
    if (required.includes(engine)) {
      errors.push(`${project} (${engine}): certification/${engine}.json missing after the corpus`);
    } else {
      console.log(`skip ${project} (${engine}): no report and ${engine} is not in GRANE_CERT_REQUIRE`);
    }
    continue;
  }
  const found = assertPreV2CertifyCompat(report);
  if (found.length === 0) {
    console.log(
      `ok ${project} (${engine}): ${report.scenarios.length} scenarios match pre-V2 ${PRE_V2_CERTIFY_BASELINE}`,
    );
  }
  errors.push(...found);
}

if (errors.length > 0) {
  console.error(`V2 certify compat failed vs ${PRE_V2_CERTIFY_BASELINE}:`);
  for (const line of errors) console.error(`  ${line}`);
  process.exit(1);
}

if (required.length === 0 && targets.every(({ engine }) => !readCertifyReport(engine))) {
  console.log(`skip: no certification reports and GRANE_CERT_REQUIRE is unset`);
}
