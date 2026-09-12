import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeInitProject } from "../../src/cli/init-project.js";
import { DEMO_QUESTION, type DemoResult } from "../../src/demo/run.js";
import {
  isGraneSourceTree,
  maskDatabaseUrl,
  parseOwnDatabaseUrl,
  persistOwnConnection,
} from "../../src/setup/connection.js";
import { OWN_QUESTION, SETUP_BANNER } from "../../src/setup/copy.js";
import { scriptedPrompter } from "../../src/setup/prompts.js";
import { runSetup } from "../../src/setup/run.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-setup-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const quiet = {
  log: () => undefined,
  error: () => undefined,
};

function stubDemo(projectDir: string): DemoResult {
  return {
    projectDir,
    warehousePath: join(projectDir, "warehouse.duckdb"),
    investigation: {
      periods: { last: { from: "2026-08-01", to: "2026-08-31" }, previous: { from: "2026-07-01", to: "2026-07-31" } },
      revenueLast: 1,
      revenuePrevious: 1,
      revenueChangePct: 0,
      byCountry: [],
      failures: [],
      transcript: "stub",
      generatedSql: "SELECT 1",
    },
    productCategoryStatus: "unsafe_query",
    emailStatus: "column_not_permitted",
    generatedSql: "SELECT 1",
  };
}

describe("parseOwnDatabaseUrl", () => {
  it("accepts postgres and postgresql URLs", () => {
    expect(parseOwnDatabaseUrl("postgres://ro:x@db:5432/app").type).toBe("postgres");
    expect(parseOwnDatabaseUrl("postgresql://ro@db/app").type).toBe("postgres");
  });

  it("writes mysql and clickhouse from URL without inventing engines", () => {
    expect(parseOwnDatabaseUrl("mysql://ro:x@db:3306/app").type).toBe("mysql");
    expect(parseOwnDatabaseUrl("clickhouse://ro:x@db:8123/app").type).toBe("clickhouse");
  });

  it("refuses cloud engines and junk", () => {
    expect(() => parseOwnDatabaseUrl("snowflake://acct")).toThrow(/Unsupported URL scheme/);
    expect(() => parseOwnDatabaseUrl("not-a-url")).toThrow(/Not a valid URL/);
    expect(() => parseOwnDatabaseUrl("")).toThrow(/required/);
  });

  it("masks credentials in log lines", () => {
    expect(maskDatabaseUrl("postgres://ro:s3cret@db:5432/app")).toBe("postgres://ro:***@db:5432/app");
  });
});

describe("persistOwnConnection", () => {
  it("rewrites the connection block to the given URL", () => {
    const dir = tempDir();
    writeInitProject(dir);
    persistOwnConnection(dir, { type: "postgres", url: "postgres://ro:x@db:5432/app" });
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*postgres/);
    expect(yaml).toContain('url: "postgres://ro:x@db:5432/app"');
    expect(yaml).not.toContain("${DATABASE_URL}");
  });
});

describe("isGraneSourceTree", () => {
  it("detects the package root shape and not a blank folder", () => {
    const dir = tempDir();
    expect(isGraneSourceTree(dir)).toBe(false);
    mkdirSync(join(dir, "demo"));
    mkdirSync(join(dir, "src", "cli"), { recursive: true });
    writeFileSync(join(dir, "package.json"), "{}");
    writeFileSync(join(dir, "src", "cli", "index.ts"), "");
    expect(isGraneSourceTree(dir)).toBe(true);
  });
});

