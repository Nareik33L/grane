import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export const SETUP_GRANE_PROMPT_NAME = "setup_grane";
export const SETUP_GRANE_PROMPT_TITLE = "Set up Grane";
export const SETUP_GRANE_PROMPT_DESCRIPTION =
  "Guided, plain-English setup: discover the warehouse, agree on terms, preview a draft, and open a pull request. Never writes production config or pins.";

export const AUTHORING_MCP_PROMPTS = [SETUP_GRANE_PROMPT_NAME] as const;

/**
 * User-role script the MCP client injects. Drives V2-08 authoring tools only.
 * Keep this text in lockstep with tests/fixtures/setup-grane.prompt.txt.
 */
export const SETUP_GRANE_SCRIPT = `You are helping a non-technical teammate set up Grane — a way to agree on business numbers (like revenue) so everyone, including AI, uses the same definition.

Talk in everyday language. Do not invent a definition. If something is unclear, ask.

Use only these nine Grane authoring tools, in this order: authoring_start, discover_schema, profile_column, record_term, list_ambiguities, resolve_ambiguity, propose_definitions, preview_yaml, submit_proposal. Do not call any other Grane tool. Do not write warehouse statements. Do not write project files, YAML, or git commands yourself.

1. Start a session with authoring_start. Remember the session id it returns.

2. Look around the warehouse with discover_schema. Summarize the tables in plain English (for example: "orders look like purchases; customers look like people who buy"). Speak in names and types, never warehouse statements.

3. If a column is still confusing, you may call profile_column. Do not echo or repeat sample values to the user. Summarise only shape, types, and counts (for example: "mostly whole numbers, about twelve distinct values, few blanks"). Never paste samples into the chat, into files, or into the draft.

4. Ask what words they use at work (revenue, active customer, and so on). Save each answer with record_term.

5. Call list_ambiguities and walk through each question. When they choose, call resolve_ambiguity with that choice. Never guess.

6. Call propose_definitions to build a draft. Read it back in plain English. Say clearly that these are AI-made metrics and they stay experimental — not approved business numbers — until a pull request is merged.

7. Call preview_yaml to show the draft. This is a preview only. Do not write it to metrics.yml, grane.yml, or any other production file.

8. If they want to keep it, call submit_proposal. That is the only way to save the draft: it opens a GitHub pull request on a proposal branch. Do not pin .grane/active.json. Do not merge the pull request. Do not change production config.

After submit_proposal, tell them: a teammate with merge rights should review the pull request. Until it merges, the new metrics stay experimental and must not be treated as approved truth. After it merges, they become governed.

If a tool refuses, explain what happened in plain language and stop rather than working around it.
`;

export function setupGranePromptResult(): {
  description: string;
  messages: { role: "user"; content: { type: "text"; text: string } }[];
} {
  return {
    description: SETUP_GRANE_PROMPT_DESCRIPTION,
    messages: [{ role: "user", content: { type: "text", text: SETUP_GRANE_SCRIPT } }],
  };
}

export function registerAuthoringPrompts(server: McpServer): void {
  server.registerPrompt(
    SETUP_GRANE_PROMPT_NAME,
    {
      title: SETUP_GRANE_PROMPT_TITLE,
      description: SETUP_GRANE_PROMPT_DESCRIPTION,
    },
    () => setupGranePromptResult(),
  );
}
