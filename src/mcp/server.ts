import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { GraneKernel } from "../kernel.js";
import { semanticQuerySchema } from "../query/model.js";
import { GraneError } from "../errors.js";

/**
 * The Grane MCP surface. Deliberately small and difficult to misuse:
 *
 *   catalog()  discover metrics, dimensions, entities and server capabilities
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
  const server = new McpServer(
    { name: info.name, version: info.version },
    {
      instructions:
        "Grane is a deterministic semantic analytics layer. Use catalog() to discover approved " +
        "metrics and dimensions, then query() with a Grane Query Model v1 request. Grane compiles " +
        "the SQL itself; never write SQL. Results marked trust: governed carry Grane's trust " +
        "contract and full provenance. If Grane refuses a request (e.g. undefined_metric), report " +
        "that the metric is not defined rather than inventing a definition.",
    },
  );

  server.registerTool(
    "catalog",
    {
      title: "Browse the semantic catalog",
      description:
        "List the approved metrics, dimensions and entities in the Grane semantic model, with " +
        "definitions, synonyms, units, available dimensions per metric, and server capabilities. " +
        "Optionally filter by a search term (matches names, synonyms and descriptions).",
      inputSchema: {
        search: z.string().optional().describe("Optional search term, e.g. 'revenue'"),
      },
    },
    async ({ search }) => {
      try {
        return ok(kernel.catalog(search));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  const querySchemaDescription =
    "A Grane Query Model v1 request: { metrics: string[], dimensions?: string[], " +
    "filters?: [{field, operator, value}], time?: {from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', " +
    "grain?: day|week|month|quarter|year, dimension?}, order?: [{field, direction}], limit?: number }";

  server.registerTool(
    "validate",
    {
      title: "Validate a semantic query (dry run)",
      description:
        "Check a proposed Grane Query Model v1 request without executing it. Returns the resolved " +
        "definitions and generated SQL if the query is valid and analytically safe, or a " +
        "structured refusal explaining why it is not.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const explained = kernel.explain(query);
        return ok({ valid: true, ...explained });
      } catch (err) {
        return refuse(err);
      }
    },
  );

  server.registerTool(
    "query",
    {
      title: "Run a governed analytical query",
      description:
        "Execute a Grane Query Model v1 request. Grane resolves metric/dimension names " +
        "(including synonyms), validates safety, compiles deterministic SQL, executes it " +
        "read-only against the connected database and returns rows plus full provenance " +
        "(query_id, definition versions, generated SQL). This is the primary analytical interface.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        const result = await kernel.query(query);
        return ok({
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
        "Show how Grane would answer a Query Model v1 request without executing it: the metric " +
        "definitions and versions used, the join plan, and the exact SQL that would run.",
      inputSchema: { query: semanticQuerySchema.describe(querySchemaDescription) },
    },
    async ({ query }) => {
      try {
        return ok(kernel.explain(query));
      } catch (err) {
        return refuse(err);
      }
    },
  );

  return server;
}
