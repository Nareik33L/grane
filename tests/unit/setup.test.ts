import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_PIN_PATH, readActivePin } from "../../src/authoring/git.js";
import { writeInitProject } from "../../src/cli/init-project.js";
import { loadConfig } from "../../src/config/load.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { DEMO_QUESTION, type DemoResult } from "../../src/demo/run.js";
import { GraneKernel } from "../../src/kernel.js";
import { formatValidateReport } from "../../src/validate/format.js";
import {
  connectionFields,
  inferWarehouseFromUrl,
  isGraneSourceTree,
  maskDatabaseUrl,
  parseOwnDatabaseUrl,
  persistOwnConnection,
} from "../../src/setup/connection.js";
import { OWN_QUESTION, SETUP_BANNER } from "../../src/setup/copy.js";
import { BACK, scriptedPrompter, type Prompter } from "../../src/setup/prompts.js";
import {
  formatSetupWarehouse,
  runSetup,
  serializeSetupResult,
  type RunSetupOptions,
  type SetupResult,
} from "../../src/setup/run.js";
import {
  EXISTING_YAML_QUESTION,
  PATH_CHOICES,
  PATH_QUESTION,
  pathReviewLine,
  promptSetupAnswers,
} from "../../src/setup/wizard.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-setup-"));
  temps.push(dir);
  return dir;
}

function runGraneCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function initImportRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeInitProject(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "existing yaml"]);
  return dir;
}

function snapshotYaml(dir: string): Record<string, string> {
  const files = ["grane.yml", "metrics.yml", "dimensions.yml", "relationships.yml"];
  const out: Record<string, string> = {};
  for (const name of files) {
    const path = join(dir, name);
    if (existsSync(path)) out[name] = readFileSync(path, "utf8");
  }
  return out;
}

