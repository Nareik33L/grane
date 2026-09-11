import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { httpAuditContext, sanitizeRequestId } from "../../src/mcp/http-audit.js";

function fakeReq(headers: Record<string, string>, remoteAddress = "127.0.0.1"): IncomingMessage {
  const socket = new Socket();
  Object.defineProperty(socket, "remoteAddress", { value: remoteAddress });
  return { headers, socket } as IncomingMessage;
}

describe("HTTP audit correlation", () => {
  it("honours a visible-ASCII X-Request-Id", () => {
    const ctx = httpAuditContext(fakeReq({ "x-request-id": "from-proxy" }));
    expect(ctx.request_id).toBe("from-proxy");
  });

  it("generates a request id when the header is missing or unsafe", () => {
    expect(sanitizeRequestId(undefined)).toBeUndefined();
    expect(sanitizeRequestId("has a space")).toBeUndefined();
    expect(sanitizeRequestId("bad\nid")).toBeUndefined();
    const ctx = httpAuditContext(fakeReq({}));
    expect(ctx.request_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
  });

  it("prefers the first X-Forwarded-For hop", () => {
    const ctx = httpAuditContext(
      fakeReq({ "x-forwarded-for": "203.0.113.10, 10.0.0.1" }, "192.168.1.1"),
    );
    expect(ctx.client_ip).toBe("203.0.113.10");
  });

  it("falls back to the TCP peer", () => {
    const ctx = httpAuditContext(fakeReq({}, "10.1.2.3"));
    expect(ctx.client_ip).toBe("10.1.2.3");
  });

  it("captures user-agent", () => {
    const ctx = httpAuditContext(fakeReq({ "user-agent": "Cursor/1.0" }));
    expect(ctx.user_agent).toBe("Cursor/1.0");
  });
});
