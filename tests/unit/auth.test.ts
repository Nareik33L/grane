import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import {
  authenticateAgent,
  bearerTokenFromHeaders,
  httpAuthRequired,
  validateAuthConfig,
} from "../../src/auth/agents.js";
import { serveHttp } from "../../src/mcp/transport.js";
import { GraneError } from "../../src/errors.js";
import { agentConfigSchema } from "../../src/config/schema.js";
import { loadConfig } from "../../src/config/load.js";

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
      exploration_exclude: [],
    },
    {
      id: "analyst",
      token: analystToken,
      exploration: true,
      exploration_exclude: [],
    },
  ];
  return config;
}

function financeKernel() {
  return new GraneKernel(authConfig()).bindAgent({
    id: "finance",
    metrics: ["revenue", "orders"],
    dimensions: ["country"],
    exploration: false,
    explorationExclude: [],
  });
}

function expectUndefinedDimension(fn: () => unknown, requested: string) {
  try {
    fn();
    expect.unreachable();
  } catch (err) {
    const refusal = (err as GraneError).refusal;
    expect(refusal.status).toBe("undefined_dimension");
    expect(refusal.requested).toBe(requested);
    expect(refusal.similar).toEqual(["country"]);
    expect(refusal.similar).not.toContain("channel");
  }
}

