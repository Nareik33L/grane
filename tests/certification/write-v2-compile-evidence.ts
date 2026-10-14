import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAllEvidence, EVIDENCE_PROJECTS } from "./compile-evidence.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const evidence = await collectAllEvidence(ROOT);
writeFileSync(
  join(ROOT, "tests/fixtures/v2-compat/pre-v2-compile-evidence.json"),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

const lines = [
  "# V2 existing-YAML compile evidence",
  "",
  `Pre-V2 baseline: \`${evidence.baseline_commit}\` (last main before V2-01).`,
  "",
  evidence.generated_note,
  "",
  "This report is the committed before/after evidence that supported configs",
  "keep the **same metrics**, **same meaning**, and **same compiled SQL**.",
  "The machine-readable fixture is `tests/fixtures/v2-compat/pre-v2-compile-evidence.json`.",
  "CI recompiles the same projects and diffs this file.",
  "",
];

for (const project of evidence.projects) {
  lines.push(`## \`${project.project}\``);
  lines.push("");
  lines.push(
    project.yaml_bytes_identical_to_pre_v2
      ? `- YAML bytes match \`${evidence.baseline_commit}\`.`
      : `- YAML bytes **differ** from \`${evidence.baseline_commit}\`.`,
  );
  lines.push(`- Validate: ${project.validate_ok ? "ok" : "FAILED"}.`);
  lines.push(`- Metrics (${project.metrics.length}): ${project.metrics.map((metric) => metric.name).join(", ")}.`);
  lines.push("");
  lines.push("| Metric | Type | Entity | Meaning (description) |");
  lines.push("| --- | --- | --- | --- |");
  for (const metric of project.metrics) {
    const meaning = (metric.description ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
    lines.push(`| \`${metric.name}\` | ${metric.type} | ${metric.entity} | ${meaning} |`);
  }
  lines.push("");
  lines.push("Compiled SQL (normalized whitespace) for August 2026:");
  lines.push("");
  for (const compile of project.compiles) {
    lines.push(`### ${compile.name}`);
    lines.push("");
    lines.push("```sql");
    lines.push(compile.sql);
    lines.push("```");
    lines.push("");
  }
}

lines.push("## Projects covered");
lines.push("");
for (const rel of EVIDENCE_PROJECTS) {
  lines.push(`- \`${rel}\``);
}
lines.push("");

writeFileSync(join(ROOT, "docs/v2-compat-evidence.md"), `${lines.join("\n")}\n`);
console.log(`wrote evidence for ${evidence.projects.length} projects`);
