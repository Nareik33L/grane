import { CORE_MCP_TOOLS } from "../authoring.js";
import { SETUP_GRANE_PROMPT_TITLE } from "../prompts/setup-grane.js";

/**
 * Human-facing core tool list. Same names as `CORE_MCP_TOOLS` / doctor
 * `EXPECTED_TOOLS`, in the order we tell people to try them.
 */
export const CORE_MCP_TOOLS_DISPLAY = ["catalog", "query", "validate", "explain"] as const;

export function coreToolsPhrase(): string {
  return CORE_MCP_TOOLS_DISPLAY.join(", ");
}

export function numbered(steps: string[]): string[] {
  return steps.map((step, i) => `${i + 1}. ${step}`);
}

export function withConfigStep(steps: string[], configPath: string | null): string[] {
  return numbered(configPath ? [...steps, `Config file: ${configPath}`] : steps);
}

/**
 * Default serve is four tools and no prompts. `--authoring` in the client
 * config args enables them for this process. On stdio, `authoring.enabled`
 * also advertises all nine tools. HTTP needs `auth.agents`.
 */
export const AUTHORING_SWITCH_STEPS = [
  "To enable authoring for this process, put `--authoring` in the client config args (`serve --stdio --authoring`).",
  "`authoring.enabled: true` in grane.yml advertises all 9 authoring tools on stdio. HTTP also needs `authoring.mode: shared` and `auth.agents`.",
] as const;

export const AUTHORING_PROPOSE_STEP =
  `If authoring is on, open the “${SETUP_GRANE_PROMPT_TITLE}” prompt. Authoring tools only propose a GitHub PR. Nothing is live until a human merges and pins.`;

export const AUTHORING_CONNECT_STEPS = [...AUTHORING_SWITCH_STEPS, AUTHORING_PROPOSE_STEP];

export function reloadAndChatSteps(app: string): string[] {
  return [
    `Reload ${app}.`,
    "Start a new chat.",
    `Use ${coreToolsPhrase()}.`,
  ];
}

/** Same four names the server registers without authoring. */
export function coreToolsMatchServer(): boolean {
  const a = [...CORE_MCP_TOOLS].sort();
  const b = [...CORE_MCP_TOOLS_DISPLAY].sort();
  return a.length === b.length && a.every((name, i) => name === b[i]);
}
