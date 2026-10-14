import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AUTHORING_MCP_TOOLS,
  CORE_MCP_TOOLS,
  buildMcpServer,
  type BuildMcpServerOptions,
} from "../../src/mcp/server.js";
import { GraneKernel } from "../../src/kernel.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { DatabaseSchema, ExecutedRows, WarehouseConnector } from "../../src/connectors/types.js";
import { exampleConfig } from "../fixtures.js";
import { ACTIVE_PIN_PATH, readActivePin } from "../../src/authoring/git.js";
import { loadSession, sessionPath } from "../../src/authoring/session.js";
import { GraneError } from "../../src/errors.js";

const temps: string[] = [];
const SECRET_SAMPLE = "SECRET_SAMPLE_VALUE";
const SECRET_PASSWORD = "SUPERSECRET_PASSWORD";

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-mcp-auth-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

const SCHEMA: DatabaseSchema = {
  schemaName: "public",
  tables: [
    {
      schema: "public",
      name: "customers",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "email", dataType: "text", nullable: true },
        { name: "status", dataType: "text", nullable: true },
      ],
    },
    {
      schema: "public",
      name: "orders",
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "customer_id", dataType: "integer", nullable: false },
        { name: "net_amount", dataType: "numeric", nullable: true },
        { name: "gross_amount", dataType: "numeric", nullable: true },
        { name: "completed_at", dataType: "timestamp", nullable: true },
      ],
    },
  ],
  foreignKeys: [
    {
      constraintName: "orders_customer_id_fkey",
      table: "orders",
      column: "customer_id",
      refTable: "customers",
      refColumn: "id",
    },
  ],
};

