import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraneKernel } from "../kernel.js";
import { semanticQuerySchema, type TrustLevel } from "../query/model.js";
import { GraneError } from "../errors.js";
import { mcpTrustText } from "../query/trust.js";

/**
 * The Grane MCP surface. Deliberately small and difficult to misuse:
 *
 *   catalog()  discover metrics, dimensions, entities, explorable columns
 *   validate() dry-run a semantic query without executing it
 *   query()    resolve -> validate -> compile -> execute -> provenance
 *   explain()  inspect definitions, join plan and generated SQL
 */

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
}

function okTrust(payload: { trust: TrustLevel; [key: string]: unknown }): ToolResult {
  return { content: [{ type: "text", text: mcpTrustText(payload) }] };
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

export function buildMcpServer(kernel: GraneKernel): McpServer {
  const info = kernel.serverInfo();
  const explorationHint = kernel.config.exploration.enabled
    ? " Exploration is enabled: catalog() also lists permitted raw warehouse columns. " +
      "You may pass raw_dimensions (table.column) or raw_metrics to investigate fields that are not governed. " +
      "trust: governed means every field is an approved definition; trust: mixed combines approved metrics with raw fields " +
      "and must be presented as a lead, not approved business truth; trust: exploratory is raw warehouse data only."
    : " Exploration is disabled: only governed metrics and dimensions may be queried.";

  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      instructions:
        "Grane is a deterministic analytics harness. Use catalog() to discover approved " +
        "metrics and dimensions, then query() with a Grane Query Model v1 request. Grane compiles " +
        "the SQL itself; never write SQL. For relative windows send time.period (last_month, 30d) " +
        "instead of computing from/to dates." +
        explorationHint +
        " If Grane refuses a request (e.g. undefined_metric), report that rather than inventing a definition. " +
        "When you present query results, the first sentence of your reply must be the trust headline. " +
        "Put that same headline in any chart title. Never present mixed or exploratory numbers as approved business truth.",
    },
  );

  server.registerTool(
    "catalog",
    {
      title: "Browse the semantic catalog",
      description:
        "List approved metrics, dimensions and entities in the Grane semantic model, with " +
        "definitions, synonyms, units, available dimensions per metric, and server capabilities. " +
        "`warnings` lists upstream definitions (dbt, Cube, LookML, …) that Grane could not import; " +
        "if a user asks for one of those, say it exists upstream but Grane does not compile it. " +
        "When exploration is enabled, also lists permitted ungoverned warehouse columns. " +
        "Optionally filter by a search term (matches names, synonyms, descriptions and raw columns).",
      inputSchema: {
        search: z.string().optional().describe("Optional search term, e.g. 'revenue'"),
      },
    },
    async ({ search }) => {
      try {
        return ok(await kernel.catalog(search));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  const querySchemaDescription =
    "A Grane Query Model v1 request: { metrics?: string[], dimensions?: string[], " +
    "raw_dimensions?: string[] (table.column), raw_metrics?: [{field: 'table.column', type, alias?}], " +
    "filters?: [{field, operator, value}], time?: {period: 'last_month'|'30d'|…, grain?, dimension?} " +
    "or {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', grain?, dimension?}, " +
    "order?: [{field, direction}], limit?: number }. " +
    "Provide at least one governed metric or one raw_metric. Prefer time.period over computing dates.";

  server.registerTool(
    "validate",
    {
      title: "Validate a semantic query (dry run)",
      description:
        "Check a proposed Grane Query Model v1 request without executing it. Returns the resolved " +
        "definitions, trust headline, and generated SQL if the query is valid and analytically safe, or a " +
        "structured refusal explaining why it is not. Lead any summary with the trust headline.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const explained = await kernel.explain(query);
        return okTrust({ valid: true, ...explained });
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: "Run a governed or exploratory analytical query",
      description:
        "Execute a Grane Query Model v1 request. Grane resolves names, validates safety, compiles " +
        "deterministic SQL, executes it read-only and returns a trust headline, then rows plus provenance. " +
        "Use raw_dimensions / raw_metrics for permitted warehouse columns that are not in the semantic model. " +
        "The first sentence of your reply to the user must be the trust headline. Put it in any chart title too.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const result = await kernel.query(query);
        return okTrust({
          trust: result.trust,
          governed: result.governed,
          ungoverned: result.ungoverned,
          warning: result.warning,
          columns: result.columns,
          rows: result.rows,
          notes: result.notes,
          provenance: result.provenance,
        });
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "explain",
    {
      title: "Explain a semantic query",
      description:
        "Show how Grane would answer a Query Model v1 request without executing it: the trust headline, " +
        "metric definitions and versions, the join plan, and the exact SQL that would run. " +
        "Lead any summary with the trust headline.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        return okTrust({ ...(await kernel.explain(query)) });
      } catch (err) {
        return refuse(err);
      }
    },
  );

  return server;
}
