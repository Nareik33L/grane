import { DEMO_QUESTION } from "../demo/run.js";
import { AUTHORING_SWITCH_STEPS, numbered } from "../mcp/connect/next-steps.js";
import { DEMO_AUTHORING_QUESTION } from "./demo-postgres.js";

function reloadChatAsk(clientLabel: string, question: string): string[] {
  return numbered([`Reload ${clientLabel}.`, "Start a new chat.", `Ask: ${question}`]);
}

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
    lines.push("Next:");
    for (const step of reloadChatAsk(opts.clientLabel, DEMO_QUESTION)) lines.push(`  ${step}`);
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
  ];
  const steps = [
    "grane discover --write-relationships",
    "Add about five metrics in metrics.yml (comments show a starter set)",
    "grane validate",
    ...(opts.clientLabel ? [`Reload ${opts.clientLabel}.`, "Start a new chat."] : []),
    `Ask: ${OWN_QUESTION}`,
  ];
  for (const step of numbered(steps)) lines.push(`  ${step}`);
  lines.push("");
  lines.push(`Project  ${opts.projectDir}`);
  lines.push("Docs     https://github.com/Nareik33L/grane/blob/main/docs/first-week.md");
  return lines;
}

export function demoAuthoringReadyLines(opts: {
  projectDir: string;
  clientLabel: string | null;
}): string[] {
  const lines = [
    "────────────────────────────────────────",
    "You're ready.",
    "",
    "Demo Postgres is connected. No production YAML or pin was written.",
    "",
    "Next:",
  ];
  const steps = [
    ...(opts.clientLabel ? [`Reload ${opts.clientLabel}.`, "Start a new chat."] : []),
    `Open the Set up Grane prompt. Ask: ${DEMO_AUTHORING_QUESTION}`,
    ...AUTHORING_SWITCH_STEPS,
    "Authoring tools only propose a GitHub PR. Nothing is live until a human merges and pins.",
  ];
  for (const step of numbered(steps)) lines.push(`  ${step}`);
  lines.push("");
  lines.push(`Project  ${opts.projectDir}`);
  return lines;
}

export function skipConnectHint(projectDir: string): string[] {
  return [
    "Skipped MCP registration.",
    ...numbered([
      `grane -p ${projectDir} mcp connect cursor`,
      "Reload Cursor and start a new chat.",
      `Optional: grane -p ${projectDir} mcp doctor`,
    ]),
  ];
}