function importRun(dir: string, extra: RunSetupOptions = {}): Promise<SetupResult> {
  const prompt = extra.prompt ?? scriptedPrompter({ select: ["yes"], confirm: [true, true] });
  return runSetup({
    stdinIsTty: true,
    stdoutIsTty: true,
    dir,
    cwd: dir,
    skipConnect: true,
    offline: true,
    activateOffline: true,
    homeDir: tempDir(),
    workspaceDir: tempDir(),
    io: quiet,
    prompt,
    runDemoFn: async () => {
      throw new Error("runDemo must not run on the import path");
    },
    ...extra,
    prompt,
  });
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

  it("--yes --path still only accepts demo or own; --import is a separate flag", async () => {
    await expect(
      runSetup({ yes: true, path: "import", stdinIsTty: false, io: quiet }),
    ).rejects.toThrow(/demo or own/);
  });

  it("non-interactive --import validates and inspects without pinning", async () => {
    const dir = tempDir();
    writeInitProject(dir);
    const before = snapshotYaml(dir);
    const logs: string[] = [];
    const result = await runSetup({
      importDir: dir,
      offline: true,
      stdinIsTty: false,
      stdoutIsTty: false,
      io: { log: (line) => logs.push(line), error: () => undefined },
    });
    expect(result.path).toBe("import");
    expect(result.validated).toBe(true);
    expect(result.warehouse).toBe("postgres");
    expect(result.connect).toBeNull();
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(snapshotYaml(dir)).toEqual(before);
    expect(logs.join("\n")).toContain("0/0 metrics valid");
    expect(logs.join("\n")).toContain("Catalog");
    expect(logs.join("\n")).toContain("Import inspect only");
    expect(logs.join("\n")).not.toMatch(/activate\s+.grane\/active.json/);
  });

  it("non-interactive --import never pins even when stdin is a TTY", async () => {
    const dir = initImportRepo();
    const result = await runSetup({
      importDir: dir,
      offline: true,
      activateOffline: true,
      stdinIsTty: true,
      stdoutIsTty: true,
      io: quiet,
    });
    expect(result.validated).toBe(true);
    expect(readActivePin(dir)).toBeNull();
  });

  it("non-interactive --import invalid YAML does not pin and is not validated", async () => {
    const dir = tempDir();
    writeInitProject(dir);
    writeFileSync(
      join(dir, "metrics.yml"),
      `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
`,
    );
    const result = await runSetup({
      importDir: dir,
      offline: true,
      stdinIsTty: false,
      io: quiet,
    });
    expect(result.validated).toBe(false);
    expect(result.path).toBe("import");
    expect(readActivePin(dir)).toBeNull();
  });

  it("non-interactive --import exit code matches grane validate", () => {
    const okDir = tempDir();
    writeInitProject(okDir);
    const loadBadDir = tempDir();
    writeInitProject(loadBadDir);
    writeFileSync(join(loadBadDir, "extra.yml"), "bogus: true\n");
    const validateBadDir = tempDir();
    writeInitProject(validateBadDir);
    writeFileSync(
      join(validateBadDir, "metrics.yml"),
      `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
`,
    );

    const validateOk = runGraneCli(["-p", okDir, "validate", "--offline"]);
    const importOk = runGraneCli(["setup", "--import", okDir, "--offline"]);
    expect(importOk.status).toBe(validateOk.status);
    expect(importOk.status).toBe(0);
    expect(importOk.stdout).toContain("0/0 metrics valid");
    expect(existsSync(join(okDir, ACTIVE_PIN_PATH))).toBe(false);

    const validateLoadBad = runGraneCli(["-p", loadBadDir, "validate", "--offline"]);
    const importLoadBad = runGraneCli(["setup", "--import", loadBadDir, "--offline"]);
    expect(importLoadBad.status).toBe(validateLoadBad.status);
    expect(importLoadBad.status).toBe(1);
    expect(existsSync(join(loadBadDir, ACTIVE_PIN_PATH))).toBe(false);

    const validateSemanticBad = runGraneCli(["-p", validateBadDir, "validate", "--offline"]);
    const importSemanticBad = runGraneCli(["setup", "--import", validateBadDir, "--offline"]);
    expect(importSemanticBad.status).toBe(validateSemanticBad.status);
    expect(importSemanticBad.status).toBe(1);
    expect(importSemanticBad.stdout).toContain("ERROR revenue");
    expect(importSemanticBad.stderr).not.toMatch(/Validate failed/);
    expect(existsSync(join(validateBadDir, ACTIVE_PIN_PATH))).toBe(false);
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
      prompt: scriptedPrompter({ select: ["no", "demo", "skip"] }),
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
      prompt: scriptedPrompter({ select: ["no", "own", BACK, "demo", "skip"] }),
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
        select: ["no", "own", "mysql", "postgres"],
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
      prompt: scriptedPrompter({ select: ["no", "demo", "skip", "cursor"], confirm: [BACK, true] }),
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
        select: ["no", "own", "mysql"],
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
        select: ["no", "own", "snowflake"],
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

  it("import path loads, validates, inspects, and pins without editing YAML", async () => {
    const dir = initImportRepo();
    const before = snapshotYaml(dir);
    const head = git(dir, ["rev-parse", "HEAD"]);
    const logs: string[] = [];
    const confirms: string[] = [];
    const inner = scriptedPrompter({ select: ["yes"], confirm: [true, true] });
    const result = await importRun(dir, {
      io: { log: (line) => logs.push(line), error: () => undefined },
      prompt: {
        ...inner,
        async confirm(question, opts) {
          confirms.push(question);
          return inner.confirm(question, opts);
        },
      },
    });
    expect(result.path).toBe("import");
    expect(result.warehouse).toBe("postgres");
    expect(serializeSetupResult(result).warehouse).toBe("postgres");
    expect(JSON.parse(JSON.stringify(serializeSetupResult(result))).warehouse).toBe("postgres");
    expect(result.client).toBeNull();
    expect(result.connect).toBeNull();
    expect(result.validated).toBe(true);
    expect(result.live).toBe(false);
    expect(result.question).toBe(OWN_QUESTION);
    expect(result.projectDir).toBe(dir);
    expect(snapshotYaml(dir)).toEqual(before);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    const pin = readActivePin(dir);
    expect(pin?.ref).toBe("main");
    expect(pin?.commit).toBe(head);
    expect(pin?.approved_by).toBe("setup-import");
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(true);
    expect(existsSync(join(dir, ".grane", "authoring"))).toBe(false);
    expect(logs.join("\n")).toContain("0/0 metrics valid");
    expect(logs.join("\n")).toContain("Catalog");
    expect(logs.join("\n")).toContain("Existing YAML loaded, validated, and activated");
    expect(logs.join("\n")).toContain("Engine   postgres");
    expect(logs.join("\n")).toMatch(/activate\s+.grane\/active.json/);
    expect(confirms.some((question) => question === `Activate pin main@${head}?`)).toBe(true);
  });

  it("import path prints the same validate messages as grane validate and does not pin", async () => {
    const dir = initImportRepo();
    writeFileSync(
      join(dir, "metrics.yml"),
      `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
`,
    );
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "invalid metric"]);
    const before = snapshotYaml(dir);

    const loaded = loadConfig(dir);
    const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
    const expected = formatValidateReport(kernel.validate(), {
      providers: kernel.serverInfo().semantic_providers,
      providerWarnings: kernel.providerWarnings,
      schemaLive: false,
    });
    await kernel.close();

    const logs: string[] = [];
    await expect(
      importRun(dir, { io: { log: (line) => logs.push(line), error: () => undefined } }),
    ).rejects.toThrow(/Validate failed/);
    expect(logs.join("\n")).toContain(expected.join("\n"));
    expect(logs.join("\n")).toContain("ERROR revenue");
    expect(logs.join("\n")).toMatch(/undefined entity "order"/);
    expect(readActivePin(dir)).toBeNull();
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path repeats loadConfig errors the same way as grane validate", async () => {
    const dir = initImportRepo();
    writeFileSync(join(dir, "extra.yml"), "bogus: true\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "unknown key"]);
    const before = snapshotYaml(dir);
    let loadMessage = "";
    try {
      loadConfig(dir);
    } catch (err) {
      loadMessage = (err as Error).message;
    }
    expect(loadMessage).toMatch(/Unknown top-level key "bogus"/);
    await expect(importRun(dir)).rejects.toThrow(loadMessage);
    expect(readActivePin(dir)).toBeNull();
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path does not write YAML when there is no git repo to pin", async () => {
    const dir = tempDir();
    writeInitProject(dir);
    const before = snapshotYaml(dir);
    await expect(importRun(dir)).rejects.toThrow(/No git repository/);
    expect(snapshotYaml(dir)).toEqual(before);
    expect(readActivePin(dir)).toBeNull();
  });

  it("import path declining activation writes no pin", async () => {
    const dir = initImportRepo();
    const before = snapshotYaml(dir);
    await expect(
      importRun(dir, { prompt: scriptedPrompter({ select: ["yes"], confirm: [true, false] }) }),
    ).rejects.toThrow(/Activation declined/);
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path refuses activation when stdin/stdout is not a TTY", async () => {
    const dir = initImportRepo();
    const before = snapshotYaml(dir);
    await expect(
      importRun(dir, { stdinIsTty: false, stdoutIsTty: false }),
    ).rejects.toThrow(/Activation requires a TTY/);
    expect(readActivePin(dir)).toBeNull();
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path refuses activation when --offline without --activate-offline", async () => {
    const dir = initImportRepo();
    const before = snapshotYaml(dir);
    const logs: string[] = [];
    await expect(
      importRun(dir, {
        activateOffline: false,
        io: { log: (line) => logs.push(line), error: () => undefined },
      }),
    ).rejects.toThrow(/--offline skipped live schema checks/);
    expect(logs.join("\n")).toContain("Catalog");
    expect(readActivePin(dir)).toBeNull();
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path refuses when ignored YAML differs from the pinned HEAD tree", async () => {
    const dir = initImportRepo();
    writeFileSync(join(dir, ".gitignore"), ".grane/\n*.local.yml\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "ignore local yaml"]);
    writeFileSync(join(dir, "secrets.local.yml"), "entities: {}\n");
    const before = snapshotYaml(dir);
    await expect(importRun(dir)).rejects.toThrow(/secrets\.local\.yml/);
    expect(readActivePin(dir)).toBeNull();
    expect(snapshotYaml(dir)).toEqual(before);
    expect(readFileSync(join(dir, "secrets.local.yml"), "utf8")).toBe("entities: {}\n");
  });

  it("import path refuses a dirty working tree instead of pinning uncommitted YAML", async () => {
    const dir = initImportRepo();
    writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n# uncommitted\n");
    const committed = git(dir, ["show", "HEAD:metrics.yml"]);
    await expect(importRun(dir)).rejects.toThrow(/Working tree is dirty/);
    expect(readActivePin(dir)).toBeNull();
    expect(git(dir, ["show", "HEAD:metrics.yml"])).toBe(committed);
  });

  it("goes back from the path step to the existing-YAML question", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    await expect(
      runSetup({
        stdinIsTty: true,
        dir: demoDir,
        skipConnect: true,
        homeDir: tempDir(),
        workspaceDir: tempDir(),
        io: quiet,
        prompt: scriptedPrompter({ select: ["no", BACK, "yes"] }),
        runDemoFn: async () => {
          throw new Error("runDemo must not run on the import path");
        },
      }),
    ).rejects.toThrow(/No grane.yml found/);
    expect(existsSync(join(demoDir, "grane.yml"))).toBe(false);
  });

  it("goes back from import confirm onto the demo path", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      skipConnect: true,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: quiet,
      prompt: scriptedPrompter({ select: ["yes", "no", "demo"], confirm: [BACK, true] }),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.path).toBe("demo");
    expect(result.warehouse).toBe("duckdb");
  });
});

