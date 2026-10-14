/**
 * V2-15 AC3: import/validate never activate a config (no pin write) and
 * never overwrite the user's original YAML. Byte-identical originals;
 * `.grane/active.json` unchanged.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_PIN_PATH, readActivePin, writeActivePin } from "../../src/authoring/git.js";
import { writeInitProject } from "../../src/cli/init-project.js";
import { runSetup } from "../../src/setup/run.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-import-safety-"));
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

function initProjectRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeInitProject(dir);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "existing yaml"]);
  return dir;
}

function snapshotAllYaml(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const name of ["grane.yml", "grane.yaml", "metrics.yml", "dimensions.yml", "relationships.yml"]) {
    const path = join(dir, name);
    if (existsSync(path)) out[name] = readFileSync(path);
  }
  return out;
}

function assertByteIdentical(before: Record<string, Buffer>, dir: string): void {
  const after = snapshotAllYaml(dir);
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  for (const [name, bytes] of Object.entries(before)) {
    expect(after[name]!.equals(bytes), `${name} was overwritten`).toBe(true);
  }
}

function runCli(args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

afterEach(() => {
  while (temps.length > 0) {
    const dir = temps.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("import/validate never pin and never overwrite originals", () => {
  it("setup --import leaves YAML byte-identical and does not write active.json", async () => {
    const dir = initProjectRepo();
    const before = snapshotAllYaml(dir);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);

    const result = await runSetup({
      importDir: dir,
      dir,
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      stdoutIsTty: false,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: { log: () => undefined, error: () => undefined },
    });
    expect(result.validated).toBe(true);
    assertByteIdentical(before, dir);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(readActivePin(dir)).toBeNull();
  });

  it("setup --import does not change an existing active.json", async () => {
    const dir = initProjectRepo();
    const commit = git(dir, ["rev-parse", "HEAD"]);
    const pin = writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const pinBytes = readFileSync(join(dir, ACTIVE_PIN_PATH));
    const before = snapshotAllYaml(dir);

    await runSetup({
      importDir: dir,
      dir,
      skipConnect: true,
      offline: true,
      stdinIsTty: false,
      stdoutIsTty: false,
      homeDir: tempDir(),
      workspaceDir: tempDir(),
      io: { log: () => undefined, error: () => undefined },
    });

    assertByteIdentical(before, dir);
    expect(readFileSync(join(dir, ACTIVE_PIN_PATH)).equals(pinBytes)).toBe(true);
    expect(readActivePin(dir)).toEqual(pin);
  });

  it("grane validate leaves YAML byte-identical and does not write active.json", () => {
    const dir = initProjectRepo();
    const before = snapshotAllYaml(dir);
    const cli = runCli(["-p", dir, "validate", "--offline"]);
    expect(cli.status, cli.stderr || cli.stdout).toBe(0);
    assertByteIdentical(before, dir);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(readActivePin(dir)).toBeNull();
  });

  it("grane validate does not change an existing active.json", () => {
    const dir = initProjectRepo();
    const commit = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const pinBytes = readFileSync(join(dir, ACTIVE_PIN_PATH));
    const before = snapshotAllYaml(dir);
    const cli = runCli(["-p", dir, "validate", "--offline"]);
    expect(cli.status, cli.stderr || cli.stdout).toBe(0);
    assertByteIdentical(before, dir);
    expect(readFileSync(join(dir, ACTIVE_PIN_PATH)).equals(pinBytes)).toBe(true);
  });

  it("CLI setup --import --offline matches the library contract", () => {
    const dir = initProjectRepo();
    mkdirSync(join(dir, ".grane"), { recursive: true });
    const before = snapshotAllYaml(dir);
    const cli = runCli(["setup", "--import", dir, "--offline"]);
    expect(cli.status, cli.stderr || cli.stdout).toBe(0);
    assertByteIdentical(before, dir);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
  });
});