describe("runSetup", () => {
  it("refuses a non-TTY session without --yes", async () => {
    await expect(
      runSetup({ stdinIsTty: false, io: quiet }),
    ).rejects.toThrow(/Not a terminal/);
  });

  it("requires --path when --yes is set", async () => {
    await expect(runSetup({ yes: true, stdinIsTty: false, io: quiet })).rejects.toThrow(/--path/);
  });

  it("demo path builds via runDemo, registers MCP, and prints the revenue-drop question", async () => {
    const home = tempDir();
    const workspace = tempDir();
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const logs: string[] = [];
    const result = await runSetup({
      yes: true,
      path: "demo",
      dir: demoDir,
      connect: "cursor",
      stdinIsTty: false,
      homeDir: home,
      workspaceDir: workspace,
      cwd: workspace,
      io: { log: (line) => logs.push(line), error: () => undefined },
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.path).toBe("demo");
    expect(result.projectDir).toBe(demoDir);
    expect(result.warehouse).toBe("duckdb");
    expect(result.client).toBe("cursor");
    expect(result.question).toBe(DEMO_QUESTION);
    expect(result.connect?.path).toBe(join(workspace, ".cursor", "mcp.json"));
    expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(true);
    expect(logs.join("\n")).toContain("You're ready.");
    expect(logs.join("\n")).toContain(DEMO_QUESTION);
    expect(logs.join("\n")).toContain(SETUP_BANNER.split("\n")[0]);
  });

  it("own path writes a project, persists the URL, validates offline, and connects", async () => {
    const home = tempDir();
    const workspace = tempDir();
    const dir = tempDir();
    const result = await runSetup({
      yes: true,
      path: "own",
      dir,
      url: "postgres://ro:x@localhost:5432/app",
      connect: "cursor",
      offline: true,
      stdinIsTty: false,
      homeDir: home,
      workspaceDir: workspace,
      cwd: workspace,
      env: { ...process.env },
      io: quiet,
    });
    expect(result.path).toBe("own");
    expect(result.projectDir).toBe(dir);
    expect(result.warehouse).toBe("postgres");
    expect(result.validated).toBe(true);
    expect(result.live).toBe(false);
    expect(result.question).toBe(OWN_QUESTION);
    expect(existsSync(join(dir, "grane.yml"))).toBe(true);
    expect(existsSync(join(dir, "metrics.yml"))).toBe(true);
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("postgres://ro:x@localhost:5432/app");
    expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(true);
  });

  it("own path --yes with DATABASE_URL keeps ${DATABASE_URL} in grane.yml", async () => {
    const dir = tempDir();
    await runSetup({
      yes: true,
      path: "own",
      dir,
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env, DATABASE_URL: "postgres://ro:x@localhost:5432/app" },
      io: quiet,
    });
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("${DATABASE_URL}");
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).not.toContain("ro:x@localhost");
  });

  it("own path --yes without a URL fails instead of writing a governed SUM stand-in", async () => {
    const dir = tempDir();
    await expect(
      runSetup({
        yes: true,
        path: "own",
        dir,
        skipConnect: true,
        offline: true,
        stdinIsTty: false,
        env: { ...process.env, DATABASE_URL: undefined },
        io: quiet,
      }),
    ).rejects.toThrow(/--url|DATABASE_URL/);
  });

  it("skips MCP when asked and prints the connect hint", async () => {
    const dir = tempDir();
    const logs: string[] = [];
    const result = await runSetup({
      yes: true,
      path: "own",
      dir,
      url: "postgres://ro@localhost:5432/app",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env },
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(result.client).toBeNull();
    expect(result.connect).toBeNull();
    expect(logs.join("\n")).toMatch(/mcp connect cursor/);
    expect(logs.join("\n")).toContain(OWN_QUESTION);
  });

  it("defaults own-path dir away from the Grane source tree", async () => {
    const root = tempDir();
    mkdirSync(join(root, "demo"));
    mkdirSync(join(root, "src", "cli"), { recursive: true });
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src", "cli", "index.ts"), "");
    const result = await runSetup({
      yes: true,
      path: "own",
      url: "postgres://ro@localhost:5432/app",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      cwd: root,
      env: { ...process.env },
      io: quiet,
    });
    expect(result.projectDir).toBe(join(root, "my-analytics"));
    expect(existsSync(join(root, "grane.yml"))).toBe(false);
    expect(existsSync(join(root, "my-analytics", "grane.yml"))).toBe(true);
  });

  it("walks interactive prompts for demo then skip-connect", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const logs: string[] = [];
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: { log: (line) => logs.push(line), error: () => undefined },
      prompt: scriptedPrompter({ select: ["demo", "skip"] }),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.path).toBe("demo");
    expect(result.client).toBeNull();
    expect(result.question).toBe(DEMO_QUESTION);
    expect(logs.join("\n")).toContain("You're ready.");
  });

  it("does not overwrite existing init files", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "grane.yml"), "project:\n  name: keep-me\nconnection:\n  type: postgres\n  url: postgres://ro@localhost/db\n");
    writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
    writeFileSync(join(dir, "dimensions.yml"), "dimensions: {}\n");
    writeFileSync(join(dir, "relationships.yml"), "relationships: {}\n");
    await runSetup({
      yes: true,
      path: "own",
      dir,
      url: "postgres://ro@localhost:5432/kept",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env },
      io: quiet,
    });
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("keep-me");
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("postgres://ro@localhost:5432/kept");
  });
});