describe("SetupResult.warehouse null handling", () => {
  function importShaped(warehouse: SetupResult["warehouse"]): SetupResult {
    return {
      path: "import",
      projectDir: "/tmp/existing-yaml",
      warehouse,
      client: null,
      question: OWN_QUESTION,
      validated: false,
      live: false,
      connect: null,
    };
  }

  it("formatSetupWarehouse maps null to none and keeps engine ids", () => {
    expect(formatSetupWarehouse(null)).toBe("none");
    expect(formatSetupWarehouse("duckdb")).toBe("duckdb");
    expect(formatSetupWarehouse("postgres")).toBe("postgres");
  });

  it("serializeSetupResult keeps JSON warehouse null for the import-shaped result", () => {
    const json = serializeSetupResult(importShaped(null));
    expect(json.warehouse).toBeNull();
    expect(json.client).toBeNull();
    expect(json.mcpPath).toBeNull();
    expect(json.path).toBe("import");
    const parsed = JSON.parse(JSON.stringify(json)) as { warehouse: unknown };
    expect(Object.prototype.hasOwnProperty.call(parsed, "warehouse")).toBe(true);
    expect(parsed.warehouse).toBeNull();
  });

  it("serializeSetupResult does not coerce a loaded import warehouse to null", () => {
    const json = serializeSetupResult(importShaped("postgres"));
    expect(json.warehouse).toBe("postgres");
    expect(JSON.parse(JSON.stringify(json)).warehouse).toBe("postgres");
  });
});

