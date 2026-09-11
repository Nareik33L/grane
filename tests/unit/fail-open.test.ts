import { describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import { agentConfigSchema, graneConfigSchema } from "../../src/config/schema.js";
import { serveHttp } from "../../src/mcp/transport.js";
import {
  anonymousHttpWarning,
  assertAnonymousHttpBind,
  isLoopbackHost,
} from "../../src/mcp/http-bind.js";
import {
  isWriteSql,
  runWithTimeout,
  timeoutSeconds,
  warehouseSslOptions,
} from "../../src/connectors/types.js";
import { GraneError } from "../../src/errors.js";

describe("anonymous HTTP bind", () => {
  it("treats loopback aliases as loopback", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::")).toBe(false);
  });

  it("refuses unauthenticated HTTP off loopback without --allow-anonymous", () => {
    try {
      assertAnonymousHttpBind({ host: "0.0.0.0", allowAnonymous: false, hasAgents: false });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("config_error");
      expect((err as GraneError).message).toMatch(/--allow-anonymous/);
    }
  });

  it("allows loopback without agents", () => {
    expect(() =>
      assertAnonymousHttpBind({ host: "127.0.0.1", allowAnonymous: false, hasAgents: false }),
    ).not.toThrow();
  });

  it("allows non-loopback with --allow-anonymous", () => {
    expect(() =>
      assertAnonymousHttpBind({ host: "0.0.0.0", allowAnonymous: true, hasAgents: false }),
    ).not.toThrow();
  });

  it("allows non-loopback when agents are configured", () => {
    expect(() =>
      assertAnonymousHttpBind({ host: "0.0.0.0", allowAnonymous: false, hasAgents: true }),
    ).not.toThrow();
  });

  it("serveHttp refuses anonymous 0.0.0.0 without the flag", async () => {
    const kernel = new GraneKernel(exampleConfig());
    await expect(serveHttp(kernel, 0, { host: "0.0.0.0" })).rejects.toMatchObject({
      refusal: { status: "config_error" },
    });
  });

  it("serveHttp warns on loopback when no agents are configured", async () => {
    const kernel = new GraneKernel(exampleConfig());
    const warnings: string[] = [];
    const handle = await serveHttp(kernel, 0, { onWarning: (message) => warnings.push(message) });
    try {
      expect(handle.host).toBe("127.0.0.1");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/WARNING: No auth\.agents configured/);
      expect(warnings[0]).toContain(`loopback 127.0.0.1:${handle.port}`);
      expect(anonymousHttpWarning(handle.host, handle.port)).toBe(warnings[0]);
    } finally {
      await handle.close();
    }
  });

  it("serveHttp warns on 0.0.0.0 when --allow-anonymous is set", async () => {
    const kernel = new GraneKernel(exampleConfig());
    const warnings: string[] = [];
    const handle = await serveHttp(kernel, 0, {
      host: "0.0.0.0",
      allowAnonymous: true,
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect(handle.host).toBe("0.0.0.0");
      expect(warnings[0]).toMatch(/non-loopback 0\.0\.0\.0:/);
      expect(warnings[0]).toMatch(/--allow-anonymous/);
    } finally {
      await handle.close();
    }
  });

  it("serveHttp may bind 0.0.0.0 when agents are configured", async () => {
    const config = exampleConfig();
    config.auth.agents = [{ id: "finance", token: "secret", exploration: false }];
    const kernel = new GraneKernel(config);
    const warnings: string[] = [];
    const handle = await serveHttp(kernel, 0, {
      host: "0.0.0.0",
      onWarning: (message) => warnings.push(message),
    });
    try {
      expect(handle.host).toBe("0.0.0.0");
      expect(warnings).toEqual([]);
    } finally {
      await handle.close();
    }
  });
});

describe("per-agent exploration default", () => {
  it("parses omitted exploration as false", () => {
    expect(agentConfigSchema.parse({ id: "finance", token: "secret" }).exploration).toBe(false);
  });

  it("still honours an explicit true", () => {
    expect(
      agentConfigSchema.parse({ id: "analyst", token: "secret", exploration: true }).exploration,
    ).toBe(true);
  });

  it("applies the default through the full config schema", () => {
    const parsed = graneConfigSchema.parse({
      connection: { type: "postgres" },
      auth: { agents: [{ id: "finance", token: "secret" }] },
    });
    expect(parsed.auth.agents[0]?.exploration).toBe(false);
    expect(parsed.exploration.enabled).toBe(false);
  });
});

describe("warehouse TLS verification", () => {
  it("does not enable TLS unless ssl is true", () => {
    expect(warehouseSslOptions({})).toBeUndefined();
    expect(warehouseSslOptions({ ssl: false, ssl_verify: true })).toBeUndefined();
  });

  it("verifies certificates by default when ssl is on", () => {
    expect(warehouseSslOptions({ ssl: true })).toEqual({ rejectUnauthorized: true });
    expect(warehouseSslOptions({ ssl: true, ssl_verify: true })).toEqual({ rejectUnauthorized: true });
  });

  it("opts out only when ssl_verify is false", () => {
    expect(warehouseSslOptions({ ssl: true, ssl_verify: false })).toEqual({
      rejectUnauthorized: false,
    });
  });
});

describe("shared write-keyword guard", () => {
  it("does not treat SELECT as a write", () => {
    expect(isWriteSql("SELECT 1")).toBe(false);
    expect(isWriteSql("  with cte as (select 1) select * from cte")).toBe(false);
  });

  it("covers the former connector gaps", () => {
    for (const sql of [
      "COPY orders TO STDOUT",
      "CALL do_something()",
      "DO $$ BEGIN NULL; END $$",
      "GRANT SELECT ON orders TO public",
      "REVOKE SELECT ON orders FROM public",
      "MERGE INTO dst USING src ON dst.id = src.id WHEN MATCHED THEN UPDATE SET x = 1",
      "OPTIMIZE TABLE events",
      "EXECUTE IMMEDIATE 'SELECT 1'",
    ]) {
      expect(isWriteSql(sql)).toBe(true);
    }
  });
});

describe("timeout helpers", () => {
  it("rounds timeout_ms up to whole seconds", () => {
    expect(timeoutSeconds(30000)).toBe(30);
    expect(timeoutSeconds(1)).toBe(1);
    expect(timeoutSeconds(1001)).toBe(2);
  });

  it("resolves when work finishes in time", async () => {
    await expect(runWithTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it("interrupts and rejects after timeout_ms", async () => {
    let interrupted = false;
    await expect(
      runWithTimeout(
        new Promise(() => undefined),
        20,
        () => {
          interrupted = true;
        },
      ),
    ).rejects.toThrow(/timeout_ms/);
    expect(interrupted).toBe(true);
  });
});
