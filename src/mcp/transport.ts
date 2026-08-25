import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GraneKernel } from "../kernel.js";
import { buildMcpServer } from "./server.js";

/** Serve MCP over stdio (for local agents like Cursor or Claude Desktop). */
export async function serveStdio(kernel: GraneKernel): Promise<void> {
  const server = buildMcpServer(kernel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/**
 * Serve MCP over streamable HTTP at /mcp (stateless mode: a fresh server and
 * transport per request, no session state).
 */
export async function serveHttp(kernel: GraneKernel, port: number): Promise<void> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ...kernel.serverInfo() }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Not found. The MCP endpoint is /mcp." }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(405, { "content-type": "application/json", allow: "POST" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. Grane serves stateless MCP over POST." },
          id: null,
        }),
      );
      return;
    }

    try {
      const body = await readJsonBody(req);
      const server = buildMcpServer(kernel);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: (err as Error).message },
            id: null,
          }),
        );
      }
    }
  });

  await new Promise<void>((resolve) => httpServer.listen(port, resolve));
}