describe("wizard existing-YAML fork", () => {
  it("freezes demo/own path copy as byte-identical to today", () => {
    expect(PATH_QUESTION).toBe("How do you want to start?");
    expect(PATH_CHOICES).toEqual([
      {
        value: "demo",
        label: "Try Grane's demo shop",
        hint: "Local DuckDB. No database, no Docker. The planted revenue-drop story.",
      },
      {
        value: "own",
        label: "Connect my own data",
        hint: "Any warehouse Grane already supports. We write grane.yml, validate, then connect an agent.",
      },
    ]);
    expect(pathReviewLine("demo")).toBe("demo shop (DuckDB)");
    expect(pathReviewLine("own")).toBe("own data");
    expect({
      PATH_QUESTION,
      PATH_CHOICES,
      demoReview: pathReviewLine("demo"),
      ownReview: pathReviewLine("own"),
    }).toMatchSnapshot();
  });

  it("demo path after answering no matches the frozen wizard transcript", async () => {
    const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: ["no", "demo"] }));
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("demo");
    expect(transcript[0]).toMatchObject({ kind: "select", question: EXISTING_YAML_QUESTION });
    expect(transcript.slice(1)).toMatchSnapshot();
  });

  it("own path after answering no matches the frozen wizard transcript", async () => {
    const { prompt, io, transcript } = recordingPrompter(
      scriptedPrompter({
        select: ["no", "own", "postgres"],
        input: ["postgres://ro@localhost:5432/app", ""],
      }),
    );
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("own");
    expect(answers.engine).toBe("postgres");
    expect(transcript[0]).toMatchObject({ kind: "select", question: EXISTING_YAML_QUESTION });
    expect(transcript.slice(1)).toMatchSnapshot();
  });

  it("answering yes never enters path, warehouse, or client steps", async () => {
    const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: ["yes"] }));
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("import");
    expect(answers.engine).toBeUndefined();
    expect(answers.connection).toBeUndefined();
    expect(answers.client).toBeNull();
    const questions = transcript
      .filter((e) => e.kind === "select" || e.kind === "input")
      .map((e) => String(e.question));
    expect(questions).toEqual([EXISTING_YAML_QUESTION]);
    expect(questions).not.toContain(PATH_QUESTION);
    expect(questions).not.toContain("Which warehouse?");
    expect(questions).not.toContain("Which agent should Grane register with?");
  });
});

