import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACTIVE_PIN_PATH,
  PROPOSAL_BRANCH_PREFIX,
  createProposal,
  diffProposal,
  githubPrPlan,
  listProposals,
  readActivePin,
  readMergedApproval,
  rollbackPin,
  writeActivePin,
} from "../../src/authoring/git.js";
import { GraneError } from "../../src/errors.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-git-"));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: string[], opts: { allowFail?: boolean; input?: string } = {}): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", input: opts.input });
  if ((result.status ?? 1) !== 0 && !opts.allowFail) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

const INITIAL_YML = `project: { name: shop }
connection: { type: postgres }
entities:
  order: { table: orders, primary_key: id }
`;

const INITIAL_METRICS = `metrics: {}
`;

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  writeFileSync(join(dir, "grane.yml"), INITIAL_YML);
  writeFileSync(join(dir, "metrics.yml"), INITIAL_METRICS);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial config"]);
  return dir;
}

const DRAFT_METRICS = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
`;

describe("git proposal library", () => {
  it("creates a proposal branch and commit in a temporary repo without moving HEAD or main", () => {
    const dir = initRepo();
    const mainBefore = git(dir, ["rev-parse", "main"]);
    const headBefore = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const metricsBefore = readFileSync(join(dir, "metrics.yml"), "utf8");

    const proposal = createProposal(dir, {
      slug: "Add Revenue!",
      title: "Add experimental revenue",
      at: new Date("2026-10-14T15:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });

    expect(proposal.branch).toBe(`${PROPOSAL_BRANCH_PREFIX}20261014-add-revenue`);
    expect(proposal.id).toBe("20261014-add-revenue");
    expect(proposal.base_branch).toBe("main");
    expect(proposal.base_commit).toBe(mainBefore);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(headBefore);
    expect(git(dir, ["rev-parse", "main"])).toBe(mainBefore);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toBe(metricsBefore);
    expect(git(dir, ["rev-parse", proposal.branch])).toBe(proposal.commit);
    expect(git(dir, ["log", "-1", "--format=%B", proposal.commit])).toMatch(/Grane-Proposal: 20261014-add-revenue/);
    expect(git(dir, ["merge-base", "--is-ancestor", mainBefore, proposal.commit])).toBe("");

    const listed = listProposals(dir);
    expect(listed.map((item) => item.id)).toEqual(["20261014-add-revenue"]);
    expect(listed[0]?.commit).toBe(proposal.commit);
  });

  it("diffs against the active ref, including a semantic name diff", () => {
    const dir = initRepo();
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    const diff = diffProposal(dir, proposal.id);
    expect(diff.files).toContain("metrics.yml");
    expect(diff.unified).toContain("status: experimental");
    expect(diff.unified).toContain("revenue");
    expect(diff.semantic?.metrics.added).toEqual(["revenue"]);
    expect(diff.semantic?.metrics.removed).toEqual([]);
    expect(diff.semantic?.entities).toEqual({ added: [], changed: [], removed: [] });
    expect(diff.semantic?.dimensions).toEqual({ added: [], changed: [], removed: [] });
    expect(diff.semantic?.merge.restored.metrics).toEqual([]);
    expect(diff.semantic?.merge.lost_comments).toEqual([]);
  });

  it("produces a GitHub PR-creation payload and gh command without writing the active branch", () => {
    const dir = initRepo();
    git(dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    const mainSha = git(dir, ["rev-parse", "main"]);
    const plan = githubPrPlan(dir, proposal.branch);
    expect(plan.base).toBe("main");
    expect(plan.head).toBe(proposal.branch);
    expect(plan.repo).toBe("Nareik33L/grane");
    expect(plan.title).toContain(proposal.id);
    expect(plan.body).toMatch(/experimental/);
    expect(plan.body).toMatch(/governed/);
    expect(plan.body).toMatch(/Anyone with merge rights/);
    expect(plan.body).toContain(`Grane-Proposal: ${proposal.id}`);
    expect(plan.command.startsWith("gh pr create ")).toBe(true);
    expect(plan.command).toContain("--base main");
    expect(plan.command).toContain(`--head ${proposal.branch}`);
    expect(git(dir, ["rev-parse", "main"])).toBe(mainSha);
  });

  it("reads merged state after a GitHub-style merge and treats unmerged proposals as experimental", () => {
    const dir = initRepo();
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    const before = readMergedApproval(dir, proposal.id);
    expect(before.merged).toBe(false);
    expect(before.metric_trust).toBe("experimental");
    expect(before.merge_commit).toBeNull();

    git(dir, [
      "merge",
      "--no-ff",
      "-m",
      `Merge pull request #1 from ${proposal.branch}\n\nGrane-Proposal: ${proposal.id}`,
      proposal.branch,
    ]);

    const after = readMergedApproval(dir, proposal.id);
    expect(after.merged).toBe(true);
    expect(after.metric_trust).toBe("governed");
    expect(after.merge_commit).toBe(git(dir, ["rev-parse", "HEAD"]));
  });

  it("refuses to pin an unmerged proposal commit", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "HEAD"]);
    const proposal = createProposal(dir, {
      slug: "unmerged",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    try {
      writeActivePin(dir, {
        ref: "main",
        commit: proposal.commit,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:01:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/not reachable from "main"/);
      expect((err as GraneError).message).toMatch(/Merge the GitHub PR/);
    }
    try {
      rollbackPin(dir, { to: proposal.commit });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/not a previously approved pin|not reachable from "main"/);
    }
    expect(readActivePin(dir)?.commit).toBe(main);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
  });

  it("refuses to pin against a grane/proposal/* ref", () => {
    const dir = initRepo();
    const proposal = createProposal(dir, {
      slug: "unmerged",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    try {
      writeActivePin(dir, {
        ref: proposal.branch,
        commit: proposal.commit,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/proposal branch/);
      expect((err as GraneError).message).toMatch(/GitHub PR base/);
    }
    expect(readActivePin(dir)).toBeNull();
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("refuses a pin ref that is not the approved base branch", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "HEAD"]);
    try {
      writeActivePin(dir, {
        ref: "develop",
        commit: main,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/pin ref must be "main"/);
    }
    writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    try {
      writeActivePin(dir, {
        ref: "develop",
        commit: main,
        approved_by: "octocat",
        approved_at: "2026-10-14T12:01:00.000Z",
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/pin ref must be "main"/);
    }
    expect(readActivePin(dir)?.ref).toBe("main");
    expect(readActivePin(dir)?.commit).toBe(main);
  });

  it("does not treat x-add as merged when only x-add-revenue is merged", () => {
    const dir = initRepo();
    const at = new Date("2026-10-14T00:00:00.000Z");
    const add = createProposal(dir, {
      slug: "x-add",
      at,
      files: {
        "metrics.yml": `metrics:
  added:
    entity: order
    type: count
    status: experimental
`,
      },
    });
    const revenue = createProposal(dir, {
      slug: "x-add-revenue",
      at,
      files: { "metrics.yml": DRAFT_METRICS },
    });
    expect(add.id).toBe("20261014-x-add");
    expect(revenue.id).toBe("20261014-x-add-revenue");
    expect(revenue.id.startsWith(`${add.id}-`)).toBe(true);

    git(dir, [
      "merge",
      "--no-ff",
      "-m",
      `Merge pull request #2 from ${revenue.branch}\n\nGrane-Proposal: ${revenue.id}`,
      revenue.branch,
    ]);

    const addState = readMergedApproval(dir, add.id);
    const revenueState = readMergedApproval(dir, revenue.id);
    expect(addState.proposal_id).toBe(add.id);
    expect(revenueState.proposal_id).toBe(revenue.id);
    expect(addState.merged).toBe(false);
    expect(addState.metric_trust).toBe("experimental");
    expect(revenueState.merged).toBe(true);
    expect(revenueState.metric_trust).toBe("governed");
  });

  it("rolls back by re-pinning a previous commit without moving the active branch", () => {
    const dir = initRepo();
    const first = git(dir, ["rev-parse", "HEAD"]);
    writeFileSync(join(dir, "metrics.yml"), DRAFT_METRICS);
    git(dir, ["add", "metrics.yml"]);
    git(dir, ["commit", "-m", "merged proposal"]);
    const merged = git(dir, ["rev-parse", "HEAD"]);
    writeActivePin(dir, {
      ref: "main",
      commit: merged,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
      proposal: "20261014-revenue",
      previous_commit: first,
    });

    const pin = rollbackPin(dir, { approved_by: "octocat" });
    expect(pin.commit).toBe(first);
    expect(pin.previous_commit).toBe(merged);
    expect(pin.ref).toBe("main");
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(readActivePin(dir)?.commit).toBe(first);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(true);
  });

  it("refuses when there is no git repository, with init guidance", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "grane.yml"), INITIAL_YML);
    try {
      createProposal(dir, { slug: "revenue", files: { "metrics.yml": DRAFT_METRICS } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/No git repository/);
      expect((err as GraneError).message).toMatch(/git init/);
      expect((err as GraneError).message).toMatch(/GitHub PR/);
    }
  });

  it("refuses when the working tree is dirty, with stash guidance", () => {
    const dir = initRepo();
    writeFileSync(join(dir, "notes.txt"), "WIP");
    try {
      createProposal(dir, { slug: "revenue", files: { "metrics.yml": DRAFT_METRICS } });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/Working tree is dirty/);
      expect((err as GraneError).message).toMatch(/Commit or stash/);
      expect((err as GraneError).message).toMatch(/notes\.txt/);
    }
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
    expect(listProposals(dir)).toEqual([]);
  });

  it("combines draft metrics with the base-branch file instead of replacing it", () => {
    const dir = initRepo();
    writeFileSync(
      join(dir, "metrics.yml"),
      `metrics:
  orders:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: approved
`,
    );
    git(dir, ["add", "metrics.yml"]);
    git(dir, ["commit", "-m", "existing orders metric"]);

    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    const committed = git(dir, ["show", `${proposal.commit}:metrics.yml`]);
    expect(committed).toMatch(/orders:/);
    expect(committed).toMatch(/revenue:/);
    expect(committed).toMatch(/status: approved/);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toMatch(/orders:/);
    expect(readFileSync(join(dir, "metrics.yml"), "utf8")).not.toMatch(/revenue:/);
  });

  it("refuses when a draft key conflicts with the base-branch definition", () => {
    const dir = initRepo();
    writeFileSync(
      join(dir, "metrics.yml"),
      `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.gross_amount}"
    status: approved
`,
    );
    git(dir, ["add", "metrics.yml"]);
    git(dir, ["commit", "-m", "existing revenue"]);

    try {
      createProposal(dir, {
        slug: "revenue",
        at: new Date("2026-10-14T00:00:00.000Z"),
        files: { "metrics.yml": DRAFT_METRICS },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as Error).message).toMatch(/overwrite existing metrics "revenue"/i);
    }
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("refuses a proposal that would write .grane/active.json", () => {
    const dir = initRepo();
    try {
      createProposal(dir, {
        slug: "agent-pin",
        at: new Date("2026-10-14T00:00:00.000Z"),
        files: {
          ".grane/active.json": JSON.stringify({
            ref: "main",
            commit: git(dir, ["rev-parse", "HEAD"]),
            approved_by: "agent",
            approved_at: "2026-10-14T12:00:00.000Z",
          }),
        },
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/\.grane/);
    }
    expect(readActivePin(dir)).toBeNull();
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
    expect(git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe("main");
  });

  it("ignores dirty files under .grane/ and still refuses a path that would write the active branch", () => {
    const dir = initRepo();
    mkdirSync(join(dir, ".grane", "authoring"), { recursive: true });
    writeFileSync(join(dir, ".grane", "authoring", "sess.json"), "{}\n");
    const proposal = createProposal(dir, {
      slug: "ok",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT_METRICS },
    });
    expect(proposal.branch.startsWith(PROPOSAL_BRANCH_PREFIX)).toBe(true);

    const src = readFileSync(new URL("../../src/authoring/git.ts", import.meta.url), "utf8");
    expect(src).toMatch(/update-ref/);
    expect(src).toMatch(/commit-tree/);
    expect(src).not.toMatch(/["']merge["']/);
    expect(src).not.toMatch(/checkout/);
    expect(src).not.toMatch(/git reset/);
  });
});
