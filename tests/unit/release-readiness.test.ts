process.env.TZ = "UTC";

import { afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { runDoctor } from "../../src/mcp/connect/doctor.js";
import { npmInstallName, loadOptionalModule } from "../../src/connectors/types.js";
import { assertInitProviderPath } from "../../src/cli/init-provider.js";
import { formatDemoNextSteps } from "../../src/demo/run.js";

const execFileAsync = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const cli = join(repoRoot, "src/cli/index.ts");

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "grane-ready-"));
}

function writeProject(dir: string, yaml: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "grane.yml"), yaml);
}

const MINIMAL = `project:
  name: ready
  timezone: UTC
connection:
  type: duckdb
  path: ":memory:"
  schema: main
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
    time_dimension: "\${orders.ordered_at}"
`;

async function runCli(dir: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], {
      cwd: repoRoot,
      timeout: 30000,
    });
    return { code: 0, stdout: out.stdout, stderr: out.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

describe("CLI --json refusals", () => {
  const dir = tempDir();
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeProject(dir, MINIMAL);

  it("undefined_metric is valid JSON on stdout with a non-zero exit", async () => {
    const result = await runCli(dir, ["query", "ghost", "--json"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim()).not.toMatch(/^ERROR/);
    const body = JSON.parse(result.stdout) as { ok: false; status: string; message: string; similar?: string[] };
    expect(body.ok).toBe(false);
    expect(body.status).toBe("undefined_metric");
    expect(body.message).toMatch(/ghost/);
    if (body.similar) expect(body.similar).toEqual(expect.arrayContaining([expect.any(String)]));
  });

  it("invalid_query is valid JSON when no metric is selected", async () => {
    const result = await runCli(dir, ["query", "--json"]);
    expect(result.code).toBe(1);
    const body = JSON.parse(result.stdout) as { ok: false; status: string; message: string };
    expect(body.status).toBe("invalid_query");
    expect(body.message).toMatch(/at least one/);
  });

  it("unsafe_query is valid JSON when a requested grain is finer than the metric", async () => {
    const grainDir = tempDir();
    writeProject(
      grainDir,
      `project:
  name: ready
  timezone: UTC
connection:
  type: duckdb
  path: ":memory:"
  schema: main
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
    time_dimension: "\${orders.ordered_at}"
    time_granularity: month
`,
    );
    try {
      const result = await runCli(grainDir, ["query", "revenue", "--last", "last_month", "--grain", "day", "--json"]);
      expect(result.code).toBe(1);
      const body = JSON.parse(result.stdout) as { ok: false; status: string; message: string };
      expect(body.status).toBe("unsafe_query");
      expect(body.message.toLowerCase()).toMatch(/grain|time/);
    } finally {
      rmSync(grainDir, { recursive: true, force: true });
    }
  });

  it("configuration failure is valid JSON", async () => {
    const empty = tempDir();
    try {
      const result = await runCli(empty, ["query", "revenue", "--json"]);
      expect(result.code).toBe(1);
      const body = JSON.parse(result.stdout) as { ok: false; status: string; message: string };
      expect(body.status).toBe("config_error");
      expect(body.message).toMatch(/grane\.yml/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it("without --json keeps the human ERROR line on stderr", async () => {
    const result = await runCli(dir, ["query", "ghost"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^ERROR \(undefined_metric\):/);
    expect(result.stdout).not.toMatch(/"status":\s*"undefined_metric"/);
  });
});

describe("unreachable warehouse errors", () => {
  it("PostgreSQL connection refusal is a useful warehouse error", async () => {
    const dir = tempDir();
    writeProject(
      dir,
      `project:
  name: down
  timezone: UTC
connection:
  type: postgres
  url: postgres://readonly:hunter2@127.0.0.1:1/grane_demo
  schema: public
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
`,
    );
    try {
      const loaded = loadConfig(dir);
      const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
      try {
        await expect(kernel.introspectSchema()).rejects.toThrow(/Cannot reach the PostgreSQL warehouse/);
      } finally {
        await kernel.close();
      }
      const cliResult = await runCli(dir, ["query", "revenue", "--json"]);
      expect(cliResult.code).toBe(1);
      const body = JSON.parse(cliResult.stdout) as { message: string };
      expect(body.message).toMatch(/Cannot reach the PostgreSQL warehouse|warehouse/i);
      expect(body.message).not.toContain("hunter2");
      expect(body.message.length).toBeGreaterThan(20);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a missing DuckDB file is a useful warehouse error", async () => {
    const dir = tempDir();
    writeProject(
      dir,
      `project:
  name: missing-db
  timezone: UTC
connection:
  type: duckdb
  path: missing-warehouse.duckdb
  schema: main
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
`,
    );
    try {
      const loaded = loadConfig(dir);
      const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
      try {
        await expect(kernel.introspectSchema()).rejects.toThrow(/Cannot reach the DuckDB warehouse/);
      } finally {
        await kernel.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mcp doctor readiness", () => {
  it("is ready for a working DuckDB project when MCP is skipped", async () => {
    const dir = tempDir();
    const warehouse = join(dir, "shop.duckdb");
    const duck = (await import("@duckdb/node-api")) as {
      DuckDBInstance: { create: (path: string) => Promise<{ connect: () => Promise<{ run: (sql: string) => Promise<void>; closeSync?: () => void }>; closeSync?: () => void }> };
    };
    const instance = await duck.DuckDBInstance.create(warehouse);
    const conn = await instance.connect();
    await conn.run("CREATE TABLE orders (id INTEGER, amount DOUBLE, ordered_at DATE)");
    await conn.run("INSERT INTO orders VALUES (1, 10, DATE '2026-08-01')");
    conn.closeSync?.();
    instance.closeSync?.();
    writeProject(
      dir,
      `project:
  name: ready
  timezone: UTC
connection:
  type: duckdb
  path: shop.duckdb
  schema: main
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
    time_dimension: "\${orders.ordered_at}"
`,
    );
    try {
      const result = await runDoctor({
        projectDir: dir,
        skipMcp: true,
        launch: { command: "grane", prefixArgs: [], source: "override" },
      });
      expect(result.checks.find((c) => c.name === "schema")?.detail).toMatch(/live OK/);
      expect(result.checks.find((c) => c.name === "schema")?.ok).toBe(true);
      expect(result.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is not ready when the warehouse is unreachable", async () => {
    const dir = tempDir();
    writeProject(
      dir,
      `project:
  name: down
  timezone: UTC
connection:
  type: postgres
  url: postgres://grane:grane@127.0.0.1:1/grane_demo
  schema: public
entities:
  order:
    table: orders
    primary_key: id
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.amount}"
`,
    );
    try {
      const result = await runDoctor({
        projectDir: dir,
        skipMcp: true,
        launch: { command: "grane", prefixArgs: [], source: "override" },
      });
      const schema = result.checks.find((c) => c.name === "schema");
      expect(schema?.ok).toBe(false);
      expect(schema?.level).toBe("error");
      expect(schema?.detail).toMatch(/warehouse unreachable/i);
      expect(result.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mysql2 install hint", () => {
  it("tells the user to install mysql2, not mysql2/promise", async () => {
    expect(npmInstallName("mysql2/promise")).toBe("mysql2");
    expect(npmInstallName("snowflake-sdk")).toBe("snowflake-sdk");
    await expect(loadOptionalModule("mysql2/promise", "MySQL")).rejects.toThrow(/npm install mysql2\b/);
    await expect(loadOptionalModule("mysql2/promise", "MySQL")).rejects.not.toThrow(/npm install mysql2\/promise/);
  });
});

describe("init --provider UX", () => {
  it("fails before writing when the path does not exist", () => {
    const dir = tempDir();
    try {
      expect(() => assertInitProviderPath(dir, "../no-such-dbt")).toThrow(/does not exist/);
      expect(existsSync(join(dir, "grane.yml"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when the path has no sniffable semantic definitions", () => {
    const dir = tempDir();
    const provider = join(dir, "empty-upstream");
    mkdirSync(provider, { recursive: true });
    writeFileSync(join(provider, "README.md"), "not a semantic project\n");
    try {
      expect(() => assertInitProviderPath(dir, "empty-upstream")).toThrow(/No semantic definitions/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a recognisable dbt project path", () => {
    const dir = tempDir();
    const provider = join(dir, "jaffle");
    mkdirSync(provider, { recursive: true });
    writeFileSync(join(provider, "dbt_project.yml"), "name: jaffle\n");
    try {
      expect(assertInitProviderPath(dir, "jaffle")).toBe(provider);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("demo next-step wording", () => {
  it("keeps Docker as an optional Postgres path, not a DuckDB requirement", () => {
    const text = formatDemoNextSteps("/tmp/shop", "docs", false).join("\n");
    expect(text).toMatch(/Docker is not required/);
    expect(text).toMatch(/not used by the DuckDB demo/);
    expect(text).toMatch(/docker compose up/);
  });
});

describe("example seed link", () => {
  it("resolves from example/seed/README.md to demo/seed", () => {
    const readme = join(repoRoot, "example/seed/README.md");
    const match = readFileSync(readme, "utf8").match(/\(([^)]+demo\/seed)\)/);
    expect(match?.[1]).toBe("../../demo/seed");
    expect(existsSync(join(repoRoot, "example/seed", match![1]!))).toBe(true);
  });
});

describe("package artifact hygiene", () => {
  it("excludes source maps, .grane, and generated duckdb from npm pack", async () => {
    const out = await execFileAsync("npm", ["pack", "--dry-run", "--json"], {
      cwd: repoRoot,
      timeout: 60000,
    });
    const payload = JSON.parse(out.stdout) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const files = (payload[0]?.files ?? []).map((f) => f.path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((p) => p.endsWith(".map"))).toEqual([]);
    expect(files.filter((p) => p.includes(".grane"))).toEqual([]);
    expect(files.filter((p) => p.endsWith(".duckdb") || p.endsWith(".duckdb.wal"))).toEqual([]);
  });
});
