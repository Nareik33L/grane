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
import { appendAudit, authoringAuditEvent, recordAudit, recordDiscoveryAudit, recordAuthoringAudit } from "../../src/audit.js";
import { attributeCompiledSql } from "../../src/execute/executor.js";

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
      ? { id: agent.id, metrics: null, dimensions: null, exploration: true, explorationExclude: [] }
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
    expect(event).toHaveProperty("query");
    expect(event.query).toEqual({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(event).not.toHaveProperty("reason");
    expect(event.query_id).toBe(result.provenance.query_id);
    expect(String(event.sql)).toBe(result.provenance.generated_sql);
    expect(String(event.sql)).toMatch(
      new RegExp(`^/\\* grane query_id=${result.provenance.query_id} agent=finance \\*/\\n`),
    );
    expect(result.provenance.generated_sql).toContain("SELECT");
    expect(event).not.toHaveProperty("request_id");
    expect(event).not.toHaveProperty("client_ip");
    expect(event).not.toHaveProperty("user_agent");
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
    expect(events[0]!).toHaveProperty("query");
    expect(events[0]!.query).toEqual({ metrics: ["not_a_metric"] });
    expect(events[0]!).not.toHaveProperty("reason");
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
    expect(events[0]!).toHaveProperty("query");
    expect(events[0]!.query).toEqual({ metrics: ["not_a_metric"] });
    expect(events[0]!).not.toHaveProperty("reason");
    expect(events[0]!.row_count).toBeUndefined();
  });

  it("writes auth denials without a query field", () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir);
    recordAudit(kernel.config, dir, {
      ts: "2026-09-03T00:00:00.000Z",
      kind: "auth",
      operation: "http",
      agent: null,
      reason: "missing",
    });
    const events = readJsonl(join(dir, ".grane", "audit.jsonl"));
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      ts: "2026-09-03T00:00:00.000Z",
      kind: "auth",
      operation: "http",
      agent: null,
      reason: "missing",
    });
    expect(events[0]!).not.toHaveProperty("query");
  });

  it("stamps HTTP correlation onto query events when the kernel is bound", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir, {}, { id: "finance" }).bindHttp({
      request_id: "req-from-proxy",
      client_ip: "203.0.113.10",
      user_agent: "Cursor/1.0",
    });
    await kernel.query({ metrics: ["revenue"] });
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(event.request_id).toBe("req-from-proxy");
    expect(event.client_ip).toBe("203.0.113.10");
    expect(event.user_agent).toBe("Cursor/1.0");
    expect(event.kind).toBe("query");
  });

  it("stamps HTTP correlation onto refusals", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir).bindHttp({
      request_id: "r-1",
      client_ip: "127.0.0.1",
      user_agent: null,
    });
    try {
      await kernel.query({ metrics: ["not_a_metric"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
    }
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(event.kind).toBe("refusal");
    expect(event.request_id).toBe("r-1");
    expect(event.client_ip).toBe("127.0.0.1");
    expect(event.user_agent).toBeNull();
  });

  it("uses agent=- in the warehouse comment when no agent is bound", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir);
    const result = await kernel.query({ metrics: ["revenue"] });
    expect(result.provenance.generated_sql).toMatch(
      new RegExp(`^/\\* grane query_id=${result.provenance.query_id} agent=- \\*/\\n`),
    );
  });

  it("does not prefix compile() SQL; only executed SQL is attributed", () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir, {}, { id: "finance" });
    const compiled = kernel.compile({ metrics: ["revenue"] }).compiled.sql;
    expect(compiled).not.toMatch(/^\/\* grane /);
    expect(compiled).toContain("SELECT");
  });

  it("sanitizes agent ids that would break out of the SQL comment", () => {
    const sql = attributeCompiledSql("SELECT 1", "q_abc", "finance */ DROP TABLE t --");
    expect(sql).toBe("/* grane query_id=q_abc agent=finance_DROP_TABLE_t */\nSELECT 1");
  });

  it("swallows a failed audit append by default", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, "blocked"), "not a directory");
    const kernel = kernelWithAudit(dir, { path: "blocked/audit.jsonl" });
    await expect(kernel.query({ metrics: ["revenue"] })).resolves.toMatchObject({
      provenance: { row_count: 1 },
    });
  });

  it("refuses the query when fail_closed and the audit append fails", async () => {
    const dir = tempProject();
    writeFileSync(join(dir, "blocked"), "not a directory");
    const kernel = kernelWithAudit(dir, { path: "blocked/audit.jsonl", fail_closed: true });
    try {
      await kernel.query({ metrics: ["revenue"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("config_error");
      expect((err as GraneError).message).toMatch(/fail_closed/);
    }
  });
});

describe("discovery audit log", () => {
  const sampleValue = "SECRET_SAMPLE_VALUE";

  function auditedConfig(dir: string, audit: Record<string, unknown> = {}) {
    return exampleConfig({ audit: { enabled: true, path: ".grane/audit.jsonl", ...audit } });
  }

  it("writes exactly one JSONL line per discovery call with SQL and counts, never samples", () => {
    const dir = tempProject();
    const config = auditedConfig(dir);
    const path = join(dir, ".grane", "audit.jsonl");
    const calls = [
      {
        ts: "2026-10-14T12:00:00.000Z",
        session_id: "sess-1",
        agent: "authoring",
        operation: "introspect" as const,
        connector: "postgres",
        target: { schema: "public" },
        sql: ["SELECT table_name FROM information_schema.tables WHERE table_schema = $1"],
        row_count: 3,
        duration_ms: 12,
        snapshot_hash: "aa".repeat(32),
      },
      {
        ts: "2026-10-14T12:00:01.000Z",
        session_id: "sess-1",
        agent: "authoring",
        operation: "relationships" as const,
        connector: "postgres",
        target: { schema: "public", table: "orders" },
        sql: ["SELECT conname FROM pg_constraint WHERE contype = 'f'"],
        row_count: 2,
        duration_ms: 4,
      },
      {
        ts: "2026-10-14T12:00:02.000Z",
        session_id: "sess-1",
        agent: "authoring",
        operation: "profile" as const,
        connector: "postgres",
        target: { schema: "public", table: "orders", column: "status" },
        sql: "SELECT COUNT(DISTINCT status) FROM orders",
        row_count: 4,
        duration_ms: 7,
        snapshot_hash: "bb".repeat(32),
        samples: [sampleValue, "completed"],
        rows: [{ status: sampleValue }],
        token: "SECRET_TOKEN",
      },
    ];
    for (const call of calls) {
      recordDiscoveryAudit(config, dir, call as Parameters<typeof recordDiscoveryAudit>[2]);
    }

    const raw = readFileSync(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw.trimEnd().split("\n")).toHaveLength(3);
    const events = readJsonl(path);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.operation)).toEqual(["introspect", "relationships", "profile"]);

    for (const event of events) {
      expect(event.kind).toBe("discovery");
      expect(event.read_only).toBe(true);
      expect(event.session_id).toBe("sess-1");
      expect(Array.isArray(event.sql)).toBe(true);
      expect((event.sql as string[]).length).toBeGreaterThan(0);
      expect(typeof event.row_count).toBe("number");
      expect(event).not.toHaveProperty("query");
      expect(event).not.toHaveProperty("samples");
      expect(event).not.toHaveProperty("rows");
      expect(event).not.toHaveProperty("values");
      expect(event).not.toHaveProperty("token");
      expect(JSON.stringify(event)).not.toContain(sampleValue);
      expect(JSON.stringify(event)).not.toContain("SECRET_TOKEN");
    }

    expect(events[0]!.sql).toEqual([
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1",
    ]);
    expect(events[0]!.row_count).toBe(3);
    expect(events[0]!.snapshot_hash).toBe("aa".repeat(32));
    expect(events[2]!.sql).toEqual(["SELECT COUNT(DISTINCT status) FROM orders"]);
    expect(events[2]!.target).toEqual({ schema: "public", table: "orders", column: "status" });
    expect(events[2]!.snapshot_hash).toBe("bb".repeat(32));
  });

  it("records an exploration-policy refusal as one discovery line", () => {
    const dir = tempProject();
    const config = auditedConfig(dir);
    recordDiscoveryAudit(config, dir, {
      ts: "2026-10-14T12:00:03.000Z",
      session_id: "sess-1",
      agent: "authoring",
      operation: "profile",
      connector: "postgres",
      target: { schema: "public", table: "customers", column: "email" },
      sql: [],
      row_count: 0,
      duration_ms: 1,
      refusal: {
        status: "column_not_permitted",
        message: "excluded from exploration by company policy.",
        requested: "customers.email",
      },
      http: { request_id: "req-disc", client_ip: "203.0.113.10", user_agent: "Cursor/1.0" },
    });
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(event).toEqual({
      ts: "2026-10-14T12:00:03.000Z",
      kind: "discovery",
      session_id: "sess-1",
      agent: "authoring",
      operation: "profile",
      connector: "postgres",
      target: { schema: "public", table: "customers", column: "email" },
      sql: [],
      row_count: 0,
      duration_ms: 1,
      read_only: true,
      refusal: {
        status: "column_not_permitted",
        message: "excluded from exploration by company policy.",
        requested: "customers.email",
      },
      request_id: "req-disc",
      client_ip: "203.0.113.10",
      user_agent: "Cursor/1.0",
    });
  });

  it("swallows a failed discovery audit append by default", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "blocked"), "not a directory");
    const config = auditedConfig(dir, { path: "blocked/audit.jsonl" });
    expect(() =>
      recordDiscoveryAudit(config, dir, {
        session_id: null,
        agent: null,
        operation: "introspect",
        connector: "duckdb",
        target: {},
        sql: ["SELECT 1"],
        row_count: 1,
        duration_ms: 0,
      }),
    ).not.toThrow();
  });

  it("refuses the discovery call when fail_closed and the audit append fails", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "blocked"), "not a directory");
    const config = auditedConfig(dir, { path: "blocked/audit.jsonl", fail_closed: true });
    try {
      recordDiscoveryAudit(config, dir, {
        session_id: "sess-1",
        agent: "authoring",
        operation: "introspect",
        connector: "postgres",
        target: { schema: "public" },
        sql: ["SELECT 1"],
        row_count: 1,
        duration_ms: 0,
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("config_error");
      expect((err as GraneError).message).toMatch(/fail_closed/);
    }
  });

  it("authoring audit events never include samples, drafts, or tokens", () => {
    const dir = tempProject();
    const config = auditedConfig(dir);
    recordAuthoringAudit(config, dir, {
      ts: "2026-10-14T15:00:00.000Z",
      operation: "proposal_created",
      session_id: "sess-1",
      agent: "anonymous",
      duration_ms: 9,
      commit: "a".repeat(40),
      branch: "grane/proposal/20261014-add-gmv",
      pr: "acme/shop#grane/proposal/20261014-add-gmv",
      samples: [sampleValue],
      token: "SECRET_TOKEN",
      draft_yaml: { "metrics.yml": sampleValue },
    } as Parameters<typeof recordAuthoringAudit>[2]);
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(event.kind).toBe("authoring");
    expect(event.operation).toBe("proposal_created");
    expect(event.commit).toBe("a".repeat(40));
    expect(event.branch).toBe("grane/proposal/20261014-add-gmv");
    expect(event.pr).toBe("acme/shop#grane/proposal/20261014-add-gmv");
    expect(event.agent).toBe("anonymous");
    expect(event).not.toHaveProperty("samples");
    expect(event).not.toHaveProperty("token");
    expect(event).not.toHaveProperty("draft_yaml");
    expect(event).not.toHaveProperty("query");
    expect(JSON.stringify(event)).not.toContain(sampleValue);
    expect(JSON.stringify(event)).not.toContain("SECRET_TOKEN");
    expect(authoringAuditEvent({
      operation: "profile_column",
      session_id: null,
      agent: null,
      duration_ms: 1,
      refusal: { status: "column_not_permitted", message: "excluded" },
    }).refusal?.status).toBe("column_not_permitted");
  });

  it("keeps query audit JSON bytes identical after adding discovery events", () => {
    const dir = tempProject();
    const path = join(dir, "query.jsonl");
    const event = {
      ts: "2026-09-03T00:00:00.000Z",
      agent: "finance" as string | null,
      kind: "query" as const,
      operation: "query" as const,
      query: {
        metrics: ["revenue"],
        dimensions: ["country"],
        time: { from: "2026-07-01", to: "2026-07-31" },
      },
      trust: "governed" as const,
      query_id: "q_fixed",
      sql: "SELECT 1",
      row_count: 1,
      duration_ms: 0,
    };
    appendAudit(event, { path });
    expect(readFileSync(path, "utf8")).toBe(
      '{"ts":"2026-09-03T00:00:00.000Z","agent":"finance","kind":"query","operation":"query","query":{"metrics":["revenue"],"dimensions":["country"],"time":{"from":"2026-07-01","to":"2026-07-31"}},"trust":"governed","query_id":"q_fixed","sql":"SELECT 1","row_count":1,"duration_ms":0}\n',
    );
  });

  it("does not add discovery fields onto kernel query audit lines", async () => {
    const dir = tempProject();
    const kernel = kernelWithAudit(dir, {}, { id: "finance" });
    await kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    const event = readJsonl(join(dir, ".grane", "audit.jsonl"))[0]!;
    expect(Object.keys(event)).toEqual([
      "ts",
      "agent",
      "kind",
      "operation",
      "query",
      "trust",
      "query_id",
      "sql",
      "row_count",
      "duration_ms",
    ]);
    expect(event).not.toHaveProperty("session_id");
    expect(event).not.toHaveProperty("connector");
    expect(event).not.toHaveProperty("read_only");
    expect(event).not.toHaveProperty("target");
    expect(event).not.toHaveProperty("snapshot_hash");
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
    expect(loaded.config.audit.fail_closed).toBe(false);
  });

  it("applies GRANE_AUDIT_PATH and GRANE_AUDIT_STDOUT from the environment", () => {
    const dir = tempProject();
    writeFileSync(join(dir, "grane.yml"), "connection: { type: postgres }\n");
    const prevPath = process.env.GRANE_AUDIT_PATH;
    const prevStdout = process.env.GRANE_AUDIT_STDOUT;
    const prevFail = process.env.GRANE_AUDIT_FAIL_CLOSED;
    process.env.GRANE_AUDIT_PATH = "/var/log/grane/audit.jsonl";
    process.env.GRANE_AUDIT_STDOUT = "1";
    process.env.GRANE_AUDIT_FAIL_CLOSED = "1";
    try {
      const loaded = loadConfig(dir);
      expect(loaded.config.audit.path).toBe("/var/log/grane/audit.jsonl");
      expect(loaded.config.audit.stdout).toBe(true);
      expect(loaded.config.audit.fail_closed).toBe(true);
    } finally {
      if (prevPath === undefined) delete process.env.GRANE_AUDIT_PATH;
      else process.env.GRANE_AUDIT_PATH = prevPath;
      if (prevStdout === undefined) delete process.env.GRANE_AUDIT_STDOUT;
      else process.env.GRANE_AUDIT_STDOUT = prevStdout;
      if (prevFail === undefined) delete process.env.GRANE_AUDIT_FAIL_CLOSED;
      else process.env.GRANE_AUDIT_FAIL_CLOSED = prevFail;
    }
  });
});
