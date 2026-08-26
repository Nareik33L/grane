import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { WarehouseConnector } from "../../src/connectors/types.js";
import { GraneError } from "../../src/errors.js";
import { loadConfig } from "../../src/config/load.js";

const secretRow = "SECRET_ROW_PAYLOAD";
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-audit-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

function stubConnector(): WarehouseConnector {
  return {
    type: "postgres",
    dialect: getDialect("postgres"),
    async query() {
      return { columns: ["revenue"], rows: [{ revenue: secretRow }] };
    },
    async introspect() {
      return { schemaName: "public", tables: [], foreignKeys: [] };
    },
    async close() {},
  };
}

function kernelWithAudit(
  projectDir: string,
  audit: Record<string, unknown> = {},
  agent?: { id: string },
): GraneKernel {
  const config = exampleConfig({ audit: { enabled: true, path: ".grane/audit.jsonl", ...audit } });
  return new GraneKernel(config, {
    projectDir,
    connector: stubConnector(),
    agent: agent
      ? { id: agent.id, metrics: null, dimensions: null, exploration: true }
      : null,
  });
}

function readJsonl(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("query audit log", () => {
  it("appends a query event without row payloads or SQL params", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir, {}, { id: "finance" });
    expect(kernel.serverInfo().capabilities).toContain("audit");
    const result = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.kind).toBe("query");
    expect(event.operation).toBe("query");
    expect(event.agent).toBe("finance");
    expect(event.trust).toBe("governed");
    expect(event.query).toEqual({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(event.query_id).toBe(result.provenance.query_id);
    expect(String(event.sql)).toContain("SELECT");
    expect(event.row_count).toBe(1);
    expect(typeof event.duration_ms).toBe("number");
    expect(JSON.stringify(event)).not.toContain(secretRow);
    expect(event).not.toHaveProperty("params");
    expect(event).not.toHaveProperty("rows");
    expect(event).not.toHaveProperty("token");
  });

  it("logs a refusal for an undefined metric", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir);
    try {
      await kernel.query({ metrics: ["not_a_metric"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
    }
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("refusal");
    expect(events[0]!.operation).toBe("query");
    expect(events[0]!.refusal).toEqual(
      expect.objectContaining({
        status: "undefined_metric",
        requested: "not_a_metric",
      }),
    );
  });

  it("does not write when audit is disabled", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir, { enabled: false });
    await kernel.query({ metrics: ["revenue"] });
    expect(kernel.serverInfo().capabilities).not.toContain("audit");
    expect(() => readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8")).toThrow();
  });

  it("emits JSON lines on stderr when stdout is true", async () => {
    const dir = tempProject();
    const abs = join(dir, "stderr-also.jsonl");
    const k = kernelWithAudit(dir, { stdout: true, path: abs });
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
      chunks.push(String(chunk));
      return orig(chunk, ...(args as []));
    }) as typeof process.stderr.write;
    try {
      await k.query({ metrics: ["revenue"] });
    } finally {
      process.stderr.write = orig;
    }
    const line = chunks.find((c) => c.includes('"kind":"query"'));
    expect(line).toBeTruthy();
    expect(JSON.parse(line!)).toEqual(expect.objectContaining({ kind: "query", agent: null }));
    expect(readJsonl(abs)).toHaveLength(1);
  });

  it("logs explain refusals without treating them as executed queries", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir);
    try {
      await kernel.explain({ metrics: ["not_a_metric"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
    }
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events[0]!.kind).toBe("refusal");
    expect(events[0]!.operation).toBe("explain");
    expect(events[0]!.row_count).toBeUndefined();
  });
});

describe("audit config", () => {
  it("defaults to enabled JSONL under .grane and interpolates path", () => {
    const dir = tempProject();
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres }
audit:
  path: \${UNUSED_AUDIT_VAR:-.grane/custom.jsonl}
`,
    );
    const loaded = loadConfig(dir);
    expect(loaded.config.audit.enabled).toBe(true);
    expect(loaded.config.audit.path).toBe(".grane/custom.jsonl");
    expect(loaded.config.audit.stdout).toBe(false);
  });

  it("applies GRANE_AUDIT_PATH and GRANE_AUDIT_STDOUT from the environment", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "grane.yml"), "connection: { type: postgres }\n");
    const prevPath = process.env.GRANE_AUDIT_PATH;
    const prevStdout = process.env.GRANE_AUDIT_STDOUT;
    process.env.GRANE_AUDIT_PATH = "/var/log/grane/audit.jsonl";
    process.env.GRANE_AUDIT_STDOUT = "1";
    try {
      const loaded = loadConfig(dir);
      expect(loaded.config.audit.path).toBe("/var/log/grane/audit.jsonl");
      expect(loaded.config.audit.stdout).toBe(true);
    } finally {
      if (prevPath === undefined) delete process.env.GRANE_AUDIT_PATH;
      else process.env.GRANE_AUDIT_PATH = prevPath;
      if (prevStdout === undefined) delete process.env.GRANE_AUDIT_STDOUT;
      else process.env.GRANE_AUDIT_STDOUT = prevStdout;
    }
  });
});
