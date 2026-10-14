/**
 * Gauntlet: a hand-edited `.grane/active.json` (tampered commit or ref)
 * must fail closed. Serve must not load the tampered tree.
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
      return { code: "SECURITY CRITICAL", detail: `${label}: threw non-error ${String(err)}` };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (
      !/refuse|tampered|Invalid \.grane\/active\.json|not in this repository|not on "|full 40|hex SHA|refs\/heads|configured base/i.test(
        message,
      )
    ) {
      return { code: "SECURITY CRITICAL", detail: `${label}: unexpected error: ${message}` };
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

    git(dir, ["checkout", "-b", "other"]);
    git(dir, ["commit", "--allow-empty", "-m", "other branch"]);
    git(dir, ["checkout", "main"]);
    git(dir, ["tag", "v1.0"]);

    const valid: ActivePin = {
      ref: "main",
      commit: main,
      approved_by: "Reagent Smith",
      approved_at: "2026-10-14T12:00:00.000Z",
    };
    writeActivePin(dir, valid);

    const cases: Array<{ label: string; pin: ActivePin }> = [
      { label: "commit=unmerged proposal", pin: { ...valid, commit: proposal.commit } },
      { label: "ref=proposal branch", pin: { ...valid, ref: proposal.branch } },
      { label: "ref=HEAD", pin: { ...valid, ref: "HEAD" } },
      { label: "ref=tag v1.0", pin: { ...valid, ref: "v1.0" } },
      { label: "ref=refs/tags/v1.0", pin: { ...valid, ref: "refs/tags/v1.0" } },
      { label: "ref=other branch", pin: { ...valid, ref: "other" } },
      { label: "commit=abbreviated SHA", pin: { ...valid, commit: main.slice(0, 7) } },
      { label: "commit=main", pin: { ...valid, commit: "main" } },
      { label: "approved_by empty", pin: { ...valid, approved_by: "" } },
    ];
    for (const { label, pin } of cases) {
      writePinFile(dir, pin);
      const failed = mustRefuse(dir, label);
      if (failed) return failed;
    }

    writePinFile(dir, valid);
    const loaded = loadServingConfig(dir);
    if (loaded.pin?.approved_by !== "Reagent Smith") {
      return { code: "SECURITY CRITICAL", detail: `valid pin with approved_by "Reagent Smith" did not load` };
    }

    return {
      code: "PASS — POLICY",
      detail:
        "Hand-edited active.json (proposal commit/ref, HEAD, tag, other branch, abbreviated SHA, commit=main) failed closed; serve did not load the tampered tree",
    };
  } catch (err) {
    return {
      code: "SECURITY CRITICAL",
      detail: `unexpected error in security scenario: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
