import { afterAll, describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import { authenticateAgent, bearerTokenFromHeaders, httpAuthRequired } from "../../src/auth/agents.js";
import { serveHttp } from "../../src/mcp/transport.js";
import { GraneError } from "../../src/errors.js";

const financeToken = "finance-secret-token";
const analystToken = "analyst-secret-token";

function authConfig() {
  const config = exampleConfig();
  config.auth.agents = [
    {
      id: "finance",
      token: financeToken,
      metrics: ["revenue", "orders"],
      dimensions: ["country"],
      exploration: false,
    },
    {
      id: "analyst",
      token: analystToken,
      exploration: true,
    },
  ];
  return config;
}

describe("per-agent grants", () => {
  it("hides disallowed metrics from the catalog", () => {
    const kernel = new GraneKernel(authConfig()).bindAgent({
      id: "finance",
      metrics: ["revenue", "orders"],
      dimensions: ["country"],
      exploration: false,
    });
    const names = kernel.governedCatalog().metrics.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["revenue", "orders"]));
    expect(names).not.toContain("payments_received");
    expect(kernel.serverInfo().agent).toBe("finance");
    expect(kernel.config.exploration.enabled).toBe(false);
  });

  it("refuses a metric the agent is not granted", () => {
    const kernel = new GraneKernel(authConfig()).bindAgent({
      id: "finance",
      metrics: ["revenue", "orders"],
      dimensions: ["country"],
      exploration: false,
    });
    try {
      kernel.compile({ metrics: ["payments_received"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("undefined_metric");
    }
  });

  it("lets a full-catalog agent compile revenue", () => {
    const kernel = new GraneKernel(authConfig()).bindAgent({
      id: "analyst",
      metrics: null,
      dimensions: null,
      exploration: true,
    });
    const { resolved } = kernel.compile({ metrics: ["revenue"], dimensions: ["country"] });
    expect(resolved.trust).toBe("governed");
  });
});

describe("HTTP bearer auth", () => {
  const kernel = new GraneKernel(authConfig());
  let port = 0;
  let close: () => Promise<void> = async () => undefined;

  it("requires a bearer token when agents are configured", async () => {
    expect(httpAuthRequired(kernel.config)).toBe(true);
    const handle = await serveHttp(kernel, 0);
    port = handle.port;
    close = () => handle.close();

    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const authed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${financeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(authed.status).not.toBe(401);
  });

  afterAll(async () => {
    await close();
  });
});

describe("token matching", () => {
  it("reads Bearer and x-grane-token headers", () => {
    expect(bearerTokenFromHeaders({ authorization: "Bearer abc" })).toBe("abc");
    expect(bearerTokenFromHeaders({ "x-grane-token": "xyz" })).toBe("xyz");
  });

  it("authenticates the matching agent", () => {
    const config = authConfig();
    expect(authenticateAgent(config, financeToken)).toMatchObject({ id: "finance" });
    expect(authenticateAgent(config, "nope")).toBe("invalid");
    expect(authenticateAgent(config, undefined)).toBe("missing");
  });
});
