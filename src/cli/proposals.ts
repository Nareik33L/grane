import { createInterface } from "node:readline/promises";
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

/** TTY reject confirmation. Default is no (`y/N`) unless `--yes`. */
export async function confirmReject(id: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = (await rl.question(`Reject proposal ${id} and delete its local branch? [y/N]: `))
      .trim()
      .toLowerCase();
    return raw === "y" || raw === "yes";
  } finally {
    rl.close();
  }
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
          const line = (label: string, names: { added: string[]; changed: string[]; removed: string[] }) =>
            `${label} +${names.added.join(",") || "0"} ~${names.changed.join(",") || "0"} -${names.removed.join(",") || "0"}`;
          console.log(line("metrics", diff.semantic.metrics));
          console.log(line("entities", diff.semantic.entities));
          const restored = diff.semantic.merge.restored;
          const restoredBits = (["metrics", "entities", "dimensions", "relationships"] as const)
            .filter((key) => restored[key].length > 0)
            .map((key) => `${key}=${restored[key].join(",")}`);
          if (restoredBits.length > 0) console.log(`merge restored  ${restoredBits.join(" ")}`);
          if (diff.semantic.merge.lost_comments.length > 0) {
            console.log(`lost comments  ${diff.semantic.merge.lost_comments.join(", ")}`);
          }
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
    .description("Validate YAML, pin the merge commit, commit grane.pin.json on a pin branch, print a PR (does not merge/push)")
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
        console.log(`pin file  ${pin.pin_file} on ${pin.pin_branch}`);
        console.log("Grane does not merge or push the pin PR onto the base branch.");
        console.log(pin.github.command);
      } catch (err) {
        ctx.fail(err);
      }
    });

  proposals
    .command("reject")
    .argument("<id>", "proposal id or grane/proposal/* branch")
    .description("Delete a local proposal branch (does not write the pin or main)")
    .option("--json", "print JSON")
    .option("--yes", "skip the TTY y/N prompt")
    .action(async (id: string, options: { json?: boolean; yes?: boolean }) => {
      try {
        let yes = Boolean(options.yes);
        if (!yes && isTty()) {
          yes = await confirmReject(id);
          if (!yes) {
            console.log("Aborted.");
            return;
          }
        }
        const result = rejectProposal(ctx.projectDir(), id, { tty: isTty(), yes });
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
    .description("Re-pin a previously approved pin (default: pin.previous_commit)")
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
