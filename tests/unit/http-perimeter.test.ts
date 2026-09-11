import http from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import { graneConfigSchema } from "../../src/config/schema.js";
import { serveHttp } from "../../src/mcp/transport.js";
import {
  BodyLimitError,
  HTTP_MAX_BODY_BYTES,
  TokenBucket,
  contentLengthExceeds,
  defaultMaxConcurrency,
  readJsonBody,
} from "../../src/mcp/http-limit.js";
import { connectionPoolSize } from "../../src/connectors/types.js";
import { createPgPool } from "../../src/connectors/postgres/client.js";

const INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

async function serve(limits: Record<string, unknown> = {}, drainTimeoutMs = 1_000) {
  const config = exampleConfig();
  Object.assign(config.limits, limits);
  const kernel = new GraneKernel(config);
  const handle = await serveHttp(kernel, 0, {
    onWarning: () => undefined,
    drainTimeoutMs,
  });
  return {
    handle,
    url: `http://127.0.0.1:${handle.port}`,
    close: () => handle.close(),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hangMcp(url: string): http.ClientRequest {
  const req = http.request(`${url}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": 20 },
  });
  req.on("error", () => undefined);
  req.write("{");
  return req;
}

async function waitForOverload(url: string): Promise<Response> {
  let last: Response | undefined;
  for (let i = 0; i < 25; i++) {
    last = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: INIT,
    });
    if (last.status === 503) return last;
    await sleep(20);
  }
  return last!;
}

describe("HTTP body cap", () => {
  it("rejects Content-Length over 1 MiB with 413", async () => {
    expect(contentLengthExceeds({ "content-length": String(HTTP_MAX_BODY_BYTES + 1) }, HTTP_MAX_BODY_BYTES)).toBe(
      true,
    );
    const { url, close } = await serve();
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          `${url}/mcp`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Length": HTTP_MAX_BODY_BYTES + 1,
            },
          },
          (res) => {
            resolve(res.statusCode ?? 0);
            res.resume();
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      expect(status).toBe(413);
    } finally {
      await close();
    }
  });

  it("readJsonBody throws BodyLimitError when the stream exceeds the cap", async () => {
    const stream = new PassThrough();
    const pending = readJsonBody(stream as unknown as http.IncomingMessage, 16);
    stream.write(Buffer.alloc(64, 0x61));
    stream.end();
    await expect(pending).rejects.toBeInstanceOf(BodyLimitError);
  });
});

describe("concurrency and rate limit", () => {
  it("returns 503 when max_concurrency in-flight /mcp requests are reached", async () => {
    const { url, close } = await serve({ max_concurrency: 1 });
    const hung = hangMcp(url);
    try {
      const second = await waitForOverload(url);
      expect(second.status).toBe(503);
      expect(second.headers.get("retry-after")).toBe("1");
      expect(((await second.json()) as { error: string }).error).toBe("overloaded");
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
    } finally {
      hung.destroy();
      await close();
    }
  });

  it("returns 429 when the global token bucket is empty", async () => {
    const { url, close } = await serve({ rate_limit_rps: 1 });
    try {
      const first = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: INIT,
      });
      expect(first.status).not.toBe(429);
      const second = await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: INIT,
      });
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBe("1");
      expect(((await second.json()) as { error: string }).error).toBe("rate_limited");
    } finally {
      await close();
    }
  });

  it("does not rate-limit /health", async () => {
    const { url, close } = await serve({ rate_limit_rps: 1 });
    try {
      await fetch(`${url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: INIT,
      });
      const health = await fetch(`${url}/health`);
      expect(health.status).toBe(200);
    } finally {
      await close();
    }
  });
});

describe("graceful shutdown", () => {
  it("close() stops accepting and /health fails afterward", async () => {
    const { url, close, handle } = await serve();
    expect((await fetch(`${url}/health`)).status).toBe(200);
    await close();
    await expect(fetch(`${url}/health`)).rejects.toThrow();
    await handle.close();
  });

  it("close() returns 503 on /health while draining an in-flight request", async () => {
    const { url, handle } = await serve({ max_concurrency: 1 }, 2_000);
    const hung = hangMcp(url);
    try {
      const overloaded = await waitForOverload(url);
      expect(overloaded.status).toBe(503);
      const closing = handle.close();
      await sleep(20);
      const health = await fetch(`${url}/health`).catch(() => null);
      if (health) {
        expect(health.status).toBe(503);
        expect(((await health.json()) as { status: string }).status).toBe("draining");
      }
      hung.destroy();
      await closing;
    } catch (err) {
      hung.destroy();
      await handle.close();
      throw err;
    }
  });
});

describe("pool size and concurrency defaults", () => {
  it("defaults pool_size to 5 and max_concurrency to 2× pool", () => {
    const parsed = graneConfigSchema.parse({ connection: { type: "postgres" } });
    expect(parsed.connection.pool_size).toBe(5);
    expect(parsed.limits.max_concurrency).toBeUndefined();
    expect(defaultMaxConcurrency(parsed.connection.pool_size, parsed.limits.max_concurrency)).toBe(10);
    expect(connectionPoolSize({})).toBe(5);
    expect(connectionPoolSize({ pool_size: 16 })).toBe(16);
  });

  it("honours connection.pool_size on the Postgres pool", async () => {
    const connection = graneConfigSchema.parse({
      connection: { type: "postgres", host: "127.0.0.1", database: "grane", pool_size: 12 },
    }).connection;
    const pool = createPgPool(connection);
    try {
      expect(pool.options.max).toBe(12);
    } finally {
      await pool.end();
    }
  });
});

describe("token bucket", () => {
  it("allows a burst then denies until refill", async () => {
    const bucket = new TokenBucket(100, 1);
    expect(bucket.tryTake()).toBe(true);
    expect(bucket.tryTake()).toBe(false);
    await sleep(30);
    expect(bucket.tryTake()).toBe(true);
  });
});
