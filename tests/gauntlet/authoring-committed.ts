/**
 * Gate-7 attack paths: committed config (not working tree), GIT_* isolation,
 * regular-file audit, ancestor-only merge, fail-closed query/discovery.
 */
import { existsSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscovery } from "../../src/authoring/discover.js";
import {
  approveProposal,
  configuredBaseBranch,
  createProposal,
  readActivePin,
  writeActivePin,
} from "../../src/authoring/git.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import {
  assertPinAudit,
  assertProposalAudit,
  auditMark,
  git,
  initAuthoringRepo,
  mergeProposal,
  mustRefuse,
  recordingConnector,
  securityCritical,
  SHOP_SCHEMA,
  thrownSecurity,
} from "./authoring.js";
import type { Verdict } from "./types.js";

const EXTRA_METRIC = `metrics:
  extra:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`;

function pinMain(dir: string, commit: string, approvedBy = "gauntlet") {
  return writeActivePin(dir, {
    ref: "main",
    commit,
    approved_by: approvedBy,
    approved_at: "2026-10-14T12:00:00.000Z",
  });
}

function withGitEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** 1. Working-tree grane.yml must not redirect the configured base. */
export async function runWorkingTreeBaseBranchIgnored(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    git(repo.dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(repo.dir, ["update-ref", "refs/remotes/origin/main", repo.mainSha]);
    git(repo.dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    git(repo.dir, ["checkout", "-b", "feature"]);
    writeFileSync(
      join(repo.dir, "grane.yml"),
      `project: { name: shop, timezone: UTC, base_branch: feature }
connection: { type: postgres, schema: public }
audit: { enabled: true, fail_closed: true, path: .grane/audit.jsonl }
entities:
  order: { table: orders, primary_key: id }
`,
    );
    if (configuredBaseBranch(repo.dir) !== "main") {
      return securityCritical(
        `working-tree base_branch redirected configured base to ${configuredBaseBranch(repo.dir)}`,
      );
    }
    try {
      writeActivePin(repo.dir, {
        ref: "feature",
        commit: repo.mainSha,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("first pin accepted a feature-branch ref after a working-tree base_branch edit");
    } catch (err) {
      const refuse = mustRefuse(err, /pin ref must be "main"|not HEAD/i, "working-tree feature pin");
      if (refuse) return refuse;
    }
    return {
      code: "PASS — POLICY",
      detail: "working-tree project.base_branch does not redirect the configured base",
    };
  } catch (err) {
    return thrownSecurity(err, "working-tree base_branch");
  } finally {
    repo.cleanup();
  }
}

/** 2. Committed base_branch wins; origin/HEAD disagreement is refused. */
export async function runOriginHeadDisagreesWithBaseBranch(): Promise<Verdict> {
  const repo = initAuthoringRepo({
    yaml: `project: { name: shop, timezone: UTC, base_branch: develop }
connection: { type: postgres, schema: public }
audit: { enabled: true, fail_closed: true, path: .grane/audit.jsonl }
entities:
  order: { table: orders, primary_key: id }
`,
  });
  try {
    git(repo.dir, ["branch", "develop", "main"]);
    git(repo.dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(repo.dir, ["update-ref", "refs/remotes/origin/main", repo.mainSha]);
    git(repo.dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    try {
      configuredBaseBranch(repo.dir);
      return securityCritical("configuredBaseBranch accepted origin/HEAD that disagrees with committed base_branch");
    } catch (err) {
      const refuse = mustRefuse(err, /origin\/HEAD.*disagrees|project.base_branch is "develop"/i, "origin/HEAD disagree");
      if (refuse) return refuse;
    }
    return {
      code: "PASS — POLICY",
      detail: "origin/HEAD disagreeing with committed project.base_branch is refused",
    };
  } catch (err) {
    return thrownSecurity(err, "origin/HEAD vs base_branch");
  } finally {
    repo.cleanup();
  }
}

/** 3. Working-tree audit.enabled:false must not silence approve / pin-write. */
export async function runWorkingTreeAuditDisableIgnored(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "audit-wt",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    mergeProposal(repo.dir, proposal);
    writeFileSync(
      join(repo.dir, "grane.yml"),
      `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
audit: { enabled: false, fail_closed: false, path: .grane/audit.jsonl }
entities:
  order: { table: orders, primary_key: id }
`,
    );
    const before = auditMark(repo.dir);
    approveProposal(repo.dir, proposal.id, { tty: false, approved_by: "gauntlet" });
    const approveLine = assertProposalAudit(repo.dir, "approve", before);
    if (approveLine) return approveLine;
    const pinLine = assertPinAudit(repo.dir, "write", before);
    if (pinLine) return pinLine;
    return {
      code: "PASS — POLICY",
      detail: "working-tree audit.enabled:false does not silence approve/pin-write audit",
    };
  } catch (err) {
    return thrownSecurity(err, "working-tree audit disable");
  } finally {
    repo.cleanup();
  }
}

/** 4. Symlink or /dev/null audit path is refused under fail_closed. */
export async function runAuditPathMustBeRegularFile(): Promise<Verdict> {
  const symlinkRepo = initAuthoringRepo();
  try {
    const target = join(tmpdir(), `grane-audit-symlink-${process.pid}.jsonl`);
    writeFileSync(target, "");
    const auditPath = join(symlinkRepo.dir, ".grane", "audit.jsonl");
    if (existsSync(auditPath)) {
      writeFileSync(auditPath, "");
    }
    try {
      unlinkSync(auditPath);
    } catch {
      // first write
    }
    symlinkSync(target, auditPath);
    try {
      writeActivePin(symlinkRepo.dir, {
        ref: "main",
        commit: symlinkRepo.mainSha,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("writeActivePin accepted a symlink audit path under fail_closed");
    } catch (err) {
      const refuse = mustRefuse(err, /symlink|regular file|fail_closed/i, "symlink audit");
      if (refuse) return refuse;
    }
  } catch (err) {
    return thrownSecurity(err, "symlink audit");
  } finally {
    symlinkRepo.cleanup();
  }

  const nullRepo = initAuthoringRepo({
    yaml: `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
audit: { enabled: true, fail_closed: true, path: /dev/null }
entities:
  order: { table: orders, primary_key: id }
`,
  });
  try {
    try {
      writeActivePin(nullRepo.dir, {
        ref: "main",
        commit: nullRepo.mainSha,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("writeActivePin accepted audit.path /dev/null under fail_closed");
    } catch (err) {
      const refuse = mustRefuse(err, /regular file|device|fail_closed|\/dev\/null/i, "/dev/null audit");
      if (refuse) return refuse;
    }
    return {
      code: "PASS — POLICY",
      detail: "fail_closed audit refuses symlink and /dev/null",
    };
  } catch (err) {
    return thrownSecurity(err, "/dev/null audit");
  } finally {
    nullRepo.cleanup();
  }
}

/** 5. runGit strips inherited GIT_* so GIT_DIR cannot redirect the repo. */
export async function runGitEnvStripped(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  const decoy = initAuthoringRepo();
  try {
    const decoyHead = decoy.mainSha;
    const decoyGitDir = join(decoy.dir, ".git");
    const proposal = withGitEnv(
      {
        GIT_DIR: decoyGitDir,
        GIT_WORK_TREE: decoy.dir,
        GIT_INDEX_FILE: join(decoy.dir, ".git", "index"),
        GIT_OBJECT_DIRECTORY: join(decoy.dir, ".git", "objects"),
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(decoy.dir, ".git", "objects"),
        GIT_CEILING_DIRECTORIES: decoy.dir,
      },
      () =>
        createProposal(repo.dir, {
          slug: "git-env",
          at: new Date("2026-10-14T00:00:00.000Z"),
          files: { "metrics.yml": EXTRA_METRIC },
        }),
    );
    if (git(decoy.dir, ["rev-parse", "HEAD"]) !== decoyHead) {
      return securityCritical("GIT_DIR redirected a proposal write into the decoy repo");
    }
    if (git(repo.dir, ["rev-parse", proposal.branch]) !== proposal.commit) {
      return securityCritical("proposal branch missing from the real repo after GIT_* injection");
    }
    return {
      code: "PASS — POLICY",
      detail: "runGit strips inherited GIT_* (GIT_DIR cannot redirect writes)",
    };
  } catch (err) {
    return thrownSecurity(err, "GIT_* strip");
  } finally {
    repo.cleanup();
    decoy.cleanup();
  }
}

/** 6. Forged Grane-Proposal trailer on an empty commit is not a merge. */
export async function runForgedProposalTrailerRefused(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "forged",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    git(repo.dir, [
      "commit",
      "--allow-empty",
      "-m",
      `empty\n\nGrane-Proposal: ${proposal.id}`,
    ]);
    pinMain(repo.dir, repo.mainSha);
    try {
      approveProposal(repo.dir, proposal.id, { tty: false, approved_by: "gauntlet" });
      return securityCritical("approve accepted a forged Grane-Proposal trailer without the proposal commit as ancestor");
    } catch (err) {
      const refuse = mustRefuse(err, /Merge the GitHub PR|merged GitHub PR/i, "forged trailer");
      if (refuse) return refuse;
    }
    if (readActivePin(repo.dir)?.proposal === proposal.id) {
      return securityCritical("forged trailer pinned the proposal");
    }
    return {
      code: "PASS — POLICY",
      detail: "approve requires the proposal commit reachable from base, not a trailer",
    };
  } catch (err) {
    return thrownSecurity(err, "forged trailer");
  } finally {
    repo.cleanup();
  }
}

/** 7. Query + discovery fail-closed when the audit append cannot write. */
export async function runFailClosedQueryAndDiscovery(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    writeFileSync(join(repo.dir, "blocked"), "not a directory");
    const config = exampleConfig({
      audit: { enabled: true, path: "blocked/audit.jsonl", fail_closed: true },
    });
    const connector = recordingConnector(SHOP_SCHEMA);
    const kernel = new GraneKernel(config, { projectDir: repo.dir, connector });
    try {
      await kernel.query({ metrics: ["revenue"] });
      await kernel.close().catch(() => undefined);
      return securityCritical("query succeeded when fail_closed audit could not write");
    } catch (err) {
      const refuse = mustRefuse(err, /fail_closed/i, "query fail_closed");
      await kernel.close().catch(() => undefined);
      if (refuse) return refuse;
    }

    const discovery = createDiscovery({
      config,
      connector,
      projectDir: repo.dir,
    });
    try {
      await discovery.introspectSchema();
      return securityCritical("discovery succeeded when fail_closed audit could not write");
    } catch (err) {
      const refuse = mustRefuse(err, /fail_closed|config_error/i, "discovery fail_closed");
      if (refuse) return refuse;
    }
    return {
      code: "PASS — POLICY",
      detail: "query and discovery refuse when fail_closed audit cannot write",
    };
  } catch (err) {
    return thrownSecurity(err, "fail-closed query/discovery");
  } finally {
    repo.cleanup();
  }
}

/** Nice-to-have: .grane/active.json symlink is refused. */
export async function runActivePinSymlinkRefused(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    mkdirSync(join(repo.dir, ".grane"), { recursive: true });
    const target = join(tmpdir(), `grane-pin-symlink-${process.pid}.json`);
    writeFileSync(
      target,
      `${JSON.stringify({
        ref: "main",
        commit: repo.mainSha,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      })}\n`,
    );
    symlinkSync(target, join(repo.dir, ".grane", "active.json"));
    try {
      readActivePin(repo.dir);
      return securityCritical("readActivePin followed a symlink active.json");
    } catch (err) {
      const refuse = mustRefuse(err, /regular file|symlink/i, "active.json symlink");
      if (refuse) return refuse;
    }
    return {
      code: "PASS — POLICY",
      detail: "active.json symlink is refused",
    };
  } catch (err) {
    return thrownSecurity(err, "active.json symlink");
  } finally {
    repo.cleanup();
  }
}
