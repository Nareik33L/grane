import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exampleConfig } from "../fixtures.js";
import { lintProduction, PRODUCTION_LIMIT_CEILINGS } from "../../src/cli/production-lint.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-prod-lint-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

describe("production lint", () => {
  it("fails on every listed fail-open condition", () => {
    const dir = project();
    const config = exampleConfig({
      connection: { type: "postgres", ssl: true, ssl_verify: false },
      limits: { max_rows: PRODUCTION_LIMIT_CEILINGS.max_rows + 1, default_rows: 1000, timeout_ms: 30000 },
      metrics: {
        revenue: {
          entity: "order",
          type: "sum",
          sql: "${orders.net_amount}",
          status: "experimental",
        },
      },
      auth: { agents: [{ id: "analyst", token: "secret", exploration: true }] },
    });
    writeFileSync(join(dir, "blocked"), "not a dir");
    config.audit.path = "blocked/audit.jsonl";
    const lint = lintProduction(config, dir);
    expect(lint.ok).toBe(false);
    const byName = Object.fromEntries(lint.checks.map((c) => [c.name, c]));
    expect(byName["auth.agents"]?.ok).toBe(true);
    expect(byName.exploration?.ok).toBe(false);
    expect(byName.tls?.ok).toBe(false);
    expect(byName["audit.path"]?.ok).toBe(false);
    expect(byName.limits?.ok).toBe(false);
    expect(byName.metrics?.ok).toBe(false);
    expect(byName.metrics?.detail).toMatch(/revenue/);
  });

  it("fails when no agents are configured", () => {
    const dir = project();
    const lint = lintProduction(exampleConfig(), dir);
    expect(lint.checks.find((c) => c.name === "auth.agents")?.ok).toBe(false);
    expect(lint.ok).toBe(false);
  });

  it("passes a locked-down config with a writable audit path", () => {
    const dir = project();
    const config = exampleConfig({
      connection: { type: "postgres", ssl: true, ssl_verify: true },
      auth: { agents: [{ id: "finance", token: "secret", exploration: false }] },
      audit: { enabled: true, path: ".grane/audit.jsonl" },
    });
    const lint = lintProduction(config, dir);
    expect(lint.ok).toBe(true);
  });

  it("allows limits at the ceiling", () => {
    const dir = project();
    const config = exampleConfig({
      auth: { agents: [{ id: "finance", token: "secret" }] },
      limits: {
        max_rows: PRODUCTION_LIMIT_CEILINGS.max_rows,
        default_rows: PRODUCTION_LIMIT_CEILINGS.default_rows,
        timeout_ms: PRODUCTION_LIMIT_CEILINGS.timeout_ms,
      },
    });
    expect(lintProduction(config, dir).checks.find((c) => c.name === "limits")?.ok).toBe(true);
  });
});
