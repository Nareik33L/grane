import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACTIVE_PIN_PATH,
  configuredBaseBranch,
  createProposal,
  loadServingConfig,
  readActivePin,
  resolveActiveRef,
  writeActivePin,
} from "../../src/authoring/git.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { SemanticModel } from "../../src/model/model.js";
import { buildMcpServer, AUTHORING_MCP_TOOLS, CORE_MCP_TOOLS } from "../../src/mcp/server.js";
import { GraneError } from "../../src/errors.js";
import { validateModel } from "../../src/validate/validate.js";
import * as publicApi from "../../src/index.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const demoAnalytics = join(dirname(fileURLToPath(import.meta.url)), "../../demo/analytics");

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

function readAudit(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".grane", "audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

  it("demo analytics without a pin matches today; temporal warning is the only extra validate finding", () => {
    const today = loadConfig(demoAnalytics);
    const serving = loadServingConfig(demoAnalytics);
    expect(serving.pin).toBeNull();
    expect(serving.files).toEqual(today.files);
    expect(serving.config).toEqual(today.config);

    const todayReport = validateModel(new SemanticModel(today.config));
    const servingReport = validateModel(new SemanticModel(serving.config));
    expect(servingReport).toEqual(todayReport);
    const extraCodes = [
      ...new Set(
        [...servingReport.issues, ...servingReport.metrics.flatMap((m) => m.issues)]
          .filter((issue) => issue.code !== "temporal_semi_additive_group_by")
          .map((issue) => issue.code),
      ),
    ].sort();
    const todayCodes = [
      ...new Set(
        [...todayReport.issues, ...todayReport.metrics.flatMap((m) => m.issues)]
          .filter((issue) => issue.code !== "temporal_semi_additive_group_by")
          .map((issue) => issue.code),
      ),
    ].sort();
    expect(extraCodes).toEqual(todayCodes);
  });

  it("unpinned existing YAML keeps temporal semi-additive group_by as a warning, not an error", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "grane.yml"),
      `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
metrics:
  on_hand:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    time_dimension: "\${orders.completed_at}"
    additive: semi
    semi_additive: { window: last, group_by: ["\${orders.completed_at}"] }
`,
    );
    const today = validateModel(new SemanticModel(loadConfig(dir).config));
    const serving = validateModel(new SemanticModel(loadServingConfig(dir).config));
    expect(serving).toEqual(today);
    expect(serving.ok).toBe(true);
    expect(serving.issues.some((i) => i.code === "temporal_semi_additive_group_by" && i.severity === "warning")).toBe(
      true,
    );
    expect(serving.issues.some((i) => i.severity === "error")).toBe(false);
    const generated = validateModel(new SemanticModel(loadServingConfig(dir).config), undefined, { generated: true });
    expect(generated.ok).toBe(false);
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

  it("accepts approved_by names that contain the substring agent", () => {
    const dir = initRepo();
    const commit = git(dir, ["rev-parse", "HEAD"]);
    const pin = writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "Reagent Smith",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    expect(pin.approved_by).toBe("Reagent Smith");
    const serving = loadServingConfig(dir);
    expect(serving.pin?.approved_by).toBe("Reagent Smith");
    expect(serving.pin?.commit).toBe(commit);
  });

  it("fails closed when the pin ref is not refs/heads/<configured base> or the commit is not a full 40-hex SHA", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["tag", "v1.0"]);
    const valid = {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    };
    writeFileSync(join(dir, ACTIVE_PIN_PATH), `${JSON.stringify({ ...valid, ref: "HEAD" }, null, 2)}\n`);
    expect(() => loadServingConfig(dir)).toThrow(/configured base branch "main" under refs\/heads/);
    writeFileSync(join(dir, ACTIVE_PIN_PATH), `${JSON.stringify({ ...valid, ref: "v1.0" }, null, 2)}\n`);
    expect(() => loadServingConfig(dir)).toThrow(/refs\/heads/);
    writeFileSync(join(dir, ACTIVE_PIN_PATH), `${JSON.stringify({ ...valid, commit: main.slice(0, 12) }, null, 2)}\n`);
    expect(() => loadServingConfig(dir)).toThrow(/full 40-character hex SHA/);
    writeFileSync(join(dir, ACTIVE_PIN_PATH), `${JSON.stringify({ ...valid, commit: "main" }, null, 2)}\n`);
    expect(() => loadServingConfig(dir)).toThrow(/full 40-character hex SHA/);
  });

  it("audits pin write, load, and refuse with a reason", () => {
    const dir = initRepo();
    const commit = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const written = readAudit(dir).find((event) => event.kind === "pin" && event.operation === "write");
    expect(written).toMatchObject({ kind: "pin", operation: "write", ref: "main", commit, approved_by: "octocat" });

    loadServingConfig(dir);
    const loaded = readAudit(dir).find((event) => event.kind === "pin" && event.operation === "load");
    expect(loaded).toMatchObject({ kind: "pin", operation: "load", ref: "main", commit, approved_by: "octocat" });

    writeFileSync(
      join(dir, ACTIVE_PIN_PATH),
      `${JSON.stringify({ ref: "HEAD", commit, approved_by: "octocat", approved_at: "2026-10-14T12:00:00.000Z" }, null, 2)}\n`,
    );
    expect(() => loadServingConfig(dir)).toThrow(/refs\/heads/);
    const refused = readAudit(dir).filter((event) => event.kind === "pin" && event.operation === "refuse");
    expect(refused.length).toBeGreaterThan(0);
    expect(String(refused[refused.length - 1]!.reason)).toMatch(/configured base branch "main" under refs\/heads/);
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
    const server = buildMcpServer(kernel, { authoring: true, transport: "stdio", homeDir: dir });
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

  it("writeActivePin is only called from CLI/TTY setup and git rollback, never MCP or authoring tools", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith(".ts")) files.push(path);
      }
    };
    walk(srcRoot);
    const hits = files.filter((path) => readFileSync(path, "utf8").includes("writeActivePin"));
    const rel = hits.map((path) => path.slice(srcRoot.length + 1).replaceAll("\\", "/")).sort();
    expect(rel).toEqual(["authoring/git.ts", "setup/run.ts"]);
    expect(readFileSync(join(srcRoot, "setup/run.ts"), "utf8")).toMatch(/Activation requires a TTY/);
    expect(readFileSync(join(srcRoot, "mcp/authoring.ts"), "utf8")).not.toMatch(/writeActivePin/);
    expect(readFileSync(join(srcRoot, "authoring/tools.ts"), "utf8")).not.toMatch(/writeActivePin/);
    expect(readFileSync(join(srcRoot, "authoring/git.ts"), "utf8")).toMatch(/renameSync/);
    expect(readFileSync(join(srcRoot, "authoring/git.ts"), "utf8")).toMatch(/function atomicWriteFile/);
  });

  it("src/mcp/** must not import or call approveProposal, rollbackPin, rejectProposal, or deleteProposalBranch", () => {
    const banned = /\b(?:approveProposal|rollbackPin|rejectProposal|deleteProposalBranch)\b/;
    const mcpRoot = join(srcRoot, "mcp");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(mcpRoot);
    const hits = files.filter((path) => banned.test(readFileSync(path, "utf8")));
    expect(hits.map((path) => path.slice(mcpRoot.length + 1).replaceAll("\\", "/"))).toEqual([]);
  });
});

