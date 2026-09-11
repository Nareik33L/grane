import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { GraneKernel } from "../kernel.js";
import { buildMcpServer } from "./server.js";
import { recordAudit, httpFields } from "../audit.js";
import { authenticateAgent, bearerTokenFromHeaders, httpAuthRequired } from "../auth/agents.js";
import { anonymousHttpWarning, assertAnonymousHttpBind } from "./http-bind.js";
import { httpAuditContext } from "./http-audit.js";
import { connectionPoolSize } from "../connectors/types.js";
import {
  BodyLimitError,
  HTTP_MAX_BODY_BYTES,
  TokenBucket,
  defaultMaxConcurrency,
  readJsonBody,
} from "./http-limit.js";

export interface HttpMcpHandle {
  port: number;
  host: string;
  /** Stop accepting, drain in-flight `/mcp` requests, then close sockets. Does not close the kernel. */
  close(): Promise<void>;
}

export interface ServeHttpOptions {
  /** Bind address. Default 127.0.0.1. */
  host?: string;
  /** Required to bind unauthenticated HTTP on a non-loopback address. */
  allowAnonymous?: boolean;
  onWarning?: (message: string) => void;
  /** How long `close()` waits for in-flight requests. Default `limits.timeout_ms + 5s`. */
  drainTimeoutMs?: number;
}

/** Serve MCP over stdio (for local agents like Cursor or Claude Desktop). */
export async function serveStdio(kernel: GraneKernel): Promise<void> {
  const server = buildMcpServer(kernel);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function drainRequest(req: IncomingMessage, maxBytes = HTTP_MAX_BODY_BYTES): Promise<void> {
  let size = 0;
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > maxBytes) {
        req.destroy();
        return;
      }
    }
  } catch {
    /* client hung up */
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...extraHeaders });
  res.end(JSON.stringify(body));
}

function dropRequest(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, extra?: Record<string, string>): void {
  writeJson(res, status, body, extra);
  req.destroy();
}

/**
 * SIGTERM/SIGINT: stop accepting, drain HTTP, then `kernel.close()` (warehouse pool).
 * Safe to call once; later signals are ignored.
 */
export function installHttpProcessShutdown(
  handle: HttpMcpHandle,
  kernel: GraneKernel,
  log: (message: string) => void = (message) => console.error(message),
): void {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) return;
    stopping = true;
    log(`Received ${signal}, draining HTTP connections...`);
    void handle
      .close()
      .then(() => kernel.close())
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        log(`Shutdown error: ${(err as Error).message}`);
        process.exit(1);
      });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
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
  const poolSize = connectionPoolSize(kernel.config.connection);
  const maxConcurrency = defaultMaxConcurrency(poolSize, kernel.config.limits.max_concurrency);
  const drainTimeoutMs = options.drainTimeoutMs ?? kernel.config.limits.timeout_ms + 5_000;
  const bucket =
    kernel.config.limits.rate_limit_rps != null
      ? new TokenBucket(kernel.config.limits.rate_limit_rps)
      : null;

  let shuttingDown = false;
  let closed = false;
  let inFlight = 0;
  const idleWaiters: Array<() => void> = [];

  const release = () => {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) {
      for (const wake of idleWaiters.splice(0)) wake();
    }
  };

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      if (shuttingDown) {
        writeJson(res, 503, { status: "draining", ...kernel.serverInfo() });
        return;
      }
      writeJson(res, 200, { status: "ok", ...kernel.serverInfo() });
      return;
    }

    if (url.pathname !== "/mcp") {
      writeJson(res, 404, { error: "Not found. The MCP endpoint is /mcp." });
      return;
    }

    const httpCtx = httpAuditContext(req);
    const withRequestId = (extra?: Record<string, string>): Record<string, string> => ({
      "x-request-id": httpCtx.request_id,
      ...extra,
    });

    if (req.method !== "POST") {
      writeJson(
        res,
        405,
        {
          jsonrpc: "2.0",
          error: { code: -32000, message: "Method not allowed. Grane serves stateless MCP over POST." },
          id: null,
        },
        withRequestId({ allow: "POST" }),
      );
      return;
    }

    if (shuttingDown) {
      dropRequest(req, res, 503, { error: "shutting_down", message: "Grane HTTP MCP is draining." }, withRequestId({
        "retry-after": "1",
      }));
      return;
    }

    if (bucket && !bucket.tryTake()) {
      dropRequest(
        req,
        res,
        429,
        { error: "rate_limited", message: "Global HTTP rate limit exceeded." },
        withRequestId({ "retry-after": "1" }),
      );
      return;
    }

    if (inFlight >= maxConcurrency) {
      dropRequest(
        req,
        res,
        503,
        {
          error: "overloaded",
          message: `Too many in-flight HTTP requests (max_concurrency=${maxConcurrency}).`,
        },
        withRequestId({ "retry-after": "1" }),
      );
      return;
    }

    inFlight += 1;
    try {
      let bound = kernel.bindHttp(httpCtx);
      if (requireAuth) {
        const result = authenticateAgent(kernel.config, bearerTokenFromHeaders(req.headers));
        if (result === "missing" || result === "invalid") {
          recordAudit(kernel.config, kernel.projectDir, {
            ts: new Date().toISOString(),
            kind: "auth",
            operation: "http",
            agent: null,
            reason: result,
            ...httpFields(httpCtx),
          });
          await drainRequest(req);
          writeJson(
            res,
            401,
            {
              error: "unauthorized",
              message: "Grane HTTP MCP requires a bearer token (Authorization: Bearer <agent token>).",
            },
            withRequestId({ "www-authenticate": 'Bearer realm="grane"' }),
          );
          return;
        }
        bound = bound.bindAgent(result);
      }

      const body = await readJsonBody(req);
      const server = buildMcpServer(bound);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.setHeader("x-request-id", httpCtx.request_id);
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (err) {
      if (err instanceof BodyLimitError) {
        writeJson(res, 413, { error: "payload_too_large", message: err.message }, withRequestId());
        req.destroy();
        return;
      }
      writeJson(res, 500, {
        jsonrpc: "2.0",
        error: { code: -32603, message: (err as Error).message },
        id: null,
      }, withRequestId());
    } finally {
      release();
    }
  });

  const requestTimeoutMs = Math.max(60_000, kernel.config.limits.timeout_ms + 15_000);
  httpServer.requestTimeout = requestTimeoutMs;
  httpServer.headersTimeout = Math.min(30_000, requestTimeoutMs - 1);
  httpServer.keepAliveTimeout = 5_000;
  httpServer.timeout = requestTimeoutMs;

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
    close: async () => {
      if (closed) return;
      closed = true;
      shuttingDown = true;
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const timer = setTimeout(done, drainTimeoutMs);
          idleWaiters.push(() => {
            clearTimeout(timer);
            done();
          });
          if (inFlight <= 0) {
            clearTimeout(timer);
            done();
          }
        });
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
        httpServer.closeIdleConnections?.();
        httpServer.closeAllConnections?.();
      });
    },
  };
}
