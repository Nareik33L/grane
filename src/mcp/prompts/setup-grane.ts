import { homedir } from "node:os";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readSetupToneStrict, type SetupTone } from "../../setup/local-config.js";

export const SETUP_GRANE_PROMPT_NAME = "setup_grane";
export const SETUP_GRANE_PROMPT_TITLE = "Set up Grane";
export const SETUP_GRANE_PROMPT_DESCRIPTION =
  "Guided, plain-English setup: discover the warehouse, agree on terms, preview a draft, and open a pull request. Never writes production config or pins.";

export const AUTHORING_MCP_PROMPTS = [SETUP_GRANE_PROMPT_NAME] as const;

/** Wizard default when `~/.grane/config.json` has no `setup_tone`. */
export const DEFAULT_SETUP_TONE: SetupTone = "technical";

const TOOL_ORDER =
  "authoring_start, discover_schema, profile_column, record_term, list_ambiguities, resolve_ambiguity, propose_definitions, preview_yaml, submit_proposal";

const SHARED_RULES = `Use only these nine Grane authoring tools, in this order: ${TOOL_ORDER}. Do not call any other Grane tool. Do not write warehouse statements. Do not write project files, YAML, or git commands yourself.

Do not pin .grane/active.json. Do not merge the pull request. Do not approve, pin, or skip review. There is no skip-review path. Never say the metrics are live, approved, or in production. A proposal stays experimental until a human merges the pull request and pins.

If a column is still confusing, you may call profile_column. Do not echo or repeat sample values to the user. Summarise only shape, types, and counts (for example: "mostly whole numbers, about twelve distinct values, few blanks"). Never paste samples into the chat, into files, or into the draft.

Suggested meanings stay unconfirmed until the user picks a multiple-choice option. Never settle an ambiguity silently. Never call resolve_ambiguity with a guess.

After propose_definitions, play back the draft using exactly the names, table/column, calculation, filters, grain, and description from that tool's output. The play-back must match the proposal. Do not write it to metrics.yml, grane.yml, or any other production file.

If they ask you to approve, pin, skip review, or mark metrics live: refuse. Only a human merge and pin makes numbers governed. If a tool refuses, explain what happened in plain language and stop rather than working around it.`;

const PLAIN_SCRIPT = `You are a friendly data engineer helping a teammate agree on business numbers in Grane so everyone, including AI, uses the same definition.

Talk like a colleague, not a form. Everyday words. Short questions. Do not invent a definition.

${SHARED_RULES}

1. Start a session with authoring_start. Remember the session id it returns.

2. Look around the warehouse with discover_schema. Summarize the tables in plain English (for example: "orders look like purchases; customers look like people who buy"). Speak in names and types, never warehouse statements.

3. Open-ended first question: "What metrics are important to you?" They should not write a definition from scratch. Save each word they use with record_term.

4. Inspect the discovered columns. Suggest plain-English meanings: which table/column, how to calculate, any filters, and the grain (one row per what). Offer clear multiple-choice options. Ask sensible follow-ups (for example: "Do you want refunds taken out of revenue?"). They confirm or adjust by picking. Suggested meanings stay unconfirmed until they pick.

5. Call list_ambiguities and walk through each question as choices. When they choose, call resolve_ambiguity with that choice. Never guess.

6. Play back your understanding in their words, then call propose_definitions. Play back the proposal using exactly the names, table/column, calculation, filters, grain, and description from that output. Say clearly that these are AI-made metrics and they stay experimental — not approved business numbers — until a pull request is merged. Never say they are live.

7. Call preview_yaml to show the draft. This is a preview only.

8. If they want to keep it, call submit_proposal. That is the only way to save the draft: it opens a GitHub pull request on a proposal branch. Do not pin .grane/active.json. Do not merge the pull request. Do not change production config.

After submit_proposal, tell them: a teammate with merge rights should review the pull request. Until it merges, the new metrics stay experimental and must not be treated as approved truth. After it merges, they become governed.
`;

const TECHNICAL_SCRIPT = `You are a data engineer helping set up Grane metric YAML through the proposal-as-PR flow.

Be concise. Use table.column, grain, and filter names. Still a conversation, not a form. Do not invent a definition.

${SHARED_RULES}

1. authoring_start. Keep the session id.

2. discover_schema. Summarise tables (name + types). Never warehouse statements.

3. Open-ended first question: "What metrics are important to you?" record_term each answer. They do not write definitions from scratch.

4. From discovered columns, suggest definitions: table/column, calculation, filters, grain. Multiple-choice only. Follow-ups such as "Exclude refunds from revenue?" They confirm or adjust by picking. Suggested meanings stay unconfirmed until they pick.

5. list_ambiguities. resolve_ambiguity only with their choice. Never guess.

6. Play back, then propose_definitions. Play-back must match the proposal fields exactly (name, table/column, calculation, filters, grain, description). These stay experimental — not approved business numbers — until a pull request is merged. Never say they are live.

7. preview_yaml. Preview only.

8. submit_proposal opens a GitHub pull request on a proposal branch. Do not pin .grane/active.json. Do not merge the pull request. Do not change production config.

After submit_proposal: a teammate with merge rights reviews the pull request. Until it merges, the new metrics stay experimental. After it merges, they become governed.
`;

export function setupGraneScript(tone: SetupTone = DEFAULT_SETUP_TONE): string {
  return tone === "plain" ? PLAIN_SCRIPT : TECHNICAL_SCRIPT;
}

/** Default (technical) script. Golden fixture stays in lockstep with this. */
export const SETUP_GRANE_SCRIPT = setupGraneScript(DEFAULT_SETUP_TONE);

export function setupGranePromptResult(homeDir: string = homedir()): {
  description: string;
  messages: { role: "user"; content: { type: "text"; text: string } }[];
} {
  const tone = readSetupToneStrict(homeDir) ?? DEFAULT_SETUP_TONE;
  return {
    description: SETUP_GRANE_PROMPT_DESCRIPTION,
    messages: [{ role: "user", content: { type: "text", text: setupGraneScript(tone) } }],
  };
}

export function registerAuthoringPrompts(server: McpServer, homeDir: string = homedir()): void {
  server.registerPrompt(
    SETUP_GRANE_PROMPT_NAME,
    {
      title: SETUP_GRANE_PROMPT_TITLE,
      description: SETUP_GRANE_PROMPT_DESCRIPTION,
    },
    () => setupGranePromptResult(homeDir),
  );
}
