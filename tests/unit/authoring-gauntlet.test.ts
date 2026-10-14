import { describe, expect, it } from "vitest";
import { runAuthoringActivateGauntlet } from "../gauntlet/authoring-activate.js";
import { runAuthoringMcpSweep } from "../gauntlet/authoring-sweep.js";
import {
  runAuthoringActiveWrites,
  runAuthoringHostileArgs,
  runAuthoringPromptInjection,
  runAuthoringSelfApprove,
} from "../gauntlet/authoring-hostile.js";
import {
  runAuthoringDemoGrain,
  runAuthoringExplorationPolicy,
  runAuthoringHugeSchema,
  runAuthoringSelectOnlyRole,
  runAuthoringTimeLikeGroupBy,
} from "../gauntlet/authoring-schema.js";
import {
  runAuthoringAuditAssertions,
  runAuthoringBaseBranchPin,
  runAuthoringDemoRepoRefuse,
  runAuthoringReviewMergedProposal,
  runAuthoringUnmergedPin,
} from "../gauntlet/authoring-review.js";
import { runTamperedActivePinGauntlet } from "../gauntlet/active-pin-tamper.js";
import {
  runActivePinSymlinkRefused,
  runAuditPathMustBeRegularFile,
  runFailClosedQueryAndDiscovery,
  runFeatureCommitCannotRedirectBase,
  runForgedProposalTrailerRefused,
  runGitEnvStripped,
  runGitReplaceAndGraftsRefused,
  runGraneDirSymlinkRefused,
  runOriginHeadDisagreesWithBaseBranch,
  runOriginHeadDisagreesWithLocalMain,
  runWorkingTreeAuditDisableIgnored,
  runWorkingTreeBaseBranchIgnored,
} from "../gauntlet/authoring-committed.js";

describe("V2-14 authoring gauntlet", () => {
  it("MCP sweep covers every registered tool and leaves pin/main/proposal refs unmoved", async () => {
    const verdict = await runAuthoringMcpSweep();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  }, 60_000);

  it("prompt injection in comments/samples cannot merge, pin, approve, or run SQL", async () => {
    const verdict = await runAuthoringPromptInjection();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("self-approve is refused", async () => {
    const verdict = await runAuthoringSelfApprove();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses active YAML and .grane/active.json writes", async () => {
    const verdict = await runAuthoringActiveWrites();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses hostile slug and path arguments", async () => {
    const verdict = await runAuthoringHostileArgs();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("discovery outside the exploration policy is refused", async () => {
    const verdict = await runAuthoringExplorationPolicy();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("huge schemas do not move main or write a pin", async () => {
    const verdict = await runAuthoringHugeSchema();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("time-like number/text columns must not pass group_by", async () => {
    const verdict = await runAuthoringTimeLikeGroupBy();
    expect(verdict.code, verdict.detail).toMatch(/^PASS/);
  });

  it("nullable UNIQUE is not grain; demo PG composite/keyless skipped", async () => {
    const verdict = await runAuthoringDemoGrain();
    expect(verdict.code, verdict.detail).toMatch(/^PASS/);
  });

  it("pin/proposal/discovery audit lines are required", async () => {
    const verdict = await runAuthoringAuditAssertions();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  }, 60_000);

  it("refuses pinning an unmerged proposal commit", async () => {
    const verdict = await runAuthoringUnmergedPin();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses approve/reject/rollback/pin in a .grane-demo repo", async () => {
    const verdict = await runAuthoringDemoRepoRefuse();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("SELECT-only role refuses writes and sees partitioned PKs", async () => {
    const verdict = await runAuthoringSelectOnlyRole();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("first pin is the configured base, not HEAD", async () => {
    const verdict = await runAuthoringBaseBranchPin();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("V2-13 CLI list/diff/approve/rollback/reject a merged proposal", async () => {
    const verdict = await runAuthoringReviewMergedProposal();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  }, 60_000);

  it("pin tamper table fails closed", async () => {
    const verdict = await runTamperedActivePinGauntlet();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("activate walk still refuses pins and keeps main SHA", async () => {
    const verdict = await runAuthoringActivateGauntlet();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("working-tree base_branch does not redirect the configured base", async () => {
    const verdict = await runWorkingTreeBaseBranchIgnored();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses when origin/HEAD disagrees with committed project.base_branch", async () => {
    const verdict = await runOriginHeadDisagreesWithBaseBranch();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("working-tree audit.enabled:false does not silence approve/pin-write", async () => {
    const verdict = await runWorkingTreeAuditDisableIgnored();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("fail_closed audit refuses symlink and /dev/null", async () => {
    const verdict = await runAuditPathMustBeRegularFile();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("runGit strips inherited GIT_* env vars", async () => {
    const verdict = await runGitEnvStripped();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("forged Grane-Proposal trailer is not a merge", async () => {
    const verdict = await runForgedProposalTrailerRefused();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("query and discovery fail closed when audit cannot write", async () => {
    const verdict = await runFailClosedQueryAndDiscovery();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("active.json symlink is refused", async () => {
    const verdict = await runActivePinSymlinkRefused();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("HEAD-committed base_branch: feature does not redirect the configured base", async () => {
    const verdict = await runFeatureCommitCannotRedirectBase();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses origin/HEAD that disagrees with local main when no base_branch is committed", async () => {
    const verdict = await runOriginHeadDisagreesWithLocalMain();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses git replace refs and .git/info/grafts", async () => {
    const verdict = await runGitReplaceAndGraftsRefused();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("symlinked .grane/ directory is refused", async () => {
    const verdict = await runGraneDirSymlinkRefused();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });
});
