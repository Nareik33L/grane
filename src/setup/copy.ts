import { DEMO_QUESTION } from "../demo/run.js";

export { DEMO_QUESTION };

export const OWN_QUESTION = "What can you see in the catalog?";

export function importInspectOnlyLines(opts: { projectDir: string; warehouseLabel: string }): string[] {
  return [
    "────────────────────────────────────────",
    "Import inspect only.",
    "",
    "Existing YAML loaded and validated. No project YAML was edited and the active pin was not written. Live import writes .grane/audit.jsonl.",
    "Run `grane setup` from a terminal to activate.",
    "",
    `  Engine   ${opts.warehouseLabel}`,
    `Project  ${opts.projectDir}`,
  ];
}

export function importReadyLines(opts: {
  projectDir: string;
  pinRef: string;
  pinCommit: string;
  warehouseLabel: string;
}): string[] {
  return [
    "────────────────────────────────────────",
    "You're ready.",
    "",
    "Existing YAML loaded, validated, and activated. No project YAML was edited. Live import writes .grane/audit.jsonl.",
    "",
    `  Pin      ${opts.pinRef} @ ${opts.pinCommit.slice(0, 7)}`,
    `  Engine   ${opts.warehouseLabel}`,
    "",
    "Ask your agent:",
    "",
    `  ${OWN_QUESTION}`,
    "",
    `Project  ${opts.projectDir}`,
  ];
}

export const SETUP_BANNER = [
  "Grane setup",
  "",
  "One path from a fresh clone to a question you can ask an agent.",
  "Nothing is sent to a Grane cloud — this stays on your machine.",
  "Type back (or b) at any later prompt to return to the previous step.",
].join("\n");

export function demoReadyLines(opts: { projectDir: string; clientLabel: string | null }): string[] {
  const lines = [
    "────────────────────────────────────────",
    "You're ready.",
    "",
    "Ask your agent this question:",
    "",
    `  ${DEMO_QUESTION}`,
    "",
    "The agent should catalog governed metrics, find Germany, then investigate",
    "permitted raw payments.failure_code (trust: mixed). It must not write SQL.",
  ];
  if (opts.clientLabel) {
    lines.push("");
    lines.push(`Reload ${opts.clientLabel} so it picks up Grane, then start a new chat.`);
  }
  lines.push("");
  lines.push(`Project  ${opts.projectDir}`);
  return lines;
}

export function ownReadyLines(opts: {
  projectDir: string;
  clientLabel: string | null;
  live: boolean;
}): string[] {
  const lines = [
    "────────────────────────────────────────",
    "You're ready.",
    "",
    opts.live
      ? "The warehouse answered. No governed metrics yet — that is expected."
      : "Project files are written. Live schema checks were skipped (--offline).",
    "",
    "Next:",
    "  1. grane discover --write-relationships",
    "  2. Add about five metrics in metrics.yml (comments show a starter set)",
    "  3. grane validate",
    "",
    "Ask your agent:",
    "",
    `  ${OWN_QUESTION}`,
  ];
  if (opts.clientLabel) {
    lines.push("");
    lines.push(`Reload ${opts.clientLabel} so it picks up Grane, then start a new chat.`);
  }
  lines.push("");
  lines.push(`Project  ${opts.projectDir}`);
  lines.push("Docs     https://github.com/Nareik33L/grane/blob/main/docs/first-week.md");
  return lines;
}

export function skipConnectHint(projectDir: string): string[] {
  return [
    "Skipped MCP registration.",
    `  grane -p ${projectDir} mcp connect cursor`,
    `  grane -p ${projectDir} mcp doctor`,
  ];
}
