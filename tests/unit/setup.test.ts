import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_PIN_PATH, readActivePin } from "../../src/authoring/git.js";
import { writeInitProject } from "../../src/cli/init-project.js";
import { loadConfig } from "../../src/config/load.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { DEFAULT_DEMO_POSTGRES, DEMO_QUESTION, demoPostgresUrl, type DemoResult } from "../../src/demo/run.js";
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
import { DIMENSIONS_YML, METRICS_YML, RELATIONSHIPS_YML } from "../../src/cli/templates.js";
import { OWN_QUESTION, SETUP_BANNER } from "../../src/setup/copy.js";
import { BACK, scriptedPrompter, type Prompter } from "../../src/setup/prompts.js";
import {
  formatSetupWarehouse,
  runSetup,
  serializeSetupResult,
  type RunSetupOptions,
  type SetupResult,
} from "../../src/setup/run.js";
import { DEMO_AUTHORING_QUESTION, assertNotExistingGitRepo } from "../../src/setup/demo-postgres.js";
import { DEMO_AUTHORING_MARKER } from "../../src/authoring/demo-marker.js";
import {
  CONFIRM_QUESTION,
  DEMO_YAML_QUESTION,
  PATH_QUESTION,
  TONE_QUESTION,
  demoReviewLine,
  promptSetupAnswers,
} from "../../src/setup/wizard.js";
import { localGraneConfigPath, readSetupTone } from "../../src/setup/local-config.js";
import { wizardCopy } from "../../src/setup/wizard-copy.js";

