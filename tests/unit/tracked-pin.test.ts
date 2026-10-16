import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_PIN_PATH,
  PIN_BRANCH_PREFIX,
  TRACKED_PIN_PATH,
  LEGACY_PIN_MIGRATION,
  approveProposal,
  createProposal,
  isTrackedPinPlan,
  loadServingConfig,
  pinCommitUnmatchedMessage,
  pinHealthWarnings,
  readActivePin,
  readMergedApproval,
  readTrackedPin,
  resolveProposalMergedCommit,
  rollbackPin,
  writeActivePin,
} from "../../src/authoring/git.js";
import { stableConfigHash } from "../../src/config/hash.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-tracked-pin-"));
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

const EMPTY_METRICS = "metrics: {}\n";

const REVENUE = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
`;

const INVALID = `metrics:
  broken:
    entity: nosuch
    type: sum
    sql: "\${orders.net_amount}"
`;

function writeShop(dir: string, metrics = EMPTY_METRICS): void {
  mkdirSync(join(dir, ".grane"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  writeFileSync(join(dir, "grane.yml"), GRANE_YML);
  writeFileSync(join(dir, "metrics.yml"), metrics);
}

function configureGit(dir: string, name = "Grane Test"): void {
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", name]);
}

function runCli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", "-p", dir, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 45_000,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** Start `serve --stdio` long enough to print pin warnings, then stop it. */
async function runServeStdio(dir: string): Promise<{ stdout: string; stderr: string }> {
  const child = spawn("npx", ["tsx", "src/cli/index.ts", "-p", dir, "serve", "--stdio"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  const started = Date.now();
  while (Date.now() - started < 15_000) {
    if (/WARNING:|origin\/main has grane\.pin\.json|local-only|Keeping the last good local pin/.test(`${stderr}\n${stdout}`)) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 2000);
  });
  return { stdout, stderr };
}

function mergeProposal(dir: string, proposal: { id: string; branch: string }): string {
  git(dir, [
    "merge",
    "--no-ff",
    "-m",
    `Merge pull request #1 from ${proposal.branch}\n\nGrane-Proposal: ${proposal.id}`,
    proposal.branch,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function squashProposal(dir: string, proposal: { id: string; branch: string }): string {
  git(dir, ["merge", "--squash", proposal.branch]);
  git(dir, [
    "commit",
    "-m",
    `Squash pull request from ${proposal.branch}\n\nGrane-Proposal: ${proposal.id}`,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function laterUnrelatedCommit(dir: string, message = "later work on main"): string {
  writeFileSync(join(dir, "NOTES.md"), `${message}\n`);
  git(dir, ["add", "NOTES.md"]);
  git(dir, ["commit", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function isReachableFromBase(dir: string, commit: string, base = "main"): boolean {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", commit, `refs/heads/${base}`], {
    cwd: dir,
    encoding: "utf8",
  });
  return (result.status ?? 1) === 0;
}

function pinBranches(dir: string): string[] {
  const raw = spawnSync("git", ["for-each-ref", "--format=%(refname:short)", `refs/heads/${PIN_BRANCH_PREFIX}`], {
    cwd: dir,
    encoding: "utf8",
  });
  return (raw.stdout ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("tracked pin (T1)", () => {
  it("createProposal refuses grane.pin.json", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    expect(() =>
      createProposal(dir, {
        slug: "agent-pin",
        files: {
          [TRACKED_PIN_PATH]: JSON.stringify({
            ref: "main",
            commit: "a".repeat(40),
            approved_by: "agent",
            approved_at: "now",
          }),
        },
      }),
    ).toThrow(/grane\.pin\.json|proposal branch/);
    expect(existsSync(join(dir, TRACKED_PIN_PATH))).toBe(false);
  });

  it("legacy local pin is honoured with a migration warning when no tracked pin exists", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir, REVENUE);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const main = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-16T12:00:00.000Z",
    });
    const serving = loadServingConfig(dir);
    expect(serving.pin_source).toBe("legacy");
    expect(serving.pin?.commit).toBe(main);
    expect(serving.pin_warnings.join("\n")).toMatch(/local-only/);
    expect(Object.keys(serving.config.metrics)).toContain("revenue");
  });

  it("invalid YAML is refused before any pin write", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const mainBefore = git(dir, ["rev-parse", "main"]);
    const proposal = createProposal(dir, {
      slug: "broken",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": INVALID },
    });
    mergeProposal(dir, proposal);
    const merged = git(dir, ["rev-parse", "main"]);
    expect(() => approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" })).toThrow(
      /invalid YAML/,
    );
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(existsSync(join(dir, TRACKED_PIN_PATH))).toBe(false);
    expect(pinBranches(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
    expect(merged).not.toBe(mainBefore);
    expect(readActivePin(dir)).toBeNull();
  });

  it("CLI approve refuses a pin to a commit that is not on main", { timeout: 60_000 }, () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "unmerged",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const main = git(dir, ["rev-parse", "main"]);
    const cli = runCli(dir, ["proposals", "approve", proposal.id, "--approved-by", "octocat"]);
    expect(cli.status).not.toBe(0);
    expect(`${cli.stderr}\n${cli.stdout}`).toMatch(/TTY or a merged GitHub PR|Merge the GitHub PR|does not merge/);
    expect(pinBranches(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
    expect(() =>
      writeActivePin(dir, {
        ref: "main",
        commit: proposal.commit,
        approved_by: "octocat",
        approved_at: "2026-10-16T12:00:00.000Z",
      }),
    ).toThrow(/not reachable|Refusing to pin/);
  });

  it("approve validates, writes last-good local pin, commits tracked pin on a pin branch, does not move main", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const merged = mergeProposal(dir, proposal);
    const result = approveProposal(dir, proposal.id, {
      tty: false,
      approved_by: "octocat",
      at: new Date("2026-10-16T15:00:00.000Z"),
    });
    expect(result.commit).toBe(merged);
    expect(result.pin_file).toBe(TRACKED_PIN_PATH);
    expect(result.pin_branch).toMatch(new RegExp(`^${PIN_BRANCH_PREFIX}`));
    expect(result.github.command).toMatch(/^gh pr create /);
    expect(result.github.command).toContain(`--head ${result.pin_branch}`);
    expect(result.github.command).not.toMatch(/pr merge|git push|git tag|npm publish/);
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(existsSync(join(dir, TRACKED_PIN_PATH))).toBe(false);
    expect(readActivePin(dir)?.commit).toBe(merged);
    const trackedAtPin = git(dir, ["show", `${result.pin_branch}:${TRACKED_PIN_PATH}`]);
    expect(JSON.parse(trackedAtPin).commit).toBe(merged);
    expect(isReachableFromBase(dir, result.commit)).toBe(true);
  });

  it("pinned commit must be reachable from the configured base branch", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const merged = mergeProposal(dir, proposal);
    const tip = laterUnrelatedCommit(dir);
    const result = approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(result.commit).toBe(merged);
    expect(result.commit).not.toBe(tip);
    expect(isReachableFromBase(dir, result.commit)).toBe(true);
    expect(git(dir, ["rev-parse", "main"])).toBe(tip);

    git(dir, ["checkout", "-b", "side"]);
    writeFileSync(join(dir, "SIDE.md"), "not on main\n");
    git(dir, ["add", "SIDE.md"]);
    git(dir, ["commit", "-m", "side only"]);
    const side = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "main"]);
    expect(isReachableFromBase(dir, side)).toBe(false);
    expect(() =>
      writeActivePin(dir, {
        ref: "main",
        commit: side,
        approved_by: "octocat",
        approved_at: "2026-10-16T12:00:00.000Z",
      }),
    ).toThrow(/not reachable|Refusing to pin/);
  });

  it("merge: approve pins the merge commit, not a later base tip", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const merged = mergeProposal(dir, proposal);
    const tip = laterUnrelatedCommit(dir, "docs after merge");
    const approval = readMergedApproval(dir, proposal.id, { against: "base" });
    expect(approval.merged).toBe(true);
    expect(approval.merge_commit).toBe(merged);
    expect(approval.merge_commit).not.toBe(tip);
    expect(resolveProposalMergedCommit(dir, proposal.commit, tip)).toBe(merged);
    const result = approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(result.commit).toBe(merged);
    expect(result.commit).not.toBe(tip);
    expect(isReachableFromBase(dir, result.commit)).toBe(true);
  });

  it("squash: approve pins the squash commit whose metric YAML matches, not the tip", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const squashed = squashProposal(dir, proposal);
    expect(isReachableFromBase(dir, proposal.commit)).toBe(false);
    const tip = laterUnrelatedCommit(dir, "docs after squash");
    const approval = readMergedApproval(dir, proposal.id, { against: "base" });
    expect(approval.merged).toBe(true);
    expect(approval.merge_commit).toBe(squashed);
    expect(approval.merge_commit).not.toBe(tip);
    expect(approval.merge_commit).not.toBe(proposal.commit);
    const result = approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(result.commit).toBe(squashed);
    expect(result.commit).not.toBe(tip);
    expect(isReachableFromBase(dir, result.commit)).toBe(true);
    expect(JSON.parse(git(dir, ["show", `${result.pin_branch}:${TRACKED_PIN_PATH}`])).commit).toBe(squashed);
  });

  it("rollback with a tracked pin prepares a pin branch and never pushes or merges", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const initial = git(dir, ["rev-parse", "HEAD"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const merged = mergeProposal(dir, proposal);
    writeActivePin(dir, {
      ref: "main",
      commit: initial,
      approved_by: "octocat",
      approved_at: "2026-10-16T12:00:00.000Z",
    });
    const approved = approveProposal(dir, proposal.id, {
      tty: false,
      approved_by: "octocat",
      at: new Date("2026-10-16T15:00:00.000Z"),
    });
    git(dir, ["merge", "--no-ff", "-m", "Merge pin", approved.pin_branch]);
    expect(readTrackedPin(dir)?.commit).toBe(merged);
    const mainBefore = git(dir, ["rev-parse", "main"]);

    const rolled = rollbackPin(dir, {
      approved_by: "octocat",
      at: new Date("2026-10-16T16:00:00.000Z"),
    });
    expect(isTrackedPinPlan(rolled)).toBe(true);
    if (!isTrackedPinPlan(rolled)) throw new Error("expected pin plan");
    expect(rolled.commit).toBe(initial);
    expect(rolled.pin_file).toBe(TRACKED_PIN_PATH);
    expect(rolled.pin_branch).toMatch(/-rollback$/);
    expect(rolled.github.command).toMatch(/^gh pr create /);
    expect(rolled.github.command).toContain(`--head ${rolled.pin_branch}`);
    expect(rolled.github.command).not.toMatch(/pr merge|git push|git tag|npm publish/);
    expect(git(dir, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(JSON.parse(git(dir, ["show", `${rolled.pin_branch}:${TRACKED_PIN_PATH}`])).commit).toBe(initial);
    expect(readTrackedPin(dir)?.commit).toBe(merged);
    const beforeMerge = loadServingConfig(dir);
    expect(beforeMerge.pin?.commit).toBe(merged);
    expect(Object.keys(beforeMerge.config.metrics)).toContain("revenue");

    git(dir, ["merge", "--no-ff", "-m", "Merge rollback pin", rolled.pin_branch]);
    const after = loadServingConfig(dir);
    expect(after.pin?.commit).toBe(initial);
    expect(Object.keys(after.config.metrics)).not.toContain("revenue");
  });

  it("refuses a symlinked grane.pin.json", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const main = git(dir, ["rev-parse", "HEAD"]);
    const outside = join(tmpdir(), `grane-pin-symlink-${process.pid}.json`);
    writeFileSync(
      outside,
      JSON.stringify({
        ref: "main",
        commit: main,
        approved_by: "attacker",
        approved_at: "2026-10-16T12:00:00.000Z",
      }),
    );
    symlinkSync(outside, join(dir, TRACKED_PIN_PATH));
    expect(() => readTrackedPin(dir)).toThrow(/symlink|regular file/);
    expect(() => readActivePin(dir)).toThrow(/symlink|regular file/);
    expect(() => loadServingConfig(dir)).toThrow(/symlink|regular file/);
  });

  it("rebase: approve pins the rebased commit whose metric YAML matches, not the tip", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    laterUnrelatedCommit(dir, "main moved before rebase");
    git(dir, ["checkout", "-B", "tmp-rebase", proposal.branch]);
    git(dir, ["rebase", "main"]);
    const rebased = git(dir, ["rev-parse", "HEAD"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["merge", "--ff-only", "tmp-rebase"]);
    git(dir, ["branch", "-D", "tmp-rebase"]);
    expect(git(dir, ["rev-parse", proposal.branch])).toBe(proposal.commit);
    expect(isReachableFromBase(dir, proposal.commit)).toBe(false);
    expect(isReachableFromBase(dir, rebased)).toBe(true);
    const tip = laterUnrelatedCommit(dir, "docs after rebase");
    const approval = readMergedApproval(dir, proposal.id, { against: "base" });
    expect(approval.merged).toBe(true);
    expect(approval.merge_commit).toBe(rebased);
    expect(approval.merge_commit).not.toBe(tip);
    expect(approval.merge_commit).not.toBe(proposal.commit);
    const result = approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(result.commit).toBe(rebased);
    expect(result.commit).not.toBe(tip);
    expect(isReachableFromBase(dir, result.commit)).toBe(true);
  });

  it("squash with non-matching metric YAML refuses and does not pin the tip", () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    git(dir, ["merge", "--squash", proposal.branch]);
    writeFileSync(
      join(dir, "metrics.yml"),
      `metrics:
  other:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`,
    );
    git(dir, ["add", "metrics.yml"]);
    git(dir, ["commit", "-m", "squash with different metrics"]);
    const tip = git(dir, ["rev-parse", "HEAD"]);
    expect(isReachableFromBase(dir, proposal.commit)).toBe(false);
    const approval = readMergedApproval(dir, proposal.id, { against: "base" });
    expect(approval.merged).toBe(false);
    expect(approval.merge_commit).toBeNull();
    expect(resolveProposalMergedCommit(dir, proposal.commit, tip)).toBeNull();
    expect(() => approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" })).toThrow(
      /will not silently pin|metric YAML matching/,
    );
    expect(() => approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" })).toThrow(
      pinCommitUnmatchedMessage(approval).slice(0, 80),
    );
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(existsSync(join(dir, TRACKED_PIN_PATH))).toBe(false);
    expect(pinBranches(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(tip);
  });
});

describe("tracked pin two-clone (real CLI, no network)", () => {
  function setupOriginAndClones(): { origin: string; a: string; b: string } {
    const root = tempDir();
    const origin = join(root, "origin.git");
    mkdirSync(origin, { recursive: true });
    git(origin, ["init", "--bare", "-b", "main"]);
    const a = join(root, "A");
    git(root, ["clone", origin, a]);
    configureGit(a, "Clone A");
    writeShop(a);
    git(a, ["add", "-A"]);
    git(a, ["commit", "-m", "initial"]);
    git(a, ["push", "-u", "origin", "main"]);
    const b = join(root, "B");
    git(root, ["clone", origin, b]);
    configureGit(b, "Clone B");
    return { origin, a, b };
  }

  it("B pulls and serves the same pinned commit, metrics, and config hash as A", { timeout: 90_000 }, () => {
    const { a, b } = setupOriginAndClones();
    const proposal = createProposal(a, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const merged = mergeProposal(a, proposal);
    git(a, ["push", "origin", "main"]);
    const approved = runCli(a, [
      "proposals",
      "approve",
      proposal.id,
      "--json",
      "--approved-by",
      "Ada",
    ]);
    expect(approved.status, approved.stderr).toBe(0);
    const payload = JSON.parse(approved.stdout) as { commit: string; pin_branch: string; github: { command: string } };
    expect(payload.commit).toBe(merged);
    expect(payload.github.command).toMatch(/^gh pr create /);
    expect(git(a, ["rev-parse", "main"])).toBe(merged);

    git(a, ["push", "origin", payload.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", `Merge pin PR from ${payload.pin_branch}`, payload.pin_branch]);
    git(a, ["push", "origin", "main"]);

    git(b, ["pull", "origin", "main"]);
    expect(readTrackedPin(b)?.commit).toBe(merged);
    const serveA = loadServingConfig(a);
    const serveB = loadServingConfig(b);
    expect(serveA.pin?.commit).toBe(serveB.pin?.commit);
    expect(serveA.pin?.commit).toBe(merged);
    expect(Object.keys(serveA.config.metrics).sort()).toEqual(Object.keys(serveB.config.metrics).sort());
    expect(Object.keys(serveB.config.metrics)).toContain("revenue");
    const hashA = stableConfigHash(serveA.config, serveA.projectDir);
    const hashB = stableConfigHash(serveB.config, serveB.projectDir);
    expect(hashA).toBe(hashB);
    expect(new GraneKernel(serveA.config, { projectDir: serveA.projectDir, activePin: serveA.pin }).serverInfo().config_hash).toBe(
      new GraneKernel(serveB.config, { projectDir: serveB.projectDir, activePin: serveB.pin }).serverInfo().config_hash,
    );
  });

  it("competing approvals conflict and a stale clone is warned, keeping the last good pin", { timeout: 90_000 }, () => {
    const { a, b } = setupOriginAndClones();
    const first = createProposal(a, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    mergeProposal(a, first);
    git(a, ["push", "origin", "main"]);
    git(b, ["pull", "origin", "main"]);

    const extra = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
  extras:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`;
    const second = createProposal(a, {
      slug: "extras",
      at: new Date("2026-10-16T01:00:00.000Z"),
      files: { "metrics.yml": extra },
    });
    mergeProposal(a, second);
    git(a, ["push", "origin", "main"]);
    git(a, ["push", "origin", first.branch, second.branch]);
    git(b, ["pull", "origin", "main"]);
    git(b, ["fetch", "origin"]);
    git(b, ["branch", second.branch, `origin/${second.branch}`]);

    const approveA = runCli(a, ["proposals", "approve", first.id, "--json", "--approved-by", "Ada"]);
    expect(approveA.status, approveA.stderr).toBe(0);
    const pinA = JSON.parse(approveA.stdout) as { pin_branch: string; commit: string; approved_by: string };

    const approveB = runCli(b, ["proposals", "approve", second.id, "--json", "--approved-by", "Bea"]);
    expect(approveB.status, approveB.stderr).toBe(0);
    const pinB = JSON.parse(approveB.stdout) as { pin_branch: string; commit: string; approved_by: string };
    expect(pinA.pin_branch).not.toBe(pinB.pin_branch);
    expect(pinA.approved_by).not.toBe(pinB.approved_by);
    expect(pinA.commit).not.toBe(pinB.commit);

    git(a, ["push", "origin", pinA.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", "Merge pin A", pinA.pin_branch]);
    git(a, ["push", "origin", "main"]);

    git(b, ["fetch", "origin"]);
    const originPin = JSON.parse(git(b, ["show", `origin/main:${TRACKED_PIN_PATH}`])) as { commit: string };
    expect(originPin.commit).toBe(pinA.commit);
    expect(originPin.commit).not.toBe(pinB.commit);
    const stale = pinHealthWarnings(b);
    expect(stale.join("\n")).toMatch(/differs from origin|Keeping the last good local pin/);
    const staleServe = loadServingConfig(b);
    expect(staleServe.pin?.commit).toBe(pinB.commit);
    expect(staleServe.pin?.commit).not.toBe(originPin.commit);
    expect(Object.keys(staleServe.config.metrics)).toContain("extras");
    expect(staleServe.pin_warnings.join("\n")).toMatch(/Keeping the last good local pin/);

    git(b, ["push", "origin", pinB.pin_branch]);
    git(b, ["checkout", "main"]);
    git(b, ["merge", "origin/main"]);
    const conflict = spawnSync("git", ["merge", "--no-ff", "-m", "Merge pin B", pinB.pin_branch], {
      cwd: b,
      encoding: "utf8",
    });
    expect(conflict.status).not.toBe(0);
    expect(`${conflict.stdout}\n${conflict.stderr}`).toMatch(/conflict|CONFLICT|Automatic merge failed/i);
  });

  it("serve stays on the local pin when origin has a different commit (no auto-switch)", { timeout: 90_000 }, async () => {
    const { a, b } = setupOriginAndClones();
    const first = createProposal(a, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    const revenueMerged = mergeProposal(a, first);
    git(a, ["push", "origin", "main"]);
    const approveRevenue = runCli(a, ["proposals", "approve", first.id, "--json", "--approved-by", "Ada"]);
    expect(approveRevenue.status, approveRevenue.stderr).toBe(0);
    const pinRevenue = JSON.parse(approveRevenue.stdout) as { pin_branch: string; commit: string };
    expect(pinRevenue.commit).toBe(revenueMerged);
    git(a, ["push", "origin", pinRevenue.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", "Merge revenue pin", pinRevenue.pin_branch]);
    git(a, ["push", "origin", "main"]);
    git(b, ["pull", "origin", "main"]);
    expect(readTrackedPin(b)?.commit).toBe(revenueMerged);
    expect(Object.keys(loadServingConfig(b).config.metrics)).toEqual(["revenue"]);

    const extra = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
  extras:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`;
    const second = createProposal(a, {
      slug: "extras",
      at: new Date("2026-10-16T01:00:00.000Z"),
      files: { "metrics.yml": extra },
    });
    const extrasMerged = mergeProposal(a, second);
    git(a, ["push", "origin", "main"]);
    const approveExtras = runCli(a, ["proposals", "approve", second.id, "--json", "--approved-by", "Ada"]);
    expect(approveExtras.status, approveExtras.stderr).toBe(0);
    const pinExtras = JSON.parse(approveExtras.stdout) as { pin_branch: string; commit: string };
    expect(pinExtras.commit).toBe(extrasMerged);
    expect(pinExtras.commit).not.toBe(revenueMerged);
    git(a, ["push", "origin", pinExtras.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", "Merge extras pin", pinExtras.pin_branch]);
    git(a, ["push", "origin", "main"]);

    git(b, ["fetch", "origin"]);
    const originPin = JSON.parse(git(b, ["show", `origin/main:${TRACKED_PIN_PATH}`])) as { commit: string };
    expect(originPin.commit).toBe(extrasMerged);
    expect(originPin.commit).not.toBe(revenueMerged);
    const serve = loadServingConfig(b);
    expect(serve.pin?.commit).toBe(revenueMerged);
    expect(serve.pin?.commit).not.toBe(originPin.commit);
    expect(Object.keys(serve.config.metrics)).toEqual(["revenue"]);
    expect(Object.keys(serve.config.metrics)).not.toContain("extras");
    expect(serve.pin_warnings.join("\n")).toMatch(/differs from origin|Keeping the last good local pin/);
    const served = await runServeStdio(b);
    expect(`${served.stderr}\n${served.stdout}`).toMatch(/differs from origin|Keeping the last good local pin/);
  });

  it("serve warns when this clone has no pin but origin has one", { timeout: 90_000 }, async () => {
    const { a, b } = setupOriginAndClones();
    const proposal = createProposal(a, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    mergeProposal(a, proposal);
    git(a, ["push", "origin", "main"]);
    const approved = runCli(a, ["proposals", "approve", proposal.id, "--json", "--approved-by", "Ada"]);
    expect(approved.status, approved.stderr).toBe(0);
    const payload = JSON.parse(approved.stdout) as { pin_branch: string };
    git(a, ["push", "origin", payload.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", "Merge pin", payload.pin_branch]);
    git(a, ["push", "origin", "main"]);
    git(b, ["fetch", "origin"]);
    expect(readTrackedPin(b)).toBeNull();
    expect(readActivePin(b)).toBeNull();
    const serve = loadServingConfig(b);
    expect(serve.pin).toBeNull();
    expect(serve.pin_warnings.join("\n")).toMatch(/origin\/main has grane\.pin\.json/);
    expect(serve.pin_warnings.join("\n")).toMatch(/not auto-switching/);
    const cli = await runServeStdio(b);
    expect(`${cli.stderr}\n${cli.stdout}`).toMatch(/origin\/main has grane\.pin\.json/);
  });

  it("legacy pin migration warning is printed on serve stderr", { timeout: 60_000 }, async () => {
    const dir = tempDir();
    git(dir, ["init", "-b", "main"]);
    configureGit(dir);
    writeShop(dir, REVENUE);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const main = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-16T12:00:00.000Z",
    });
    const serving = loadServingConfig(dir);
    expect(serving.pin_source).toBe("legacy");
    expect(serving.pin_warnings.join("\n")).toMatch(/local-only/);
    expect(serving.pin_warnings.join("\n")).toContain(LEGACY_PIN_MIGRATION);
    const cli = await runServeStdio(dir);
    expect(cli.stderr).toMatch(/local-only/);
    expect(cli.stderr).toContain("WARNING:");
  });

  it("doctor JSON includes pin_warnings and config_hash; exit code follows lint.ok", { timeout: 60_000 }, () => {
    const { a, b } = setupOriginAndClones();
    const proposal = createProposal(a, {
      slug: "revenue",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": REVENUE },
    });
    mergeProposal(a, proposal);
    git(a, ["push", "origin", "main"]);
    const approved = runCli(a, ["proposals", "approve", proposal.id, "--json", "--approved-by", "Ada"]);
    expect(approved.status, approved.stderr).toBe(0);
    const payload = JSON.parse(approved.stdout) as { pin_branch: string };
    git(a, ["push", "origin", payload.pin_branch]);
    git(a, ["merge", "--no-ff", "-m", "Merge pin", payload.pin_branch]);
    git(a, ["push", "origin", "main"]);
    git(b, ["fetch", "origin"]);
    const doctor = runCli(b, ["doctor", "--json"]);
    const body = JSON.parse(doctor.stdout) as { ok: boolean; pin_warnings: string[]; config_hash: string };
    expect(body.pin_warnings.join("\n")).toMatch(/origin\/main has grane\.pin\.json|Keeping the last good local pin/);
    expect(body.config_hash).toMatch(/^[0-9a-f]{16,}$/i);
    expect(doctor.status).toBe(body.ok ? 0 : 1);
  });
});

describe("stableConfigHash ignores absolute paths", () => {
  it("two clones with different projectDirs hash equal", () => {
    const a = tempDir();
    const b = tempDir();
    writeFileSync(join(a, "grane.yml"), GRANE_YML);
    writeFileSync(join(a, "metrics.yml"), REVENUE);
    writeFileSync(join(b, "grane.yml"), GRANE_YML);
    writeFileSync(join(b, "metrics.yml"), REVENUE);
    const cfgA = loadConfig(a);
    const cfgB = loadConfig(b);
    expect(stableConfigHash(cfgA.config, cfgA.projectDir)).toBe(stableConfigHash(cfgB.config, cfgB.projectDir));
  });
});
