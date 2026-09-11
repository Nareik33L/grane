import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { HttpAuditContext } from "../audit.js";

const REQUEST_ID_MAX = 128;
const USER_AGENT_MAX = 512;

/**
 * Correlation for HTTP-originated audit events. Honours `X-Request-Id` when
 * it is a single-line visible-ASCII token; otherwise generates a UUID.
 * `client_ip` is the first `X-Forwarded-For` hop when present, else the
 * TCP peer. Reverse proxies should set `X-Forwarded-For` (and `X-Request-Id`).
 */
export function httpAuditContext(req: IncomingMessage): HttpAuditContext {
  const incoming = headerValue(req.headers["x-request-id"]);
  return {
    request_id: sanitizeRequestId(incoming) ?? randomUUID(),
    client_ip: clientIp(req),
    user_agent: sanitizeUserAgent(headerValue(req.headers["user-agent"])),
  };
}

export function sanitizeRequestId(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim().slice(0, REQUEST_ID_MAX);
  if (!trimmed) return undefined;
  if (!/^[\x21-\x7E]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function headerValue(value: IncomingHttpHeaders[string]): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function sanitizeUserAgent(raw: string | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, " ").trim().slice(0, USER_AGENT_MAX);
  return cleaned || null;
}

function clientIp(req: IncomingMessage): string | null {
  const forwarded = headerValue(req.headers["x-forwarded-for"]);
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim() ?? "";
    if (first && first.length <= 128 && !/[\x00-\x1F]/.test(first)) return first;
  }
  return req.socket.remoteAddress ?? null;
}