const FLAG_OUTPUT = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/setup-flag-output");

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
  const prompt = extra.prompt ?? scriptedPrompter({ select: ["plain", "import"], confirm: [true, true] });
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

  it("live import inspect emits a discovery audit event and does not pin", async () => {
    let duckOk = false;
    try {
      await import("@duckdb/node-api");
      duckOk = true;
    } catch {
      duckOk = false;
    }
    if (!duckOk) return;

    const dir = tempDir();
    const warehouse = join(dir, "shop.duckdb");
    const mod = (await import("@duckdb/node-api")) as {
      DuckDBInstance: {
        create: (path: string) => Promise<{
          connect: () => Promise<{
            runAndReadAll: (sql: string) => Promise<unknown>;
            closeSync?: () => void;
            disconnectSync?: () => void;
          }>;
          closeSync?: () => void;
        }>;
      };
    };
    const instance = await mod.DuckDBInstance.create(warehouse);
    const conn = await instance.connect();
    await conn.runAndReadAll("CREATE TABLE items (id INTEGER, name VARCHAR)");
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();

    writeInitProject(dir);
    writeFileSync(
      join(dir, "grane.yml"),
      `project:
  name: import-inspect
  timezone: UTC
connection:
  type: duckdb
  path: ${warehouse}
  schema: main
audit:
  enabled: true
  path: .grane/audit.jsonl
`,
    );
    const result = await runSetup({
      importDir: dir,
      stdinIsTty: false,
      stdoutIsTty: false,
      io: quiet,
    });
    expect(result.path).toBe("import");
    expect(result.validated).toBe(true);
    expect(result.warehouse).toBe("duckdb");
    expect(readActivePin(dir)).toBeNull();
    const events = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { kind: string; operation: string; agent: string | null; read_only: boolean });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "discovery",
      operation: "introspect",
      agent: "setup-import",
      read_only: true,
    });
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
    expect(logs.join("\n")).toContain("Live import writes .grane/audit.jsonl");
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

  it("--yes --path demo --postgres uses shipped YAML via runDemo({ postgres: true })", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    let seenPostgres: boolean | undefined;
    const result = await runSetup({
      yes: true,
      path: "demo",
      postgres: true,
      dir: demoDir,
      skipConnect: true,
      stdinIsTty: false,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: quiet,
      runDemoFn: async (opts) => {
        seenPostgres = Boolean(opts.postgres);
        return stubDemo(demoDir);
      },
    });
    expect(seenPostgres).toBe(true);
    expect(result.path).toBe("demo");
    expect(result.warehouse).toBe("postgres");
    expect(result.demoEngine).toBe("postgres");
    expect(result.demoYaml).toBe("shipped");
    expect(result.question).toBe(DEMO_QUESTION);
    expect(existsSync(join(demoDir, ACTIVE_PIN_PATH))).toBe(false);
  });

  it("--yes --path demo --postgres --authoring writes a git project, no pin, no production YAML overwrite of the parent", async () => {
    const dir = tempDir();
    const result = await runSetup({
      yes: true,
      path: "demo",
      postgres: true,
      authoring: true,
      dir,
      skipConnect: true,
      stdinIsTty: false,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: quiet,
      runDemoAuthoringFn: async () => undefined,
    });
    expect(result.path).toBe("demo");
    expect(result.warehouse).toBe("postgres");
    expect(result.demoYaml).toBe("authoring");
    expect(result.question).toBe(DEMO_AUTHORING_QUESTION);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ".grane-demo"))).toBe(true);
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*postgres/);
    expect(yaml).toMatch(/authoring:\n\s+enabled:\s*true/);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toMatch(/metrics:\s*\{\}/);
    const git = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" });
    expect(git.status).toBe(0);
    expect(git.stdout.trim()).toBe("main");
    const branches = spawnSync("git", ["branch"], { cwd: dir, encoding: "utf8" }).stdout;
    expect(branches).not.toMatch(/grane\/proposal/);
  });

  it("demo authoring refuses --dir that is already a git repository", async () => {
    const dir = tempDir();
    const git = spawnSync("git", ["init", "-b", "main"], { cwd: dir, encoding: "utf8" });
    expect(git.status).toBe(0);
    expect(() => assertNotExistingGitRepo(dir)).toThrow(/already a git repository/);
    await expect(
      runSetup({
        yes: true,
        path: "demo",
        postgres: true,
        authoring: true,
        dir,
        skipConnect: true,
        stdinIsTty: false,
        homeDir: tempDir(),
        workspaceDir: tempDir(),
        io: quiet,
      }),
    ).rejects.toThrow(/already a git repository/);
  });

  it("demo postgres url uses GRANE_DEMO_DATABASE_URL and ignores DATABASE_URL", () => {
    expect(
      demoPostgresUrl({ DATABASE_URL: "postgres://prod.example/db", GRANE_DEMO_DATABASE_URL: undefined }),
    ).toBe(DEFAULT_DEMO_POSTGRES);
    expect(
      demoPostgresUrl({
        DATABASE_URL: "postgres://prod.example/db",
        GRANE_DEMO_DATABASE_URL: "postgres://demo.example/shop",
      }),
    ).toBe("postgres://demo.example/shop");
  });

  it("demo authoring without --postgres is refused", async () => {
    await expect(
      runSetup({
        yes: true,
        path: "demo",
        authoring: true,
        skipConnect: true,
        stdinIsTty: false,
        io: quiet,
      }),
    ).rejects.toThrow(/requires demo Postgres/);
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
      prompt: scriptedPrompter({ select: ["plain", "demo"] }),
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
      prompt: scriptedPrompter({ select: ["plain", "own", BACK, "demo"] }),
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
        select: ["plain", "own", "mysql", "postgres"],
        input: ["back", "postgres://ro@localhost:5432/app", ""],
      }),
    });
    expect(result.path).toBe("own");
    expect(result.warehouse).toBe("postgres");
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("postgres://ro@localhost:5432/app");
    expect(logs.join("\n")).toMatch(/self_certifiable|certified/);
  });

  it("default demo path does not register an MCP client unless --connect is set", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const workspace = tempDir();
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      homeDir: tempDir(),
      workspaceDir: workspace,
      cwd: workspace,
      io: quiet,
      prompt: scriptedPrompter({}),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.client).toBeNull();
    expect(result.connect).toBeNull();
    expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(false);
  });

  it("--connect still registers Cursor when the wizard is interactive", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const workspace = tempDir();
    const result = await runSetup({
      stdinIsTty: true,
      dir: demoDir,
      connect: "cursor",
      homeDir: tempDir(),
      workspaceDir: workspace,
      cwd: workspace,
      io: quiet,
      prompt: scriptedPrompter({}),
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(result.client).toBe("cursor");
    expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(true);
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
        select: ["plain", "own", "mysql"],
        input: ["mysql://ro:x@localhost:3306/shop", "shop"],
      }),
    });
    expect(result.warehouse).toBe("mysql");
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).toMatch(/type:\s*mysql/);
    expect(yaml).toContain("mysql://ro:x@localhost:3306/shop");
  });

  it("interactive own DuckDB path defaults the file to warehouse.duckdb", async () => {
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
        select: ["plain", "own", "duckdb"],
      }),
    });
    expect(result.warehouse).toBe("duckdb");
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain('path: "warehouse.duckdb"');
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
        select: ["plain", "own", "snowflake"],
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
    const inner = scriptedPrompter({ select: ["plain", "import"], confirm: [true, true] });
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
      importRun(dir, { prompt: scriptedPrompter({ select: ["plain", "import"], confirm: [true, false] }) }),
    ).rejects.toThrow(/Activation declined/);
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(snapshotYaml(dir)).toEqual(before);
  });

  it("import path pins the configured base branch tip, not a feature-branch HEAD", async () => {
    const dir = initImportRepo();
    const main = git(dir, ["rev-parse", "main"]);
    git(dir, ["checkout", "-b", "feature"]);
    git(dir, ["commit", "--allow-empty", "-m", "feature empty"]);
    const feature = git(dir, ["rev-parse", "HEAD"]);
    expect(feature).not.toBe(main);

    const result = await importRun(dir);
    expect(result.validated).toBe(true);
    const pin = readActivePin(dir);
    expect(pin?.ref).toBe("main");
    expect(pin?.commit).toBe(main);
    expect(pin?.commit).not.toBe(feature);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("feature");
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

  it("goes back from own-data to import, which does not write YAML", async () => {
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
        prompt: scriptedPrompter({ select: ["plain", "own", BACK, "import"] }),
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
      prompt: scriptedPrompter({ select: ["plain", "import", "demo"], confirm: [BACK, true] }),
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

describe("explicit flag output is frozen", () => {
  it("--yes --path own --skip-connect --offline writes the frozen YAML, result, and logs", async () => {
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
      io: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
    });
    for (const name of ["grane.yml", "metrics.yml", "dimensions.yml", "relationships.yml"] as const) {
      expect(readFileSync(join(dir, name), "utf8"), name).toBe(
        readFileSync(join(FLAG_OUTPUT, "own-postgres", name), "utf8"),
      );
    }
    expect(flagResultShape(result)).toEqual(
      JSON.parse(readFileSync(join(FLAG_OUTPUT, "own-postgres-result.json"), "utf8")),
    );
    expect(normalizeSetupLog(logs, dir)).toBe(
      readFileSync(join(FLAG_OUTPUT, "own-postgres-logs.txt"), "utf8"),
    );
  });

  it("--yes --path demo --skip-connect keeps the frozen SetupResult and logs", async () => {
    const demoDir = join(tempDir(), "shop");
    mkdirSync(demoDir);
    const logs: string[] = [];
    const result = await runSetup({
      yes: true,
      path: "demo",
      dir: demoDir,
      skipConnect: true,
      stdinIsTty: false,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: { log: (line) => logs.push(line), error: (line) => logs.push(line) },
      runDemoFn: async () => stubDemo(demoDir),
    });
    expect(flagResultShape(result)).toEqual(
      JSON.parse(readFileSync(join(FLAG_OUTPUT, "yes-demo-result.json"), "utf8")),
    );
    expect(normalizeSetupLog(logs, demoDir)).toBe(
      readFileSync(join(FLAG_OUTPUT, "yes-demo-logs.txt"), "utf8"),
    );
  });
});

describe("wizard defaults and prompt count (V2-16)", () => {
  it("plain demo path asks tone + start + confirm and never enables authoring", async () => {
    const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: ["plain"] }));
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("demo");
    expect(answers.demoEngine).toBe("duckdb");
    expect(answers.demoYaml).toBeUndefined();
    expect(answers.client).toBeNull();
    expect(answers.tone).toBe("plain");
    const asked = transcript.filter((e) => e.kind === "select" || e.kind === "input" || e.kind === "confirm");
    expect(asked).toHaveLength(3);
    expect(asked[0]).toMatchObject({
      kind: "select",
      question: TONE_QUESTION,
      allowBack: false,
    });
    expect(asked[1]).toMatchObject({
      kind: "select",
      question: PATH_QUESTION,
      defaultValue: "demo",
    });
    expect(asked[2]).toMatchObject({
      kind: "confirm",
      question: CONFIRM_QUESTION,
      defaultYes: true,
    });
    expect(asked.some((e) => String(e.question) === DEMO_YAML_QUESTION)).toBe(false);
    expect(asked.some((e) => String(e.question).includes("agent"))).toBe(false);
  });

  it("choosing import never enters warehouse, client, or demo-YAML steps", async () => {
    const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: ["plain", "import"] }));
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("import");
    expect(answers.engine).toBeUndefined();
    expect(answers.connection).toBeUndefined();
    expect(answers.client).toBeNull();
    expect(answers.demoYaml).toBeUndefined();
    const questions = transcript
      .filter((e) => e.kind === "select" || e.kind === "input")
      .map((e) => String(e.question));
    expect(questions).toEqual([TONE_QUESTION, PATH_QUESTION]);
    expect(questions.some((q) => q.includes("Warehouse engine"))).toBe(false);
    expect(questions).not.toContain("Which agent should Grane register with?");
    expect(questions).not.toContain(DEMO_YAML_QUESTION);
  });

  it("demo Postgres YAML defaults to shipped, with back-nav, and authoring is not the default", async () => {
    const { prompt, io, transcript } = recordingPrompter(
      scriptedPrompter({
        select: ["plain", "demo_postgres", BACK, "demo_postgres"],
      }),
    );
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.path).toBe("demo");
    expect(answers.demoEngine).toBe("postgres");
    expect(answers.demoYaml).toBe("shipped");
    expect(demoReviewLine(answers.demoEngine, answers.demoYaml)).toBe("demo Postgres (shipped YAML)");
    const yamlSteps = transcript.filter((e) => e.kind === "select" && e.question === DEMO_YAML_QUESTION);
    expect(yamlSteps.length).toBeGreaterThanOrEqual(1);
    expect(yamlSteps[0]).toMatchObject({ defaultValue: "shipped" });
  });

  it("demo Postgres authoring is a distinct review line and only happens when chosen", async () => {
    const { prompt, io } = recordingPrompter(
      scriptedPrompter({ select: ["plain", "demo_postgres", "authoring"] }),
    );
    const answers = await promptSetupAnswers(wizardOpts(prompt, io));
    expect(answers.demoEngine).toBe("postgres");
    expect(answers.demoYaml).toBe("authoring");
    expect(demoReviewLine("postgres", "authoring")).toBe("demo Postgres (author YAML)");
  });

  it("interactive --path demo still asks tone, then confirm", async () => {
    const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: ["plain"] }));
    const answers = await promptSetupAnswers({ ...wizardOpts(prompt, io), forcedPath: "demo" });
    expect(answers.path).toBe("demo");
    expect(answers.demoEngine).toBe("duckdb");
    expect(answers.tone).toBe("plain");
    const asked = transcript.filter((e) => e.kind === "select" || e.kind === "confirm");
    expect(asked).toHaveLength(2);
    expect(asked[0]).toMatchObject({ kind: "select", question: TONE_QUESTION });
    expect(asked[1]).toMatchObject({ kind: "confirm", question: CONFIRM_QUESTION });
  });
});

