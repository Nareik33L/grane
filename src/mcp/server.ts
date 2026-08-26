import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraneKernel } from "../kernel.js";
import { semanticQuerySchema } from "../query/model.js";
import { GraneError } from "../errors.js";

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
        "the SQL itself; never write SQL." +
        explorationHint +
        " If Grane refuses a request (e.g. undefined_metric), report that rather than inventing a definition.",
    },
  );

  server.registerTool(
    "catalog",
    {
      title: "Browse the semantic catalog",
      description:
        "List approved metrics, dimensions and entities in the Grane semantic model, with " +
        "definitions, synonyms, units, available dimensions per metric, and server capabilities. " +
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
    "filters?: [{field, operator, value}], time?: {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', " +
    "grain?: day|week|month|quarter|year, dimension?}, order?: [{field, direction}], limit?: number }. " +
    "Provide at least one governed metric or one raw_metric.";

  server.registerTool(
    "validate",
    {
      title: "Validate a semantic query (dry run)",
      description:
        "Check a proposed Grane Query Model v1 request without executing it. Returns the resolved " +
        "definitions, trust level and generated SQL if the query is valid and analytically safe, or a " +
        "structured refusal explaining why it is not.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const explained = await kernel.explain(query);
        return ok({ valid: true, ...explained });
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
        "deterministic SQL, executes it read-only and returns rows plus provenance. " +
        "Use raw_dimensions / raw_metrics for permitted warehouse columns that are not in the semantic model. " +
        "Inspect trust (governed | mixed | exploratory) before presenting conclusions.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const result = await kernel.query(query);
        return ok({
          columns: result.columns,
          rows: result.rows,
          notes: result.notes,
          trust: result.trust,
          governed: result.governed,
          ungoverned: result.ungoverned,
          warning: result.warning,
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
        "Show how Grane would answer a Query Model v1 request without executing it: the metric " +
        "definitions and versions used, the trust level, the join plan, and the exact SQL that would run.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        return ok(await kernel.explain(query));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  return server;
}