function recordingConnector(): WarehouseConnector & { sql: string[] } {
  const sql: string[] = [];
  return {
    sql,
    type: "postgres",
    dialect: getDialect("postgres"),
    async query(statement: string): Promise<ExecutedRows> {
      sql.push(statement);
      if (/COUNT\s*\(\s*DISTINCT/i.test(statement)) {
        return { columns: ["n"], rows: [{ n: 2 }] };
      }
      return { columns: ["v"], rows: [{ v: SECRET_SAMPLE }, { v: 10 }] };
    },
    async introspect() {
      return SCHEMA;
    },
    async close() {},
  };
}

function kernelFor(dir: string, extra: Record<string, unknown> = {}, grant?: Parameters<GraneKernel["bindAgent"]>[0]) {
  const config = exampleConfig({
    connection: {
      type: "postgres",
      schema: "public",
      url: `postgres://grane:${SECRET_PASSWORD}@localhost:5432/grane_demo`,
      password: SECRET_PASSWORD,
    },
    audit: { enabled: true, path: ".grane/audit.jsonl" },
    exploration: { enabled: true, mode: "denylist", exclude: ["*.email"] },
    ...extra,
  });
  const k = new GraneKernel(config, { projectDir: dir, connector: recordingConnector() });
  return grant ? k.bindAgent(grant) : k;
}

async function connectClient(kernel: GraneKernel, options?: BuildMcpServerOptions) {
  const server = buildMcpServer(kernel, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "grane-authoring-test", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function parseTool(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> | unknown[] {
  const content = result.content as { type: string; text: string }[];
  const text = content[0]!.text;
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = 0;
  if (startArr >= 0 && (startObj < 0 || startArr < startObj)) start = startArr;
  else if (startObj >= 0) start = startObj;
  return JSON.parse(text.slice(start)) as Record<string, unknown> | unknown[];
}

async function listNames(kernel: GraneKernel, options?: BuildMcpServerOptions): Promise<string[]> {
  const { client, close } = await connectClient(kernel, options);
  try {
    const listed = await client.listTools();
    return listed.tools.map((tool) => tool.name).sort();
  } finally {
    await close();
  }
}

function walkText(dir: string): string {
  try {
    if (!statSync(dir).isDirectory()) return "";
  } catch {
    return "";
  }
  const chunks: string[] = [];
  const walk = (current: string) => {
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      const st = statSync(path);
      if (st.isDirectory()) walk(path);
      else chunks.push(readFileSync(path, "utf8"));
    }
  };
  walk(dir);
  return chunks.join("\n");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  writeFileSync(
    join(dir, "grane.yml"),
    "project: { name: shop }\nconnection: { type: postgres, schema: public }\n",
  );
  writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

const MAIN_MCP_TOOLS = ["catalog", "explain", "query", "validate"];

describe("MCP tool list vs main", () => {
  it("without the authoring flag matches main's four-tool list", async () => {
    expect([...CORE_MCP_TOOLS].sort()).toEqual([...MAIN_MCP_TOOLS].sort());
    const dir = tempDir();
    const names = await listNames(kernelFor(dir), { transport: "stdio" });
    expect(names).toEqual([...MAIN_MCP_TOOLS].sort());
  });

  it("authoring.enabled with mode=local stays four tools on HTTP", async () => {
    const dir = tempDir();
    const names = await listNames(
      kernelFor(dir, { authoring: { enabled: true, mode: "local" } }),
      { transport: "http" },
    );
    expect(names).toEqual([...MAIN_MCP_TOOLS].sort());
  });

  it("authoring.enabled with mode=local registers tools on stdio", async () => {
    const dir = tempDir();
    const names = await listNames(
      kernelFor(dir, { authoring: { enabled: true, mode: "local" } }),
      { transport: "stdio" },
    );
    expect(names).toEqual([...MAIN_MCP_TOOLS, ...AUTHORING_MCP_TOOLS].sort());
  });

  it("authoring.enabled with mode=shared registers tools on HTTP", async () => {
    const dir = tempDir();
    const names = await listNames(
      kernelFor(dir, { authoring: { enabled: true, mode: "shared" } }),
      { transport: "http" },
    );
    expect(names).toEqual([...MAIN_MCP_TOOLS, ...AUTHORING_MCP_TOOLS].sort());
  });

  it("--authoring registers the nine authoring tools", async () => {
    const dir = tempDir();
    const names = await listNames(kernelFor(dir), { authoring: true, transport: "stdio" });
    for (const name of AUTHORING_MCP_TOOLS) {
      expect(names).toContain(name);
    }
    expect(names).toContain("query");
  });

  it("HTTP without --authoring or shared mode matches main's four-tool list", async () => {
    const dir = tempDir();
    const names = await listNames(kernelFor(dir), { transport: "http" });
    expect(names).toEqual([...MAIN_MCP_TOOLS].sort());
  });

  it("--authoring on HTTP still advertises the nine tools (calls require an agent)", async () => {
    const dir = tempDir();
    const names = await listNames(kernelFor(dir), { authoring: true, transport: "http" });
    expect(names).toEqual([...MAIN_MCP_TOOLS, ...AUTHORING_MCP_TOOLS].sort());
  });
});

describe("authoring MCP tools", () => {
  it("has no SQL argument and never calls kernel.query", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "../../src");
    const mcp = readFileSync(join(root, "mcp/authoring.ts"), "utf8");
    const tools = readFileSync(join(root, "authoring/tools.ts"), "utf8");
    expect(mcp).not.toMatch(/\bsql:\s*z\./);
    expect(mcp).not.toMatch(/kernel\.query/);
    expect(tools).not.toMatch(/kernel\.query/);
    expect(tools).not.toMatch(/writeActivePin/);
    expect(tools).not.toMatch(/connector\.query/);
    expect(mcp).not.toMatch(/runDiscoveryQuery/);
    expect(tools).toMatch(/createDiscovery/);
  });

  it("HTTP calls refuse without an authenticated agent", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "http" });
    try {
      const result = await client.callTool({ name: "authoring_start", arguments: {} });
      expect(result.isError).toBe(true);
      const payload = parseTool(result) as Record<string, unknown>;
      expect(payload.status).toBe("config_error");
      expect(String(payload.message)).toMatch(/authenticated agent/);
    } finally {
      await close();
    }
  });

  it("HTTP calls succeed with an authenticated agent", async () => {
    const dir = tempDir();
    const k = kernelFor(dir).bindAgent({
      id: "author",
      metrics: null,
      dimensions: null,
      exploration: true,
      explorationExclude: [],
    });
    const { client, close } = await connectClient(k, { authoring: true, transport: "http" });
    try {
      const result = await client.callTool({ name: "authoring_start", arguments: {} });
      expect(result.isError).toBeFalsy();
      const payload = parseTool(result) as Record<string, unknown>;
      expect((payload.session as { id: string }).id).toBeTruthy();
    } finally {
      await close();
    }
  });

  it("discover_schema and profile_column go through createDiscovery; samples stay transient", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "stdio" });
    try {
      const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as Record<string, unknown>;
      const sessionId = (started.session as { id: string }).id;
      const discovered = parseTool(
        await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } }),
      ) as Record<string, unknown>;
      expect(discovered.session_id).toBe(sessionId);
      const tables = (discovered.schema as { tables: { name: string }[] }).tables.map((t) => t.name).sort();
      expect(tables).toEqual(["customers", "orders"]);
      const ambiguities = discovered.open_ambiguities as { candidates: string[] }[];
      expect(ambiguities.some((item) => item.candidates.includes("orders.net_amount"))).toBe(true);

      const profile = parseTool(
        await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "orders", column: "net_amount" },
        }),
      ) as Record<string, unknown>;
      expect(profile.samples).toContain(SECRET_SAMPLE);

      const excluded = await client.callTool({
        name: "profile_column",
        arguments: { session_id: sessionId, table: "customers", column: "email" },
      });
      expect(excluded.isError).toBe(true);
      expect((parseTool(excluded) as Record<string, unknown>).status).toBe("column_not_permitted");

      const persisted = walkText(join(dir, ".grane"));
      expect(persisted).not.toContain(SECRET_SAMPLE);
      expect(persisted).not.toContain(SECRET_PASSWORD);
      expect(readFileSync(sessionPath(dir, sessionId), "utf8")).not.toContain(SECRET_SAMPLE);
      const session = loadSession(dir, sessionId);
      expect(session).not.toHaveProperty("samples");

      const audit = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8");
      expect(audit).not.toContain(SECRET_SAMPLE);
      const events = audit
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; operation: string });
      expect(events.every((event) => event.kind === "discovery")).toBe(true);
      expect(events.map((event) => event.operation).sort()).toEqual(
        ["introspect", "profile", "profile", "relationships"].sort(),
      );
    } finally {
      await close();
    }
  });

  it("honours authoring.sampling=false (no samples)", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(
      kernelFor(dir, { authoring: { enabled: true, sampling: false } }),
      { transport: "stdio" },
    );
    try {
      const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as Record<string, unknown>;
      const sessionId = (started.session as { id: string }).id;
      const profile = parseTool(
        await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "orders", column: "net_amount" },
        }),
      ) as Record<string, unknown>;
      expect(profile.samples).toEqual([]);
    } finally {
      await close();
    }
  });

  it("draft definitions cannot be queried; submit_proposal uses the git library and does not pin", async () => {
    const dir = initRepo();
    const k = kernelFor(dir);
    const { client, close } = await connectClient(k, { authoring: true, transport: "stdio" });
    try {
      const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as Record<string, unknown>;
      const sessionId = (started.session as { id: string }).id;
      await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } });
      const listed = parseTool(await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } }));
      expect(Array.isArray(listed)).toBe(true);
      const amb = (listed as { id: string; candidates: string[] }[])[0]!;
      expect(amb.candidates).toContain("orders.net_amount");
      await client.callTool({
        name: "resolve_ambiguity",
        arguments: { session_id: sessionId, id: amb.id, chosen: "orders.net_amount" },
      });
      await client.callTool({
        name: "record_term",
        arguments: { session_id: sessionId, term: "gmv", answer: "Gross merchandise value from orders." },
      });
      const proposed = parseTool(await client.callTool({ name: "propose_definitions", arguments: { session_id: sessionId } })) as Record<string, unknown>;
      const draft = (proposed.draft_yaml as Record<string, string> | undefined) ?? loadSession(dir, sessionId).draft_yaml;
      expect(draft["metrics.yml"]).toMatch(/status:\s*experimental/);
      expect(draft["metrics.yml"]).not.toContain(SECRET_SAMPLE);

      const preview = parseTool(await client.callTool({ name: "preview_yaml", arguments: { session_id: sessionId } })) as Record<string, unknown>;
      expect(preview.files).toBeTruthy();
      expect((preview.validation as { ok: boolean }).ok).toBeDefined();

      await expect(k.query({ metrics: ["gmv"] })).rejects.toBeInstanceOf(GraneError);
      await expect(k.query({ metrics: ["gmv"] })).rejects.toMatchObject({
        refusal: { status: "undefined_metric" },
      });

      const metricsBefore = readFileSync(join(dir, "metrics.yml"), "utf8");
      const headBefore = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      const submitted = parseTool(
        await client.callTool({
          name: "submit_proposal",
          arguments: { session_id: sessionId, slug: "add-gmv" },
        }),
      ) as Record<string, unknown>;
      expect((submitted.proposal as { branch: string }).branch).toMatch(/^grane\/proposal\//);
      expect((submitted.github as { command: string }).command).toMatch(/^gh pr create/);
      expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toBe(metricsBefore);
      expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(headBefore);
      expect(readActivePin(dir)).toBeNull();
      expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    } finally {
      await close();
    }
  });
});