describe("new defaults never silently author, pin, or copy demo YAML onto own data", () => {
  it("interactive own path writes init templates, not the demo shop, and does not pin or enable authoring", async () => {
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
        select: ["plain", "own", "postgres"],
        input: ["postgres://ro@localhost:5432/app", ""],
      }),
      runDemoFn: async () => {
        throw new Error("runDemo must not run on the own path");
      },
    });
    expect(result.path).toBe("own");
    expect(result.demoEngine).toBeUndefined();
    expect(result.demoYaml).toBeUndefined();
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(existsSync(join(dir, DEMO_AUTHORING_MARKER))).toBe(false);
    const yaml = readFileSync(join(dir, "grane.yml"), "utf8");
    expect(yaml).not.toMatch(/^authoring:\n\s+enabled:\s*true/m);
    expect(yaml).toContain("#   enabled: false");
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toBe(METRICS_YML);
    expect(readFileSync(join(dir, "dimensions.yml"), "utf8")).toBe(DIMENSIONS_YML);
    expect(readFileSync(join(dir, "relationships.yml"), "utf8")).toBe(RELATIONSHIPS_YML);
    const demoShopMetrics = readFileSync(join(process.cwd(), "demo/analytics/metrics.yml"), "utf8");
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).not.toBe(demoShopMetrics);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).not.toContain("Net revenue from completed orders");
  });

  it("technical and plain tones write identical own-path YAML and take the same actions", async () => {
    async function ownWithTone(tone: "technical" | "plain") {
      const dir = tempDir();
      const home = tempDir();
      const recorded = recordingPrompter(
        scriptedPrompter({
          select: [tone, "own", "postgres"],
          input: ["postgres://ro@localhost:5432/app", ""],
        }),
      );
      const result = await runSetup({
        stdinIsTty: true,
        dir,
        skipConnect: true,
        offline: true,
        homeDir: home,
        workspaceDir: tempDir(),
        env: { ...process.env },
        io: quiet,
        prompt: recorded.prompt,
      });
      return { dir, home, result, transcript: recorded.transcript };
    }
    const technical = await ownWithTone("technical");
    const plain = await ownWithTone("plain");
    expect(snapshotYaml(technical.dir)).toEqual(snapshotYaml(plain.dir));
    expect(flagResultShape(technical.result)).toEqual(flagResultShape(plain.result));
    expect(technical.result.path).toBe("own");
    expect(readActivePin(technical.dir)).toBeNull();
    expect(readActivePin(plain.dir)).toBeNull();
    expect(existsSync(join(technical.dir, DEMO_AUTHORING_MARKER))).toBe(false);
    expect(existsSync(join(plain.dir, DEMO_AUTHORING_MARKER))).toBe(false);
    expect(readFileSync(join(technical.dir, "grane.yml"), "utf8")).not.toMatch(/^authoring:\n\s+enabled:\s*true/m);
    expect(readFileSync(join(plain.dir, "grane.yml"), "utf8")).not.toMatch(/^authoring:\n\s+enabled:\s*true/m);
    expect(readSetupTone(technical.home)).toBe("technical");
    expect(readSetupTone(plain.home)).toBe("plain");
    expect(readFileSync(join(technical.dir, "grane.yml"), "utf8")).not.toMatch(/setup_tone/);
    expect(existsSync(join(technical.dir, ".grane", "config.json"))).toBe(false);
    expect(existsSync(join(plain.dir, ".grane", "config.json"))).toBe(false);
    const techQs = technical.transcript.map((e) => e.question).filter(Boolean);
    const plainQs = plain.transcript.map((e) => e.question).filter(Boolean);
    expect(techQs).toContain(wizardCopy("technical").pathQuestion);
    expect(plainQs).toContain(PATH_QUESTION);
    expect(techQs).not.toContain(PATH_QUESTION);
    expect(plainQs).not.toContain(wizardCopy("technical").pathQuestion);
    const techDefaults = technical.transcript
      .filter((e) => e.kind === "select" || e.kind === "input" || e.kind === "confirm")
      .filter((e) => e.question !== TONE_QUESTION)
      .map((e) => ({ kind: e.kind, defaultValue: e.defaultValue, defaultYes: e.defaultYes, allowEmpty: e.allowEmpty }));
    const plainDefaults = plain.transcript
      .filter((e) => e.kind === "select" || e.kind === "input" || e.kind === "confirm")
      .filter((e) => e.question !== TONE_QUESTION)
      .map((e) => ({ kind: e.kind, defaultValue: e.defaultValue, defaultYes: e.defaultYes, allowEmpty: e.allowEmpty }));
    expect(techDefaults).toEqual(plainDefaults);
  });

  it("both tones default the demo path to the same answers", async () => {
    async function demoAnswers(tone: "technical" | "plain") {
      const { prompt, io, transcript } = recordingPrompter(scriptedPrompter({ select: [tone] }));
      const answers = await promptSetupAnswers(wizardOpts(prompt, io));
      return { answers, transcript };
    }
    const technical = await demoAnswers("technical");
    const plain = await demoAnswers("plain");
    const { tone: _t, ...technicalRest } = technical.answers;
    const { tone: _p, ...plainRest } = plain.answers;
    expect(technicalRest).toEqual(plainRest);
    expect(technical.answers.path).toBe("demo");
    expect(technical.answers.demoEngine).toBe("duckdb");
    expect(technical.answers.demoYaml).toBeUndefined();
    expect(technical.answers.client).toBeNull();
    expect(technical.answers.tone).toBe("technical");
    expect(plain.answers.tone).toBe("plain");
    expect(technical.transcript.some((e) => e.question === wizardCopy("technical").pathQuestion)).toBe(true);
    expect(plain.transcript.some((e) => e.question === PATH_QUESTION)).toBe(true);
  });

  it("does not write setup_tone if you cancel at confirm", async () => {
    const home = tempDir();
    await expect(
      promptSetupAnswers({
        ...wizardOpts(scriptedPrompter({ select: ["plain"], confirm: [false] }), quiet),
        homeDir: home,
      }),
    ).rejects.toThrow(/Setup cancelled/);
    expect(existsSync(localGraneConfigPath(home))).toBe(false);
    expect(readSetupTone(home)).toBeNull();
  });

  it("refuses invalid user-local JSON before asking tone and leaves the file", async () => {
    const home = tempDir();
    mkdirSync(join(home, ".grane"));
    const file = localGraneConfigPath(home);
    writeFileSync(file, "{nope");
    const recorded = recordingPrompter(scriptedPrompter({ select: ["plain"] }));
    await expect(
      promptSetupAnswers({
        ...wizardOpts(recorded.prompt, recorded.io),
        homeDir: home,
      }),
    ).rejects.toThrow(/not valid JSON/);
    expect(recorded.transcript.filter((e) => e.kind === "select")).toEqual([]);
    expect(readFileSync(file, "utf8")).toBe("{nope");
  });

  it("--yes does not ask the tone question or write user-local config", async () => {
    const home = tempDir();
    const dir = tempDir();
    const recorded = recordingPrompter(scriptedPrompter({ select: ["plain"] }));
    await runSetup({
      yes: true,
      path: "own",
      dir,
      url: "postgres://ro@localhost:5432/app",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      homeDir: home,
      env: { ...process.env },
      io: quiet,
      prompt: recorded.prompt,
    });
    expect(recorded.transcript.filter((e) => e.kind === "select")).toEqual([]);
    expect(existsSync(localGraneConfigPath(home))).toBe(false);
    expect(readSetupTone(home)).toBeNull();
  });
  it("--yes --path own does not write a pin, authoring block, or demo-authoring marker", async () => {
    const dir = tempDir();
    await runSetup({
      yes: true,
      path: "own",
      dir,
      url: "postgres://ro@localhost:5432/app",
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      env: { ...process.env },
      io: quiet,
    });
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, DEMO_AUTHORING_MARKER))).toBe(false);
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).not.toMatch(/^authoring:\n\s+enabled:\s*true/m);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toBe(METRICS_YML);
  });
});

function flagResultShape(result: SetupResult): Record<string, unknown> {
  return {
    path: result.path,
    warehouse: result.warehouse,
    client: result.client,
    question: result.question,
    validated: result.validated,
    live: result.live,
    connect: result.connect,
    demoEngine: result.demoEngine ?? null,
    demoYaml: result.demoYaml ?? null,
  };
}

function normalizeSetupLog(logs: string[], projectDir: string): string {
  const text = logs.join("\n").split(projectDir).join("<PROJECT>");
  return text.endsWith("\n") ? text : `${text}\n`;
}

function wizardOpts(prompt: Prompter, io: { log: (line: string) => void; error: (line: string) => void }) {
  return {
    io,
    prompt,
    env: {},
    homeDir: tempDir(),
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