function wizardOpts(prompt: Prompter, io: { log: (line: string) => void; error: (line: string) => void }) {
  return {
    io,
    prompt,
    env: {},
    skipConnect: true,
    resolveClientId: (name: string) => name,
    listClients: () => [
      { id: "cursor", label: "Cursor" },
      { id: "generic", label: "Generic" },
    ],
  };
}

function recordingPrompter(inner: Prompter): {
  prompt: Prompter;
  io: { log: (line: string) => void; error: (line: string) => void };
  transcript: Array<Record<string, unknown>>;
} {
  const transcript: Array<Record<string, unknown>> = [];
  return {
    io: {
      log: (line: string) => {
        transcript.push({ kind: "log", line });
      },
      error: () => undefined,
    },
    transcript,
    prompt: {
      async select(question, choices, opts) {
        transcript.push({
          kind: "select",
          question,
          choices: choices.map((c) => ({ value: c.value, label: c.label, hint: c.hint })),
          allowBack: Boolean(opts?.allowBack),
          defaultValue: opts?.defaultValue,
        });
        return inner.select(question, choices, opts);
      },
      async input(question, opts) {
        transcript.push({
          kind: "input",
          question,
          defaultValue: opts?.defaultValue,
          allowEmpty: Boolean(opts?.allowEmpty),
          allowBack: Boolean(opts?.allowBack),
        });
        return inner.input(question, opts);
      },
      async confirm(question, opts = true) {
        const resolved = typeof opts === "boolean" ? { defaultYes: opts } : opts;
        transcript.push({
          kind: "confirm",
          question,
          defaultYes: resolved.defaultYes !== false,
          allowBack: Boolean(resolved.allowBack),
        });
        return inner.confirm(question, opts);
      },
    },
  };
}