describe("per-agent grants", () => {
  it("hides disallowed metrics from the catalog", () => {
    const kernel = financeKernel();
    const names = kernel.governedCatalog().metrics.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["revenue", "orders"]));
    expect(names).not.toContain("payments_received");
    expect(kernel.serverInfo().agent).toBe("finance");
    expect(kernel.config.exploration.enabled).toBe(false);
  });

  it("hides disallowed dimensions from the catalog and available_dimensions", () => {
    const kernel = financeKernel();
    const catalog = kernel.governedCatalog();
    expect(catalog.dimensions.map((d) => d.name)).toEqual(["country"]);
    for (const metric of catalog.metrics) {
      expect(metric.available_dimensions.every((name) => name === "country")).toBe(true);
      expect(metric.available_dimensions).not.toContain("channel");
    }
  });

  it("refuses a metric the agent is not granted", () => {
    const kernel = financeKernel();
    try {
      kernel.compile({ metrics: ["payments_received"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("undefined_metric");
    }
  });

  it("refuses grouping, filters, and time.dimension outside the allow-list", () => {
    const kernel = financeKernel();
    expectUndefinedDimension(
      () => kernel.compile({ metrics: ["revenue"], dimensions: ["channel"] }),
      "channel",
    );
    expectUndefinedDimension(
      () =>
        kernel.compile({
          metrics: ["revenue"],
          filters: [{ field: "channel", operator: "=", value: "web" }],
        }),
      "channel",
    );
    expectUndefinedDimension(
      () =>
        kernel.compile({
          metrics: ["revenue"],
          time: { period: "30d", dimension: "completed_at" },
        }),
      "completed_at",
    );
    expectUndefinedDimension(
      () =>
        kernel.compile({
          metrics: ["revenue"],
          filters: [{ field: "not_a_dimension", operator: "=", value: "x" }],
        }),
      "not_a_dimension",
    );
  });

  it("still compiles implicit metric time without granting the time dimension", () => {
    const kernel = financeKernel();
    const { resolved } = kernel.compile({ metrics: ["revenue"], time: { period: "30d" } });
    expect(resolved.trust).toBe("governed");
    expect(resolved.time).not.toBeNull();
  });

  it("lets a full-catalog agent compile revenue", () => {
    const kernel = new GraneKernel(authConfig()).bindAgent({
      id: "analyst",
      metrics: null,
      dimensions: null,
      exploration: true,
      explorationExclude: [],
    });
    const { resolved } = kernel.compile({ metrics: ["revenue"], dimensions: ["country"] });
    expect(resolved.trust).toBe("governed");
  });
});

describe("HTTP bearer auth", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "grane-auth-audit-"));
  mkdirSync(join(projectDir, ".grane"), { recursive: true });
  const kernel = new GraneKernel(authConfig(), { projectDir });
  const auditPath = join(projectDir, ".grane", "audit.jsonl");
  let port = 0;
  let close: () => Promise<void> = async () => undefined;

  function readAudit(): Record<string, unknown>[] {
    try {
      return readFileSync(auditPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  it("requires a bearer token when agents are configured", async () => {
    expect(httpAuthRequired(kernel.config)).toBe(true);
    const handle = await serveHttp(kernel, 0);
    port = handle.port;
    close = () => handle.close();

    const denied = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", body: "{}" });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toMatch(/Bearer/i);
    const missingId = denied.headers.get("x-request-id");
    expect(missingId).toBeTruthy();

    const afterMissing = readAudit();
    expect(afterMissing).toHaveLength(1);
    expect(afterMissing[0]).toEqual(
      expect.objectContaining({
        kind: "auth",
        operation: "http",
        agent: null,
        reason: "missing",
        request_id: missingId,
      }),
    );
    expect(afterMissing[0]!).toHaveProperty("client_ip");
    expect(afterMissing[0]!).toHaveProperty("user_agent");
    expect(afterMissing[0]!).not.toHaveProperty("query");
    expect(JSON.stringify(afterMissing[0])).not.toContain(financeToken);

    const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        Authorization: "Bearer nope",
        "content-type": "application/json",
        "x-request-id": "from-proxy-1",
        "user-agent": "Gauntlet/0",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
      body: "{}",
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get("x-request-id")).toBe("from-proxy-1");
    const afterInvalid = readAudit();
    expect(afterInvalid).toHaveLength(2);
    expect(afterInvalid[1]).toEqual(
      expect.objectContaining({
        kind: "auth",
        operation: "http",
        agent: null,
        reason: "invalid",
        request_id: "from-proxy-1",
        client_ip: "203.0.113.9",
        user_agent: "Gauntlet/0",
      }),
    );
    expect(afterInvalid[1]!).not.toHaveProperty("query");

    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);

    const authed = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: `Bearer ${financeToken}`, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(authed.status).not.toBe(401);
    expect(readAudit().filter((event) => event.kind === "auth")).toHaveLength(2);
  });

  afterAll(async () => {
    await close();
    rmSync(projectDir, { recursive: true, force: true });
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

describe("token_sha256", () => {
  const digest = createHash("sha256").update(financeToken).digest("hex");

  it("accepts a hex digest instead of plaintext token", () => {
    const parsed = agentConfigSchema.parse({ id: "finance", token_sha256: digest });
    expect(parsed.token).toBeUndefined();
    const config = exampleConfig();
    config.auth.agents = [parsed];
    expect(authenticateAgent(config, financeToken)).toMatchObject({ id: "finance" });
    expect(authenticateAgent(config, "nope")).toBe("invalid");
  });

  it("matches mixed-case hex", () => {
    const config = exampleConfig();
    config.auth.agents = [agentConfigSchema.parse({ id: "finance", token_sha256: digest.toUpperCase() })];
    expect(authenticateAgent(config, financeToken)).toMatchObject({ id: "finance" });
  });

  it("rejects both token and token_sha256, and neither", () => {
    expect(agentConfigSchema.safeParse({ id: "finance" }).success).toBe(false);
    expect(
      agentConfigSchema.safeParse({ id: "finance", token: "secret", token_sha256: digest }).success,
    ).toBe(false);
    expect(agentConfigSchema.safeParse({ id: "finance", token_sha256: "abc" }).success).toBe(false);
  });

  it("treats a plaintext token and its digest as the same secret", () => {
    const config = exampleConfig();
    config.auth.agents = [
      agentConfigSchema.parse({ id: "a", token: financeToken }),
      agentConfigSchema.parse({ id: "b", token_sha256: digest }),
    ];
    expect(() => validateAuthConfig(config)).toThrow(/Duplicate auth token/);
  });

  it("interpolates token_sha256 from the environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-sha-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres }
auth:
  agents:
    - id: finance
      token_sha256: \${FINANCE_AGENT_TOKEN_SHA256}
`,
    );
    const prev = process.env.FINANCE_AGENT_TOKEN_SHA256;
    process.env.FINANCE_AGENT_TOKEN_SHA256 = digest;
    try {
      const loaded = loadConfig(dir);
      expect(loaded.config.auth.agents[0]?.token_sha256).toBe(digest);
      expect(authenticateAgent(loaded.config, financeToken)).toMatchObject({ id: "finance" });
    } finally {
      if (prev === undefined) delete process.env.FINANCE_AGENT_TOKEN_SHA256;
      else process.env.FINANCE_AGENT_TOKEN_SHA256 = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
