import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeInitProject } from "../../src/cli/init-project.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { DEMO_QUESTION, type DemoResult } from "../../src/demo/run.js";
import {
  connectionFields,
  inferWarehouseFromUrl,
  isGraneSourceTree,
  maskDatabaseUrl,
  parseOwnDatabaseUrl,
  persistOwnConnection,
} from "../../src/setup/connection.js";
import { OWN_QUESTION, SETUP_BANNER } from "../../src/setup/copy.js";
import { BACK, scriptedPrompter } from "../../src/setup/prompts.js";
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

describe("parseOwnDatabaseUrl / inferWarehouseFromUrl", () => {
  it("infers every URL scheme that maps to a shipped connector", () => {
    expect(inferWarehouseFromUrl("postgres://ro@db/app")).toBe("postgres");
    expect(inferWarehouseFromUrl("postgresql://ro@db/app")).toBe("postgres");
    expect(inferWarehouseFromUrl("mysql://ro@db/app")).toBe("mysql");
    expect(inferWarehouseFromUrl("mariadb://ro@db/app")).toBe("mysql");
    expect(inferWarehouseFromUrl("clickhouse://ro@db/app")).toBe("clickhouse");
    expect(inferWarehouseFromUrl("redshift://ro@db/app")).toBe("redshift");
    expect(inferWarehouseFromUrl("snowflake://xy12345/db")).toBe("snowflake");
    expect(inferWarehouseFromUrl("databricks://host/sql")).toBe("databricks");
    expect(inferWarehouseFromUrl("bigquery://project/dataset")).toBe("bigquery");
    expect(inferWarehouseFromUrl("duckdb://localhost/file")).toBe("duckdb");
  });

  it("keeps postgres:// as redshift when the user already picked Redshift", () => {
    expect(parseOwnDatabaseUrl("postgres://ro@db/app", "redshift").type).toBe("redshift");
  });

  it("accepts ClickHouse http(s) URLs when the engine is clickhouse", () => {
    expect(parseOwnDatabaseUrl("http://ro:x@ch:8123", "clickhouse").type).toBe("clickhouse");
  });

  it("refuses a URL that does not match the chosen engine", () => {
    expect(() => parseOwnDatabaseUrl("mysql://ro@db/app", "postgres")).toThrow(/looks like mysql/);
  });

  it("refuses junk", () => {
    expect(() => parseOwnDatabaseUrl("not-a-url")).toThrow(/Not a valid URL/);
    expect(() => parseOwnDatabaseUrl("")).toThrow(/required/);
  });

  it("masks credentials in log lines", () => {
    expect(maskDatabaseUrl("postgres://ro:s3cret@db:5432/app")).toBe("postgres://ro:***@db:5432/app");
  });
});

describe("connectionFields", () => {
  it("covers every shipped warehouse type", () => {
    expect(WAREHOUSE_TYPES).toEqual([
      "postgres",
      "mysql",
      "snowflake",
      "bigquery",
      "duckdb",
      "clickhouse",
      "redshift",
      "databricks",
    ]);
    for (const type of WAREHOUSE_TYPES) {
      const fields = connectionFields(type);
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.some((f) => f.required)).toBe(true);
    }
  });
});

