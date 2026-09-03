import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function financeKernel() {
  return new GraneKernel(authConfig()).bindAgent({
    id: "finance",
    metrics: ["revenue", "orders"],
    dimensions: ["country"],
    exploration: false,
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

    const afterMissing = readAudit();
    expect(afterMissing).toHaveLength(1);
    expect(afterMissing[0]).toEqual(
      expect.objectContaining({
        kind: "auth",
        operation: "http",
        agent: null,
        reason: "missing",
      }),
    );
    expect(afterMissing[0]!).not.toHaveProperty("query");
    expect(JSON.stringify(afterMissing[0])).not.toContain(financeToken);

    const rejected = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: { Authorization: "Bearer nope", "content-type": "application/json" },
      body: "{}",
    });
    expect(rejected.status).toBe(401);
    const afterInvalid = readAudit();
    expect(afterInvalid).toHaveLength(2);
    expect(afterInvalid[1]).toEqual(
      expect.objectContaining({
        kind: "auth",
        operation: "http",
        agent: null,
        reason: "invalid",
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
