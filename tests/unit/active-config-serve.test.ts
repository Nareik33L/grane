import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACTIVE_PIN_PATH,
  createProposal,
  loadServingConfig,
  readActivePin,
  writeActivePin,
} from "../../src/authoring/git.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { buildMcpServer, AUTHORING_MCP_TOOLS, CORE_MCP_TOOLS } from "../../src/mcp/server.js";
import { GraneError } from "../../src/errors.js";
import * as publicApi from "../../src/index.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-active-serve-"));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

const GRANE_YML = `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
`;

const METRICS_YML = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
`;

const EXTRA_METRIC = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
  leaked:
    entity: order
    type: count
    sql: "\${orders.id}"
`;

function writeProject(dir: string, metrics = METRICS_YML): void {
  mkdirSync(join(dir, ".grane"), { recursive: true });
  writeFileSync(join(dir, "grane.yml"), GRANE_YML);
  writeFileSync(join(dir, "metrics.yml"), metrics);
}

function initRepo(metrics = METRICS_YML): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  writeProject(dir, metrics);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial config"]);
  return dir;
}

describe("loadServingConfig without a pin (compat)", () => {
  it("matches loadConfig on a project with no git and no pin", async () => {
    const dir = tempDir();
    writeProject(dir);
    const today = loadConfig(dir);
    const serving = loadServingConfig(dir);
    expect(serving.pin).toBeNull();
    expect(serving.files).toEqual(today.files);
    expect(serving.projectDir).toEqual(today.projectDir);
    expect(serving.config).toEqual(today.config);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);

    const todayKernel = new GraneKernel(today.config, { projectDir: today.projectDir });
    const servingKernel = new GraneKernel(serving.config, {
      projectDir: serving.projectDir,
      activePin: serving.pin,
    });
    expect(JSON.stringify(await servingKernel.catalog())).toBe(JSON.stringify(await todayKernel.catalog()));
    expect(await servingKernel.catalog()).not.toHaveProperty("active");
    expect((await servingKernel.catalog()).server).not.toHaveProperty("active");
  });

  it("matches loadConfig in a git repo that has not been pinned", async () => {
    const dir = initRepo();
    const today = loadConfig(dir);
    const serving = loadServingConfig(dir);
    expect(serving.pin).toBeNull();
    expect(serving.config).toEqual(today.config);
    expect(JSON.stringify(await new GraneKernel(serving.config).catalog())).toBe(
      JSON.stringify(await new GraneKernel(today.config).catalog()),
    );
  });
});

describe("loadServingConfig with a pin", () => {
  it("serves the pinned commit so uncommitted edits do not affect the model", async () => {
    const dir = initRepo();
    const commit = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });

    writeFileSync(join(dir, "metrics.yml"), EXTRA_METRIC);
    const working = loadConfig(dir);
    expect(Object.keys(working.config.metrics).sort()).toEqual(["leaked", "revenue"]);

    const serving = loadServingConfig(dir);
    expect(serving.pin?.commit).toBe(commit);
    expect(Object.keys(serving.config.metrics)).toEqual(["revenue"]);
    expect(serving.config.metrics.leaked).toBeUndefined();

    const kernel = new GraneKernel(serving.config, { projectDir: serving.projectDir, activePin: serving.pin });
    const catalog = await kernel.catalog();
    expect(catalog.active).toEqual({
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    expect(catalog.server.active).toEqual({ ref: "main", commit });
    expect(catalog.metrics.map((m) => m.name)).toEqual(["revenue"]);
    expect(catalog.metrics.some((m) => m.name === "leaked")).toBe(false);

    const server = buildMcpServer(kernel, { transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "grane-catalog-pin", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "catalog", arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]!.text;
      const payload = JSON.parse(text.slice(text.indexOf("{"))) as {
        active?: { commit: string };
        metrics: { name: string }[];
      };
      expect(payload.active?.commit).toBe(commit);
      expect(payload.metrics.map((m) => m.name)).toEqual(["revenue"]);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("fails closed on a malformed pin with a clear error", () => {
    const dir = initRepo();
    writeFileSync(join(dir, ACTIVE_PIN_PATH), "{not json");
    expect(() => loadServingConfig(dir)).toThrow(GraneError);
    expect(() => loadServingConfig(dir)).toThrow(/Invalid \.grane\/active\.json/);
    expect(() => loadServingConfig(dir)).toThrow(/Expected \{ref, commit, approved_by, approved_at\}/);
    expect(() => loadServingConfig(dir)).toThrow(/Serve refuses to start/);

    writeFileSync(join(dir, ACTIVE_PIN_PATH), JSON.stringify({ ref: "main" }));
    expect(() => loadServingConfig(dir)).toThrow(/Invalid \.grane\/active\.json/);
    expect(() => loadServingConfig(dir)).toThrow(/commit/);
    expect(() => loadServingConfig(dir)).toThrow(/Serve refuses to start/);
  });

  it("fails closed when the pinned commit is not in the repository", () => {
    const dir = initRepo();
    writeFileSync(
      join(dir, ACTIVE_PIN_PATH),
      `${JSON.stringify(
        {
          ref: "main",
          commit: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
          approved_by: "octocat",
          approved_at: "2026-10-14T12:00:00.000Z",
        },
        null,
        2,
      )}\n`,
    );
    expect(() => loadServingConfig(dir)).toThrow(GraneError);
    expect(() => loadServingConfig(dir)).toThrow(/Pinned commit "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"/);
    expect(() => loadServingConfig(dir)).toThrow(/not in this repository/);
    expect(() => loadServingConfig(dir)).toThrow(/Serve refuses to start/);
  });
});

describe("MCP and authoring cannot write the pin", () => {
  it("exports loadServingConfig and does not expose a pin-write MCP tool", async () => {
    expect(publicApi).toHaveProperty("loadServingConfig");
    expect(publicApi.ACTIVE_PIN_PATH).toBe(".grane/active.json");

    const dir = initRepo();
    const loaded = loadServingConfig(dir);
    const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir, activePin: loaded.pin });
    const server = buildMcpServer(kernel, { authoring: true, transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "grane-pin-test", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
      expect(names).toEqual([...CORE_MCP_TOOLS, ...AUTHORING_MCP_TOOLS].sort());
      expect(names.some((name) => /activate|approve|pin|merge|write_active|rollback/.test(name))).toBe(false);
      for (const banned of ["write_active_pin", "activate", "pin", "rollback"]) {
        try {
          const result = await client.callTool({ name: banned, arguments: {} });
          expect(result.isError, `MCP exposed ${banned}`).toBe(true);
        } catch {
          // unknown tool — expected
        }
      }
      expect(readActivePin(dir)).toBeNull();
      expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  it("createProposal refuses .grane/active.json", () => {
    const dir = initRepo();
    expect(() =>
      createProposal(dir, {
        slug: "agent-pin",
        files: {
          ".grane/active.json": JSON.stringify({
            ref: "main",
            commit: "deadbeef",
            approved_by: "agent",
            approved_at: "now",
          }),
        },
      }),
    ).toThrow(/\.grane/);
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
  });

  it("loadServingConfig does not write the pin", () => {
    const dir = initRepo();
    loadServingConfig(dir);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    const commit = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const before = readFileSync(join(dir, ACTIVE_PIN_PATH), "utf8");
    loadServingConfig(dir);
    expect(readFileSync(join(dir, ACTIVE_PIN_PATH), "utf8")).toBe(before);
  });
});
