import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraneKernel } from "../kernel.js";
import type { GraneConfig } from "../config/schema.js";
import { GraneError, configError } from "../errors.js";
import { httpAgentAuthenticated } from "../auth/agents.js";
import { recordAuthoringAudit, refusalFromError, type AuthoringAuditOperation } from "../audit.js";
import type { GitHubPrPlan, Proposal } from "../authoring/git.js";
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

export type AuthoringMcpTool = (typeof AUTHORING_MCP_TOOLS)[number];

/**
 * Whether authoring tools are enabled for this process/transport.
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

/**
 * Whether to put authoring tools on `tools/list` for this caller.
 * HTTP filters per bound grant: anonymous callers never see them.
 */
export function advertiseAuthoringTools(kernel: GraneKernel, options?: BuildMcpServerOptions): boolean {
  if (!authoringToolsEnabled(kernel.config, options)) return false;
  const transport = options?.transport ?? "stdio";
  if (transport !== "http") return true;
  return httpAgentAuthenticated(kernel.agent);
}

/**
 * HTTP authoring requires configured `auth.agents`. Call before serving.
 */
export function assertHttpAuthoringAgents(config: GraneConfig, options?: BuildMcpServerOptions): void {
  if (!authoringToolsEnabled(config, { ...options, transport: "http" })) return;
  if (config.auth.agents.length > 0) return;
  throw configError(
    "HTTP authoring MCP requires auth.agents (at least one agent token). " +
      "Configure auth.agents, or serve authoring locally with grane serve --stdio --authoring.",
  );
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
  if (httpAgentAuthenticated(kernel.agent)) return;
  throw configError("Authoring MCP tools on HTTP require an authenticated agent.");
}

function sessionIdOf(args: unknown, payload: unknown): string | null {
  if (args && typeof args === "object") {
    const id = (args as { session_id?: unknown }).session_id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  if (payload && typeof payload === "object") {
    const rec = payload as { session_id?: unknown; session?: { id?: unknown } };
    if (typeof rec.session_id === "string") return rec.session_id;
    if (typeof rec.session?.id === "string") return rec.session.id;
  }
  return null;
}

function proposalAuditFields(payload: unknown): { commit: string; branch: string; pr: string } | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const proposal = (payload as { proposal?: Proposal }).proposal;
  const github = (payload as { github?: GitHubPrPlan }).github;
  if (!proposal?.commit || !proposal.branch) return undefined;
  const pr = github?.repo ? `${github.repo}#${github.head}` : (github?.head ?? proposal.branch);
  return { commit: proposal.commit, branch: proposal.branch, pr };
}

function wrap<A>(
  kernel: GraneKernel,
  transport: McpTransport,
  tool: AuthoringMcpTool,
  work: (args: A) => unknown | Promise<unknown>,
): (args: A) => Promise<ToolResult> {
  return async (args: A) => {
    const started = Date.now();
    let payload: unknown;
    let err: unknown;
    try {
      requireHttpAgent(kernel, transport);
      payload = await work(args);
    } catch (caught) {
      err = caught;
    }
    const success = err === undefined;
    const proposal = success && tool === "submit_proposal" ? proposalAuditFields(payload) : undefined;
    const operation: AuthoringAuditOperation =
      success && tool === "submit_proposal" && proposal ? "proposal_created" : tool;
    try {
      recordAuthoringAudit(kernel.config, kernel.projectDir, {
        operation,
        session_id: sessionIdOf(args, payload),
        agent: kernel.agent?.id ?? null,
        duration_ms: Date.now() - started,
        ...(success ? {} : { refusal: refusalFromError(err) }),
        ...(proposal ?? {}),
        http: kernel.http,
      });
    } catch (auditErr) {
      return refuse(auditErr);
    }
    if (err !== undefined) return refuse(err);
    return ok(payload);
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
    wrap(kernel, transport, "authoring_start", () => authoringStart(kernel)),
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
    wrap(kernel, transport, "discover_schema", ({ session_id }) => discoverSchema(kernel, session_id)),
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
    wrap(kernel, transport, "profile_column", async ({ session_id, table, column }) => {
      const { profile } = await profileColumn(kernel, session_id, table, column);
      return profile;
    }),
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
    wrap(kernel, transport, "record_term", ({ session_id, term, answer }) =>
      recordTerm(kernel, session_id, term, answer),
    ),
  );

  server.registerTool(
    "list_ambiguities",
    {
      title: "List open authoring ambiguities",
      description: "Return unresolved questions for this authoring session.",
      inputSchema: { session_id: z.string() },
    },
    wrap(kernel, transport, "list_ambiguities", ({ session_id }) => listAmbiguities(kernel, session_id)),
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
    wrap(kernel, transport, "resolve_ambiguity", ({ session_id, id, chosen }) =>
      resolveAmbiguity(kernel, session_id, id, chosen),
    ),
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
    wrap(kernel, transport, "propose_definitions", ({ session_id }) => proposeDefinitions(kernel, session_id)),
  );

  server.registerTool(
    "preview_yaml",
    {
      title: "Preview draft YAML",
      description:
        "Return draft YAML and a structural validation report. Does not execute warehouse queries and does not write production files.",
      inputSchema: { session_id: z.string() },
    },
    wrap(kernel, transport, "preview_yaml", ({ session_id }) => previewYaml(kernel, session_id)),
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
    wrap(kernel, transport, "submit_proposal", ({ session_id, slug }) => submitProposal(kernel, session_id, slug)),
  );
}