describe("first pin is the configured base branch, not HEAD", () => {
  it("refuses to pin a feature-branch HEAD and pins main's tip instead", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    git(dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(dir, ["update-ref", "refs/remotes/origin/main", main]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(dir, "metrics.yml"), EXTRA_METRIC);
    git(dir, ["add", "metrics.yml"]);
    git(dir, ["commit", "-m", "feature work"]);
    const feature = git(dir, ["rev-parse", "HEAD"]);
    expect(feature).not.toBe(main);
    expect(configuredBaseBranch(dir)).toBe("main");
    expect(resolveActiveRef(dir)).toEqual({ branch: "main", commit: main, pinned: false });

    expect(() =>
      writeActivePin(dir, {
        ref: "feature",
        commit: feature,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      }),
    ).toThrow(/not HEAD|pin ref must be "main"/);

    expect(() =>
      writeActivePin(dir, {
        ref: "main",
        commit: feature,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      }),
    ).toThrow(/not reachable from "main"/);

    const pin = writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    expect(pin.ref).toBe("main");
    expect(pin.commit).toBe(main);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
  });

  it("refuses when there is no established base; HEAD-committed base_branch is not enough", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "develop"]);
    git(dir, ["config", "user.email", "test@grane.dev"]);
    git(dir, ["config", "user.name", "Grane Test"]);
    writeFileSync(join(dir, ".gitignore"), ".grane/\n");
    writeProject(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial on develop"]);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("develop");
    expect(() => configuredBaseBranch(dir)).toThrow(/Cannot determine the configured base branch|established base/);

    writeFileSync(
      join(dir, "grane.yml"),
      `project: { name: shop, timezone: UTC, base_branch: develop }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
`,
    );
    git(dir, ["add", "grane.yml"]);
    git(dir, ["commit", "-m", "set project.base_branch on HEAD only"]);
    expect(() => configuredBaseBranch(dir)).toThrow(/established base|grane setup/);

    git(dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(dir, ["update-ref", "refs/remotes/origin/develop", git(dir, ["rev-parse", "HEAD"])]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    expect(configuredBaseBranch(dir)).toBe("develop");
    const commit = git(dir, ["rev-parse", "HEAD"]);
    const pin = writeActivePin(dir, {
      ref: "develop",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    expect(pin.ref).toBe("develop");
    expect(loadServingConfig(dir).pin?.ref).toBe("develop");
  });

  it("refuses a develop-only feature commit of base_branch: feature", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "develop"]);
    git(dir, ["config", "user.email", "test@grane.dev"]);
    git(dir, ["config", "user.name", "Grane Test"]);
    writeFileSync(join(dir, ".gitignore"), ".grane/\n");
    writeProject(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial on develop"]);
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(
      join(dir, "grane.yml"),
      `project: { name: shop, timezone: UTC, base_branch: feature }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
`,
    );
    git(dir, ["add", "grane.yml"]);
    git(dir, ["commit", "-m", "claim feature is the base"]);
    expect(() => configuredBaseBranch(dir)).toThrow(/established base|grane setup|HEAD or a feature branch/);
  });

  it("does not read base_branch from a feature branch's committed tree", () => {
    const dir = initRepo();
    git(dir, ["checkout", "-b", "feature"]);
    writeFileSync(
      join(dir, "grane.yml"),
      `project: { name: shop, timezone: UTC, base_branch: feature }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
`,
    );
    git(dir, ["add", "grane.yml"]);
    git(dir, ["commit", "-m", "claim feature is the base"]);
    expect(configuredBaseBranch(dir)).toBe("main");
    expect(() =>
      writeActivePin(dir, {
        ref: "feature",
        commit: git(dir, ["rev-parse", "HEAD"]),
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      }),
    ).toThrow(/not HEAD|pin ref must be "main"/);
  });

  it("refuses origin/HEAD that disagrees with local main when no base_branch is committed", () => {
    const dir = initRepo();
    git(dir, ["branch", "develop", "main"]);
    git(dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(dir, ["update-ref", "refs/remotes/origin/develop", git(dir, ["rev-parse", "main"])]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    expect(() => configuredBaseBranch(dir)).toThrow(/origin\/HEAD is "develop"|no project\.base_branch is committed/);
  });

  it("refuses git replace objects", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    const tree = git(dir, ["rev-parse", `${main}^{tree}`]);
    const fake = git(dir, ["commit-tree", tree, "-p", main, "-m", "replace"]);
    git(dir, ["replace", main, fake]);
    expect(() => configuredBaseBranch(dir)).toThrow(/refs\/replace|git replace/);
  });

  it("refuses a symlinked .grane/ directory", () => {
    const dir = initRepo();
    const outside = tempDir();
    rmSync(join(dir, ".grane"), { recursive: true, force: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(dir, ".grane"));
    expect(() => readActivePin(dir)).toThrow(/symlink|regular directory/);
    expect(() =>
      writeActivePin(dir, {
        ref: "main",
        commit: git(dir, ["rev-parse", "main"]),
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      }),
    ).toThrow(/symlink|regular directory|fail_closed/);
  });
});

describe("merged proposal on a base that already had YAML", () => {
  it("still pins and validates after merge", () => {
    const dir = initRepo(`metrics:
  orders:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: approved
`);
    const proposal = createProposal(dir, {
      slug: "add-revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: {
        "metrics.yml": `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
`,
      },
    });
    git(dir, [
      "merge",
      "--no-ff",
      "-m",
      `Merge pull request #1 from ${proposal.branch}\n\nGrane-Proposal: ${proposal.id}`,
      proposal.branch,
    ]);
    const merged = git(dir, ["rev-parse", "HEAD"]);
    const pin = writeActivePin(dir, {
      ref: "main",
      commit: merged,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    expect(pin.commit).toBe(merged);
    const serving = loadServingConfig(dir);
    expect(Object.keys(serving.config.metrics).sort()).toEqual(["orders", "revenue"]);
    const report = validateModel(new SemanticModel(serving.config));
    expect(report.ok).toBe(true);
    expect(report.issues.some((i) => i.severity === "error")).toBe(false);
    const catalog = new GraneKernel(serving.config, { activePin: serving.pin }).governedCatalog();
    expect(catalog.metrics.map((m) => m.name).sort()).toEqual(["orders", "revenue"]);
    expect(catalog.active?.commit).toBe(merged);
  });
});

