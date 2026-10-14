/**
 * V2-14 gauntlet: pin/proposal/discovery audit lines, unmerged-commit pins,
 * demo-repo refusal, project.base_branch / first pin, and V2-13 CLI review
 * of a merged proposal.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDiscovery } from "../../src/authoring/discover.js";
import { DEMO_AUTHORING_MARKER } from "../../src/authoring/demo-marker.js";
import {
  approveProposal,
  configuredBaseBranch,
  createProposal,
  loadServingConfig,
  readActivePin,
  rejectProposal,
  rollbackPin,
  writeActivePin,
} from "../../src/authoring/git.js";
import {
  assertBranchUnmoved,
  assertDiscoveryAudit,
  assertPinAudit,
  assertProposalAudit,
  auditMark,
  EMPTY_METRICS_YAML,
  git,
  initAuthoringRepo,
  mergeProposal,
  mustRefuse,
  parseTool,
  recordingConnector,
  runProposalsCli,
  securityCritical,
  SHOP_SCHEMA,
  thrownSecurity,
  toolMessage,
  withAuthoringMcp,
} from "./authoring.js";
import type { Verdict } from "./types.js";

const EXTRA_METRIC = `metrics:
  extra:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`;

function pinMain(dir: string, commit: string, approvedBy = "Reagent Smith"): ReturnType<typeof writeActivePin> {
  return writeActivePin(dir, {
    ref: "main",
    commit,
    approved_by: approvedBy,
    approved_at: "2026-10-14T12:00:00.000Z",
  });
}

export async function runAuthoringAuditAssertions(): Promise<Verdict> {
  const repo = initAuthoringRepo({ metrics: EMPTY_METRICS_YAML });
  try {
    const connector = recordingConnector(SHOP_SCHEMA);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client, kernel) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } });
        const afterDiscoverMcp = auditMark(repo.dir);
        const discovery = createDiscovery({
          config: kernel.config,
          connector,
          projectDir: repo.dir,
          sessionId,
          agent: null,
        });
        await discovery.introspectSchema();
        await discovery.profileColumn("orders", "net_amount");
        const discoveryLine = assertDiscoveryAudit(repo.dir, afterDiscoverMcp);
        if (discoveryLine) return discoveryLine;

        await client.callTool({
          name: "record_term",
          arguments: { session_id: sessionId, term: "revenue", answer: "net_amount" },
        });
        const proposed = await client.callTool({
          name: "propose_definitions",
          arguments: { session_id: sessionId },
        });
        if (proposed.isError) {
          return securityCritical(`propose_definitions failed: ${toolMessage(proposed)}`);
        }
        const beforeSubmit = auditMark(repo.dir);
        const submitted = await client.callTool({
          name: "submit_proposal",
          arguments: { session_id: sessionId, slug: "audit-submit" },
        });
        if (submitted.isError) {
          return securityCritical(`submit_proposal failed: ${toolMessage(submitted)}`);
        }
        const submitLine = assertProposalAudit(repo.dir, "submit", beforeSubmit);
        if (submitLine) return submitLine;
        const payload = parseTool(submitted) as { proposal: { id: string; branch: string; commit: string } };

        const beforePin = auditMark(repo.dir);
        pinMain(repo.dir, repo.mainSha);
        const writeLine = assertPinAudit(repo.dir, "write", beforePin);
        if (writeLine) return writeLine;

        try {
          writeActivePin(repo.dir, {
            ref: "main",
            commit: payload.proposal.commit,
            approved_by: "gauntlet",
            approved_at: "2026-10-14T12:01:00.000Z",
          });
          return securityCritical("writeActivePin accepted an unmerged proposal commit during audit setup");
        } catch {
          // expected; pin refuse is recorded by serve load of a tampered pin below
        }

        writeFileSync(
          join(repo.dir, ".grane", "active.json"),
          JSON.stringify({
            ref: "main",
            commit: repo.mainSha.slice(0, 7),
            approved_by: "gauntlet",
            approved_at: "2026-10-14T12:00:00.000Z",
          }),
        );
        const beforeRefuse = auditMark(repo.dir);
        try {
          loadServingConfig(repo.dir);
          return securityCritical("loadServingConfig accepted a truncated SHA pin");
        } catch {
          const refuseLine = assertPinAudit(repo.dir, "refuse", beforeRefuse);
          if (refuseLine) return refuseLine;
        }

        pinMain(repo.dir, repo.mainSha);
        const merged = mergeProposal(repo.dir, payload.proposal);
        const afterMerge = git(repo.dir, ["rev-parse", "main"]);
        const beforeApprove = auditMark(repo.dir);
        approveProposal(repo.dir, payload.proposal.id, { tty: false, approved_by: "gauntlet" });
        const approveLine = assertProposalAudit(repo.dir, "approve", beforeApprove);
        if (approveLine) return approveLine;
        const pinWrite = assertPinAudit(repo.dir, "write", beforeApprove);
        if (pinWrite) return pinWrite;
        if (readActivePin(repo.dir)?.commit !== merged) {
          return securityCritical("approve did not pin the merge commit");
        }

        const beforeRollback = auditMark(repo.dir);
        rollbackPin(repo.dir, { approved_by: "gauntlet" });
        const rollbackLine = assertProposalAudit(repo.dir, "rollback", beforeRollback);
        if (rollbackLine) return rollbackLine;

        const other = createProposal(repo.dir, {
          slug: "audit-reject",
          at: new Date("2026-10-16T00:00:00.000Z"),
          files: { "metrics.yml": EXTRA_METRIC },
        });
        const beforeReject = auditMark(repo.dir);
        rejectProposal(repo.dir, other.id, { yes: true });
        const rejectLine = assertProposalAudit(repo.dir, "reject", beforeReject);
        if (rejectLine) return rejectLine;

        const moved = assertBranchUnmoved(repo.dir, "main", afterMerge);
        if (moved) return moved;
        return {
          code: "PASS — POLICY",
          detail: "Pin write/refuse, proposal submit/approve/reject/rollback, and discovery read_only:true audited",
        };
      },
    });
  } catch (err) {
    return thrownSecurity(err, "audit assertions");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringUnmergedPin(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "unmerged-pin",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    try {
      writeActivePin(repo.dir, {
        ref: "main",
        commit: proposal.commit,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("writeActivePin accepted an unmerged proposal commit");
    } catch (err) {
      const refuse = mustRefuse(err, /not reachable|merged GitHub PR|Refusing to pin/i, "writeActivePin unmerged");
      if (refuse) return refuse;
    }
    try {
      approveProposal(repo.dir, proposal.id, { tty: true, approved_by: "gauntlet" });
      return securityCritical("approveProposal pinned an unmerged proposal commit");
    } catch (err) {
      const refuse = mustRefuse(err, /Merge the GitHub PR|not reachable|TTY|Refusing to pin/i, "approve unmerged");
      if (refuse) return refuse;
    }
    pinMain(repo.dir, repo.mainSha);
    try {
      rollbackPin(repo.dir, { to: proposal.commit, approved_by: "gauntlet" });
      return securityCritical("rollbackPin accepted an unmerged proposal commit");
    } catch (err) {
      const refuse = mustRefuse(
        err,
        /not a previously approved pin|not reachable|Refusing to (pin|roll)/i,
        "rollback unmerged",
      );
      if (refuse) return refuse;
    }
    if (readActivePin(repo.dir)?.commit !== repo.mainSha) {
      return securityCritical("unmerged pin attempts mutated the pin");
    }
    const freeze = assertBranchUnmoved(repo.dir, "main", repo.mainSha);
    if (freeze) return freeze;
    return {
      code: "PASS — POLICY",
      detail: "Unmerged proposal commits refused by writeActivePin, approve, and rollback",
    };
  } catch (err) {
    return thrownSecurity(err, "unmerged pin");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringDemoRepoRefuse(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "demo-block",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    const merged = mergeProposal(repo.dir, proposal);
    pinMain(repo.dir, repo.mainSha);
    writeFileSync(join(repo.dir, DEMO_AUTHORING_MARKER), "nested demo authoring\n");

    try {
      approveProposal(repo.dir, proposal.id, { tty: false, approved_by: "gauntlet" });
      return securityCritical("approve succeeded in a .grane-demo repo");
    } catch (err) {
      const refuse = mustRefuse(err, /nested demo|\.grane-demo/i, "demo approve");
      if (refuse) return refuse;
    }
    try {
      rejectProposal(repo.dir, proposal.id, { yes: true });
      return securityCritical("reject succeeded in a .grane-demo repo");
    } catch (err) {
      const refuse = mustRefuse(err, /nested demo|\.grane-demo/i, "demo reject");
      if (refuse) return refuse;
    }
    try {
      rollbackPin(repo.dir, { approved_by: "gauntlet" });
      return securityCritical("rollback succeeded in a .grane-demo repo");
    } catch (err) {
      const refuse = mustRefuse(err, /nested demo|\.grane-demo/i, "demo rollback");
      if (refuse) return refuse;
    }
    try {
      writeActivePin(repo.dir, {
        ref: "main",
        commit: merged,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:05:00.000Z",
      });
      return securityCritical("writeActivePin succeeded in a .grane-demo repo");
    } catch (err) {
      const refuse = mustRefuse(err, /nested demo|\.grane-demo/i, "demo pin write");
      if (refuse) return refuse;
    }
    if (readActivePin(repo.dir)?.commit !== repo.mainSha) {
      return securityCritical("demo-repo actions mutated the pin");
    }
    return {
      code: "PASS — POLICY",
      detail: "approve/reject/rollback/pin write refused in a .grane-demo repo",
    };
  } catch (err) {
    return thrownSecurity(err, "demo-repo refuse");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringBaseBranchPin(): Promise<Verdict> {
  const developYaml = `project: { name: shop, timezone: UTC, base_branch: develop }
connection: { type: postgres, schema: public }
audit: { enabled: true, fail_closed: true, path: .grane/audit.jsonl }
entities:
  order: { table: orders, primary_key: id }
`;
  const missingBase = initAuthoringRepo({
    branch: "develop",
    yaml: `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
audit: { enabled: true, fail_closed: true, path: .grane/audit.jsonl }
entities:
  order: { table: orders, primary_key: id }
`,
  });
  try {
    try {
      configuredBaseBranch(missingBase.dir);
      return securityCritical("configuredBaseBranch fell back to HEAD without origin/HEAD, main, or master");
    } catch (err) {
      const refuse = mustRefuse(err, /established base|configured base branch|grane setup/i, "missing base");
      if (refuse) return refuse;
    }
  } finally {
    missingBase.cleanup();
  }

  const repo = initAuthoringRepo({ branch: "develop", yaml: developYaml });
  try {
    git(repo.dir, ["remote", "add", "origin", "git@github.com:Nareik33L/grane.git"]);
    git(repo.dir, ["update-ref", "refs/remotes/origin/develop", repo.mainSha]);
    git(repo.dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop"]);
    if (configuredBaseBranch(repo.dir) !== "develop") {
      return securityCritical(`configured base was ${configuredBaseBranch(repo.dir)}, expected develop`);
    }
    git(repo.dir, ["checkout", "-b", "feature"]);
    writeFileSync(join(repo.dir, "metrics.yml"), EXTRA_METRIC);
    git(repo.dir, ["add", "metrics.yml"]);
    git(repo.dir, ["commit", "-m", "feature work"]);
    const feature = git(repo.dir, ["rev-parse", "HEAD"]);
    const develop = git(repo.dir, ["rev-parse", "develop"]);
    if (feature === develop) {
      return securityCritical("feature commit was not distinct from develop");
    }
    try {
      writeActivePin(repo.dir, {
        ref: "feature",
        commit: feature,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("first pin accepted a feature-branch HEAD as ref");
    } catch (err) {
      const refuse = mustRefuse(err, /not HEAD|pin ref must be "develop"/i, "feature ref pin");
      if (refuse) return refuse;
    }
    try {
      writeActivePin(repo.dir, {
        ref: "develop",
        commit: feature,
        approved_by: "gauntlet",
        approved_at: "2026-10-14T12:00:00.000Z",
      });
      return securityCritical("first pin accepted a feature commit that is not on the configured base");
    } catch (err) {
      const refuse = mustRefuse(err, /not reachable from "develop"|Refusing to pin/i, "feature commit pin");
      if (refuse) return refuse;
    }
    const beforePin = auditMark(repo.dir);
    const pin = writeActivePin(repo.dir, {
      ref: "develop",
      commit: develop,
      approved_by: "gauntlet",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    if (pin.ref !== "develop" || pin.commit !== develop) {
      return securityCritical(`first pin was ${pin.ref}@${pin.commit}, expected develop@${develop}`);
    }
    const writeLine = assertPinAudit(repo.dir, "write", beforePin);
    if (writeLine) return writeLine;
    if (git(repo.dir, ["rev-parse", "--abbrev-ref", "HEAD"]) !== "feature") {
      return securityCritical("pin write moved HEAD off feature");
    }
    const moved = assertBranchUnmoved(repo.dir, "develop", develop);
    if (moved) return moved;
    return {
      code: "PASS — POLICY",
      detail: "First pin is the configured base (develop), not HEAD; feature commits refused",
    };
  } catch (err) {
    return thrownSecurity(err, "base_branch pin");
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringReviewMergedProposal(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "review-cli",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    const beforeList = auditMark(repo.dir);
    const listedBefore = runProposalsCli(repo.dir, ["proposals", "list", "--json"]);
    if (listedBefore.status !== 0) {
      return securityCritical(`proposals list failed: ${listedBefore.stderr || listedBefore.stdout}`);
    }
    if (!listedBefore.stdout.includes(proposal.id)) {
      return securityCritical("proposals list omitted the open proposal");
    }
    const listLine = assertProposalAudit(repo.dir, "list", beforeList);
    if (listLine) return listLine;

    const beforeDiff = auditMark(repo.dir);
    const diffed = runProposalsCli(repo.dir, ["proposals", "diff", proposal.id, "--json"]);
    if (diffed.status !== 0) {
      return securityCritical(`proposals diff failed: ${diffed.stderr || diffed.stdout}`);
    }
    const diffPayload = JSON.parse(diffed.stdout) as { semantic?: { metrics?: { added?: string[] } } };
    if (!diffPayload.semantic?.metrics?.added?.includes("extra")) {
      return securityCritical("proposals diff did not report the added extra metric");
    }
    const diffLine = assertProposalAudit(repo.dir, "diff", beforeDiff);
    if (diffLine) return diffLine;

    const parent = git(repo.dir, ["rev-parse", `${proposal.branch}^`]);
    const merged = mergeProposal(repo.dir, proposal);
    const afterMerge = git(repo.dir, ["rev-parse", "main"]);
    pinMain(repo.dir, repo.mainSha);

    const beforeApprove = auditMark(repo.dir);
    const approved = runProposalsCli(repo.dir, [
      "proposals",
      "approve",
      proposal.id,
      "--json",
      "--approved-by",
      "gauntlet",
    ]);
    if (approved.status !== 0) {
      return securityCritical(`proposals approve failed against a merged PR: ${approved.stderr || approved.stdout}`);
    }
    const pin = JSON.parse(approved.stdout) as { commit: string; ref: string };
    if (pin.commit !== merged || pin.ref !== "main") {
      return securityCritical(`approve pinned ${pin.ref}@${pin.commit}, expected main@${merged}`);
    }
    const approveLine = assertProposalAudit(repo.dir, "approve", beforeApprove);
    if (approveLine) return approveLine;

    const beforeRollback = auditMark(repo.dir);
    const rolled = runProposalsCli(repo.dir, ["proposals", "rollback", "--json", "--approved-by", "gauntlet"]);
    if (rolled.status !== 0) {
      return securityCritical(`proposals rollback failed: ${rolled.stderr || rolled.stdout}`);
    }
    const rolledPin = JSON.parse(rolled.stdout) as { commit: string };
    if (rolledPin.commit !== repo.mainSha) {
      return securityCritical(`rollback pinned ${rolledPin.commit}, expected ${repo.mainSha}`);
    }
    const rollbackLine = assertProposalAudit(repo.dir, "rollback", beforeRollback);
    if (rollbackLine) return rollbackLine;

    const leftover = createProposal(repo.dir, {
      slug: "review-reject",
      at: new Date("2026-10-16T00:00:00.000Z"),
      files: { "metrics.yml": EXTRA_METRIC },
    });
    const beforeReject = auditMark(repo.dir);
    const rejected = runProposalsCli(repo.dir, ["proposals", "reject", leftover.id, "--yes", "--json"]);
    if (rejected.status !== 0) {
      return securityCritical(`proposals reject failed: ${rejected.stderr || rejected.stdout}`);
    }
    const rejectLine = assertProposalAudit(repo.dir, "reject", beforeReject);
    if (rejectLine) return rejectLine;

    if (git(repo.dir, ["rev-parse", `${proposal.branch}^`]) !== parent) {
      return securityCritical("review CLI moved the merged proposal parent");
    }
    const moved = assertBranchUnmoved(repo.dir, "main", afterMerge);
    if (moved) return moved;
    return {
      code: "PASS — POLICY",
      detail: "V2-13 list/diff/approve/rollback/reject exercised against a merged proposal; main unmoved after merge",
    };
  } catch (err) {
    return thrownSecurity(err, "review merged proposal");
  } finally {
    repo.cleanup();
  }
}
