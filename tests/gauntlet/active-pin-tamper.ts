/**
 * Gauntlet: a hand-edited `.grane/active.json` (tampered commit, ref, or
 * approved_by) must fail closed. Serve must not load the tampered tree.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ACTIVE_PIN_PATH,
  createProposal,
  loadServingConfig,
  writeActivePin,
  type ActivePin,
} from "../../src/authoring/git.js";
import { GraneError } from "../../src/errors.js";
import type { Verdict } from "./types.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function writePinFile(dir: string, pin: ActivePin): void {
  writeFileSync(join(dir, ACTIVE_PIN_PATH), `${JSON.stringify(pin, null, 2)}\n`);
}

function mustRefuse(dir: string, label: string): Verdict | null {
  try {
    const loaded = loadServingConfig(dir);
    return {
      code: "SECURITY CRITICAL",
      detail: `serve loaded a tampered pin (${label}); metrics=${Object.keys(loaded.config.metrics).join(",")}`,
    };
  } catch (err) {
    if (!(err instanceof GraneError) && !(err instanceof Error)) {
      return { code: "FAIL", detail: `${label}: threw non-error ${String(err)}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (!/refuse|tampered|Invalid \.grane\/active\.json|not in this repository|not on "/i.test(message)) {
      return { code: "FAIL", detail: `${label}: unexpected error: ${message}` };
    }
    return null;
  }
}

export async function runTamperedActivePinGauntlet(): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), "grane-gauntlet-pin-tamper-"));
  try {
    mkdirSync(join(dir, ".grane"), { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "gauntlet@grane.dev"]);
    git(dir, ["config", "user.name", "Grane Gauntlet"]);
    writeFileSync(join(dir, ".gitignore"), ".grane/\n");
    writeFileSync(
      join(dir, "grane.yml"),
      "project: { name: shop, timezone: UTC }\nconnection: { type: postgres, schema: public }\nentities:\n  order: { table: orders, primary_key: id }\n",
    );
    writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const main = git(dir, ["rev-parse", "HEAD"]);

    const proposal = createProposal(dir, {
      slug: "tamper-revenue",
      files: {
        "metrics.yml": `metrics:
  leaked:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`,
      },
    });

    const valid: ActivePin = {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    };
    writeActivePin(dir, valid);

    writePinFile(dir, { ...valid, commit: proposal.commit });
    const commitTamper = mustRefuse(dir, "commit=unmerged proposal");
    if (commitTamper) return commitTamper;

    writePinFile(dir, { ...valid, ref: proposal.branch });
    const refTamper = mustRefuse(dir, "ref=proposal branch");
    if (refTamper) return refTamper;

    writePinFile(dir, { ...valid, approved_by: "agent" });
    const agentTamper = mustRefuse(dir, "approved_by=agent");
    if (agentTamper) return agentTamper;

    writePinFile(dir, { ...valid, approved_by: "" });
    const emptyTamper = mustRefuse(dir, "approved_by empty");
    if (emptyTamper) return emptyTamper;

    return {
      code: "PASS — POLICY",
      detail: "Hand-edited active.json (commit/ref/approved_by) failed closed; serve did not load the tampered tree",
    };
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
