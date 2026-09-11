import type { IncomingMessage } from "node:http";

/** Generous cap for a semantic MCP request. */
export const HTTP_MAX_BODY_BYTES = 1024 * 1024;

export class BodyLimitError extends Error {
  readonly status = 413 as const;
  constructor(maxBytes = HTTP_MAX_BODY_BYTES) {
    super(`Request body exceeds ${maxBytes} bytes.`);
    this.name = "BodyLimitError";
  }
}

export function defaultMaxConcurrency(poolSize: number, configured?: number): number {
  return configured ?? Math.max(1, poolSize * 2);
}

export function contentLengthExceeds(
  headers: IncomingMessage["headers"] | undefined,
  maxBytes: number,
): boolean {
  const raw = headers?.["content-length"];
  if (raw == null) return false;
  const n = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(n) && n > maxBytes;
}

export async function readJsonBody(
  req: IncomingMessage,
  maxBytes = HTTP_MAX_BODY_BYTES,
): Promise<unknown> {
  if (contentLengthExceeds(req.headers, maxBytes)) {
    throw new BodyLimitError(maxBytes);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) {
      throw new BodyLimitError(maxBytes);
    }
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return undefined;
  return JSON.parse(raw);
}

/** Process-wide token bucket. Burst is one second of traffic at `rps`. */
export class TokenBucket {
  private tokens: number;
  private lastMs: number;

  constructor(
    private readonly rps: number,
    private readonly burst = Math.max(1, Math.ceil(rps)),
  ) {
    this.tokens = this.burst;
    this.lastMs = Date.now();
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.lastMs) / 1000) * this.rps);
    this.lastMs = now;
  }
}
