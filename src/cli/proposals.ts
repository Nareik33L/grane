import type { Command } from "commander";
import {
  approveProposal,
  diffProposalAction,
  listProposalsAction,
  rejectProposal,
  rollbackPin,
} from "../authoring/git.js";

interface ProposalsCliContext {
  projectDir: () => string;
  fail: (err: unknown) => never;
}

function isTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

export function registerProposalsCommands(program: Command, ctx: ProposalsCliContext): void {
  const proposals = program
    .command("proposals")
    .description("List, diff, approve, reject, or roll back Git proposal branches");

  proposals
    .command("list")
    .description("List local grane/proposal/* branches")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      try {
        const listed = listProposalsAction(ctx.projectDir());
        if (options.json) {
          console.log(JSON.stringify(listed, null, 2));
          return;
        }
        if (listed.length === 0) {
          console.log("No proposal branches.");
          return;
        }
        for (const item of listed) {
          console.log(`${item.id}  ${item.branch}  ${item.commit.slice(0, 7)}  ${item.title}`);
        }
      } catch (err) {
        ctx.fail(err);
      }
    });

  proposals
    .command("diff")
    .argument("<id>", "proposal id or grane/proposal/* branch")
    .description("Show the proposal diff against the active pin / configured base")
    .option("--json", "print JSON")
    .action((id: string, options: { json?: boolean }) => {
      try {
        const diff = diffProposalAction(ctx.projectDir(), id);
        if (options.json) {
          console.log(JSON.stringify(diff, null, 2));
          return;
        }
        if (diff.semantic) {
          console.log(
            `metrics +${diff.semantic.metrics.added.length} ~${diff.semantic.metrics.changed.length} -${diff.semantic.metrics.removed.length}`,
          );
        }
        if (diff.unified.trim()) console.log(diff.unified);
        else console.log("No file diff.");
      } catch (err) {
        ctx.fail(err);
      }
    });

  proposals
    .command("approve")
    .argument("<id>", "proposal id or grane/proposal/* branch")
    .description("Pin the merge commit of a merged GitHub PR (TTY or already-merged)")
    .option("--json", "print JSON")
    .option("--approved-by <name>", "recorded approved_by on the pin")
    .action((id: string, options: { json?: boolean; approvedBy?: string }) => {
      try {
        const pin = approveProposal(ctx.projectDir(), id, {
          tty: isTty(),
          approved_by: options.approvedBy,
        });
        if (options.json) {
          console.log(JSON.stringify(pin, null, 2));
          return;
        }
        console.log(`approved  ${pin.ref} @ ${pin.commit.slice(0, 7)}  (${pin.approved_by})`);
      } catch (err) {
        ctx.fail(err);
      }
    });

  proposals
    .command("reject")
    .argument("<id>", "proposal id or grane/proposal/* branch")
    .description("Delete a local proposal branch (does not write the pin or main)")
    .option("--json", "print JSON")
    .option("--yes", "allow reject without a TTY")
    .action((id: string, options: { json?: boolean; yes?: boolean }) => {
      try {
        const result = rejectProposal(ctx.projectDir(), id, { tty: isTty(), yes: options.yes });
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        console.log(`rejected  ${result.branch}`);
      } catch (err) {
        ctx.fail(err);
      }
    });

  proposals
    .command("rollback")
    .description("Re-pin the previous approved commit (reachable on the configured base)")
    .option("--to <commit>", "previously approved commit (default: pin.previous_commit)")
    .option("--json", "print JSON")
    .option("--approved-by <name>", "recorded approved_by on the pin")
    .action((options: { to?: string; json?: boolean; approvedBy?: string }) => {
      try {
        const pin = rollbackPin(ctx.projectDir(), {
          to: options.to,
          approved_by: options.approvedBy,
        });
        if (options.json) {
          console.log(JSON.stringify(pin, null, 2));
          return;
        }
        console.log(`rollback  ${pin.ref} @ ${pin.commit.slice(0, 7)}  (${pin.approved_by})`);
      } catch (err) {
        ctx.fail(err);
      }
    });
}