describe("persistOwnConnection", () => {
  it("rewrites the connection block to a Postgres URL", () => {
    const dir = tempDir();
    writeInitProject(dir);
    persistOwnConnection(dir, { type: "postgres", url: "postgres://ro:x@db:5432/app" });
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*postgres/);
    expect(yaml).toContain('url: "postgres://ro:x@db:5432/app"');
    expect(yaml).not.toContain("${DATABASE_URL}");
  });

  it("persists DuckDB path, Snowflake account fields, and BigQuery project", () => {
    const dir = tempDir();
    writeInitProject(dir);
    persistOwnConnection(dir, { type: "duckdb", path: "warehouse.duckdb", schema: "main" });
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toMatch(/type:\s*duckdb/);
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain('path: "warehouse.duckdb"');

    persistOwnConnection(dir, {
      type: "snowflake",
      account: "xy12345",
      user: "ro",
      password: "s3cret",
      warehouse: "COMPUTE_WH",
      database: "ANALYTICS",
      schema: "PUBLIC",
    });
    const snow = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(snow).toMatch(/type:\s*snowflake/);
    expect(snow).toContain('account: "xy12345"');
    expect(snow).not.toContain("url:");

    persistOwnConnection(dir, { type: "bigquery", project: "my-proj", dataset: "analytics", location: "US" });
    const bq = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(bq).toMatch(/type:\s*bigquery/);
    expect(bq).toContain('project: "my-proj"');
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

  it("goes back from own-data to the demo path", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: quiet,
      prompt: scriptedPrompter({ select: ["own", BACK, "demo", "skip"] }),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.path).toBe("demo");
    expect(result.warehouse).toBe("duckdb");
  });

  it("goes back from a warehouse field to pick a different engine", async () => {
    const dir = tempDir();
    const logs: string[] = [];
    const result = await runSetup({
      stdinIsTty: true,
      dir,
      skipConnect: true,
      offline: true,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      env: { ...process.env },
      io: { log: (line) => logs.push(line), error: () => undefined },
      prompt: scriptedPrompter({
        select: ["own", "mysql", "postgres"],
        input: ["back", "postgres://ro@localhost:5432/app", ""],
      }),
    });
    expect(result.path).toBe("own");
    expect(result.warehouse).toBe("postgres");
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("postgres://ro@localhost:5432/app");
    expect(logs.join("\n")).toMatch(/self_certifiable|certified/);
  });

  it("goes back from the MCP step to change the client", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: quiet,
      prompt: scriptedPrompter({ select: ["demo", "skip", "cursor"], confirm: [BACK, true] }),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.client).toBe("cursor");
  });

  it("interactive own path configures MySQL from a URL", async () => {
    const dir = tempDir();
    const result = await runSetup({
      stdinIsTty: true,
      dir,
      skipConnect: true,
      offline: true,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      env: { ...process.env },
      io: quiet,
      prompt: scriptedPrompter({
        select: ["own", "mysql"],
        input: ["mysql://ro:x@localhost:3306/shop", "shop"],
      }),
    });
    expect(result.warehouse).toBe("mysql");
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*mysql/);
    expect(yaml).toContain("mysql://ro:x@localhost:3306/shop");
  });

  it("interactive own path configures Snowflake fields and says self_certifiable", async () => {
    const dir = tempDir();
    const logs: string[] = [];
    const result = await runSetup({
      stdinIsTty: true,
      dir,
      skipConnect: true,
      offline: true,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      env: { ...process.env },
      io: { log: (line) => logs.push(line), error: () => undefined },
      prompt: scriptedPrompter({
        select: ["own", "snowflake"],
        input: ["xy12345", "ro", "s3cret", "COMPUTE_WH", "ANALYTICS", "PUBLIC", "GRANE_READONLY"],
      }),
    });
    expect(result.warehouse).toBe("snowflake");
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*snowflake/);
    expect(yaml).toContain('account: "xy12345"');
    expect(yaml).not.toContain("url:");
    expect(logs.join("\n")).toMatch(/self_certifiable — not CI-certified/);
  });

  it("--yes own path accepts DuckDB --connection-path and ClickHouse --url", async () => {
    const duck = tempDir();
    const duckResult = await runSetup({
      yes: true,
      path: "own",
      dir: duck,
      engine: "duckdb",
      connectionPath: "warehouse.duckdb",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env },
      io: quiet,
    });
    expect(duckResult.warehouse).toBe("duckdb");
    expect(readFileSync(join(duck, "grane.yml"), "utf8")).toMatch(/type:\s*duckdb/);

    const ch = tempDir();
    const chResult = await runSetup({
      yes: true,
      path: "own",
      dir: ch,
      url: "clickhouse://ro@localhost:8123/analytics",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env },
      io: quiet,
    });
    expect(chResult.warehouse).toBe("clickhouse");
    expect(readFileSync(join(ch, "grane.yml"), "utf8")).toMatch(/type:\s*clickhouse/);
  });
});
