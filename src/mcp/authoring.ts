import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraneKernel } from "../kernel.js";
import type { GraneConfig } from "../config/schema.js";
import { GraneError, configError } from "../errors.js";
import {
  authoringStart,
  discoverSchema,
  listAmbiguities,
  previewYaml,
  profileColumn,
  proposeDefinitions,
  recordTerm,
  resolveAmbiguity,
  submitProposal,
} from "../authoring/tools.js";
export type McpTransport = "stdio" | "http";

export interface BuildMcpServerOptions {
  /** CLI `grane serve --authoring`. */
  authoring?: boolean;
  transport?: McpTransport;
}

export const CORE_MCP_TOOLS = ["catalog", "explain", "query", "validate"] as const;

export const AUTHORING_MCP_TOOLS = [
  "authoring_start",
  "discover_schema",
  "profile_column",
  "record_term",
  "list_ambiguities",
  "resolve_ambiguity",
  "propose_definitions",
  "preview_yaml",
  "submit_proposal",
] as const;

/**
 * Whether to advertise authoring tools.
 * `--authoring` enables them on this process/transport.
 * `authoring.enabled` still honours `authoring.mode`: local = stdio only,
 * shared = stdio and HTTP.
 */
export function authoringToolsEnabled(config: GraneConfig, options?: BuildMcpServerOptions): boolean {
  const transport = options?.transport ?? "stdio";
  if (options?.authoring) return true;
  if (!config.authoring.enabled) return false;
  if (transport === "stdio") return true;
  return config.authoring.mode === "shared";
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function refuse(err: unknown): ToolResult {
  if (err instanceof GraneError) {
    return {
      content: [{ type: "text", text: JSON.stringify(err.refusal, null, 2) }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
    isError: true,
  };
}

function requireHttpAgent(kernel: GraneKernel, transport: McpTransport): void {
  if (transport !== "http") return;
  if (kernel.agent && kernel.agent.id !== "anonymous") return;
  throw configError("Authoring MCP tools on HTTP require an authenticated agent.");
}

function wrap(
  kernel: GraneKernel,
  transport: McpTransport,
  work: () => unknown | Promise<unknown>,
): () => Promise<ToolResult> {
  return async () => {
    try {
      requireHttpAgent(kernel, transport);
      return ok(await work());
    } catch (err) {
      return refuse(err);
    }
  };
}

/**
 * Register V2 authoring tools. Discovery goes only through `createDiscovery`
 * (no SQL arguments). Draft YAML is never loaded into `query()`.
 */
export function registerAuthoringTools(
  server: McpServer,
  kernel: GraneKernel,
  options: BuildMcpServerOptions,
): void {
  const transport = options.transport ?? "stdio";

  server.registerTool(
    "authoring_start",
    {
      title: "Start an authoring session",
      description:
        "Create a local authoring session document under .grane/authoring. " +
        "Does not write production YAML or pins. Returns a session id.",
      inputSchema: {},
    },
    wrap(kernel, transport, () => authoringStart(kernel)),
  );

  server.registerTool(
    "discover_schema",
    {
      title: "Discover warehouse schema",
      description:
        "Introspect tables, columns, and inferred relationships through Grane's read-only discovery service. " +
        "Does not accept SQL. Sample values are never returned from this tool.",
      inputSchema: {
        session_id: z.string().describe("Authoring session id from authoring_start"),
      },
    },
    async ({ session_id }) => wrap(kernel, transport, () => discoverSchema(kernel, session_id))(),
  );

  server.registerTool(
    "profile_column",
    {
      title: "Profile one warehouse column",
      description:
        "Bounded distinct-count and optional samples for one table.column via read-only discovery. " +
        "Samples are returned to the caller only and are never persisted. Honours authoring.sampling and exploration excludes.",
      inputSchema: {
        session_id: z.string().describe("Authoring session id from authoring_start"),
        table: z.string().describe("Table name"),
        column: z.string().describe("Column name"),
      },
    },
    async ({ session_id, table, column }) =>
      wrap(kernel, transport, async () => {
        const { profile } = await profileColumn(kernel, session_id, table, column);
        return profile;
      })(),
  );

  server.registerTool(
    "record_term",
    {
      title: "Record a glossary term",
      description: "Store a business term and its definition on the authoring session.",
      inputSchema: {
        session_id: z.string(),
        term: z.string(),
        answer: z.string(),
      },
    },
    async ({ session_id, term, answer }) =>
      wrap(kernel, transport, () => recordTerm(kernel, session_id, term, answer))(),
  );

  server.registerTool(
    "list_ambiguities",
    {
      title: "List open authoring ambiguities",
      description: "Return unresolved questions for this authoring session.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => wrap(kernel, transport, () => listAmbiguities(kernel, session_id))(),
  );

  server.registerTool(
    "resolve_ambiguity",
    {
      title: "Resolve an authoring ambiguity",
      description: "Choose a candidate for an open ambiguity (for example which column is revenue).",
      inputSchema: {
        session_id: z.string(),
        id: z.string().describe("Ambiguity id from list_ambiguities"),
        chosen: z.string().describe("Chosen candidate, usually table.column"),
      },
    },
    async ({ session_id, id, chosen }) =>
      wrap(kernel, transport, () => resolveAmbiguity(kernel, session_id, id, chosen))(),
  );

  server.registerTool(
    "propose_definitions",
    {
      title: "Propose experimental YAML definitions",
      description:
        "Build draft entities/metrics YAML from glossary answers and resolved ambiguities. " +
        "Drafts stay on the session (status: experimental). They are not loaded into query().",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => wrap(kernel, transport, () => proposeDefinitions(kernel, session_id))(),
  );

  server.registerTool(
    "preview_yaml",
    {
      title: "Preview draft YAML",
      description:
        "Return draft YAML and a structural validation report. Does not execute warehouse queries and does not write production files.",
      inputSchema: { session_id: z.string() },
    },
    async ({ session_id }) => wrap(kernel, transport, () => previewYaml(kernel, session_id))(),
  );

  server.registerTool(
    "submit_proposal",
    {
      title: "Submit a git proposal",
      description:
        "Commit draft YAML onto a grane/proposal/* branch and return a GitHub PR plan. " +
        "Never writes production config, never pins .grane/active.json, never moves HEAD.",
      inputSchema: {
        session_id: z.string(),
        slug: z.string().optional().describe("Optional proposal slug"),
      },
    },
    async ({ session_id, slug }) => wrap(kernel, transport, () => submitProposal(kernel, session_id, slug))(),
  );
}
