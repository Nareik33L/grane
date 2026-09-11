import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GraneKernel } from "../kernel.js";
import { buildMcpServer } from "./server.js";
import { authenticateAgent, bearerTokenFromHeaders, httpAuthRequired } from "../auth/agents.js";
import { recordAudit } from "../audit.js";
import { anonymousHttpWarning, assertAnonymousHttpBind } from "./http-bind.js";

export interface HttpMcpHandle {
  port: number;
  host: string;
  close(): Promise<void>;
}

export interface ServeHttpOptions {
  /** Bind address. Default 127.0.0.1. */
  host?: string;
  /** Required to bind unauthenticated HTTP on a non-loopback address. */
  allowAnonymous?: boolean;
  onWarning?: (message: string) => void;
}

/** Serve MCP over stdio (for local agents like Cursor or Claude Desktop). */
export async function serveStdio(kernel: GraneKernel): Promise<void> {
  const server = buildMcpServer(kernel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function drainRequest(req: IncomingMessage): Promise<void> {
  try {
    for await (const _chunk of req) {
      /* discard so keep-alive clients can finish the request */
    }
  } catch {
    /* client hung up */
  }
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

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

/**
 * Serve MCP over streamable HTTP at /mcp (stateless mode: a fresh server and
 * transport per request, no session state). When `auth.agents` is configured,
 * `/mcp` requires `Authorization: Bearer <token>`. `/health` stays public.
 *
 * Default bind is loopback. Unauthenticated HTTP on a non-loopback address
 * requires `allowAnonymous`.
 */
export async function serveHttp(
  kernel: GraneKernel,
  port: number,
  options: ServeHttpOptions = {},
): Promise<HttpMcpHandle> {
  const host = options.host ?? "127.0.0.1";
  const allowAnonymous = Boolean(options.allowAnonymous);
  const hasAgents = httpAuthRequired(kernel.config);
  assertAnonymousHttpBind({ host, allowAnonymous, hasAgents });

  const requireAuth = hasAgents;
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      writeJson(res, 200, { status: "ok", ...kernel.serverInfo() });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }

    if (req.method !== "POST") {
      writeJson(
        res,
        405,
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. Grane serves stateless MCP over POST." },
          id: null,
        },
        { allow: "POST" },
      );
      return;
    }

    let bound = kernel;
    if (requireAuth) {
      const result = authenticateAgent(kernel.config, bearerTokenFromHeaders(req.headers));
      if (result === "missing" || result === "invalid") {
        recordAudit(kernel.config, kernel.projectDir, {
          ts: new Date().toISOString(),
          kind: "auth",
          operation: "http",
          agent: null,
          reason: result,
        });
        await drainRequest(req);
        writeJson(
          res,
          401,
          {
            error: "unauthorized",
            message: "Grane HTTP MCP requires a bearer token (Authorization: Bearer <agent token>).",
          },
          { "www-authenticate": 'Bearer realm="grane"' },
        );
        return;
      }
      bound = kernel.bindAgent(result);
    }

    try {
      const body = await readJsonBody(req);
      const server = buildMcpServer(bound);
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
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message },
        id: null,
      });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => resolve());
  });
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  if (!hasAgents) {
    const warn = options.onWarning ?? ((message) => console.error(message));
    warn(anonymousHttpWarning(host, actualPort));
  }
  return {
    port: actualPort,
    host,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
