#!/usr/bin/env node
/**
 * Release-checklist dry-run (P0-3).
 *
 * Pins every gate to an exact RC SHA cut from main. Runs a file-list
 * `npm pack --dry-run` check and a read-only `npm view grane-analytics`
 * ownership check. Does not publish, tag, push, or dispatch certify-cloud.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PACKAGE_NAME = "grane-analytics";

export const RELEASE_OWNERS = ["Lead", "QA", "Kieran"] as const;
export type ReleaseOwner = (typeof RELEASE_OWNERS)[number];

export type DryRunExecute = "run" | "print-only";

export type DryRunStep = {
  id: string;
  title: string;
  owner: ReleaseOwner;
  sha: string;
  command: string;
  execute: DryRunExecute;
};

export type RunCommand = (
  argv: readonly string[],
  opts?: { cwd?: string },
) => { stdout: string; stderr: string; status: number };

export type DryRunOptions = {
  sha: string;
  root: string;
  argv?: readonly string[];
  /** Injected HEAD SHA; default is `git rev-parse HEAD`. */
  headSha?: string;
  /** Injected `git status --porcelain`; default is a live status check. */
  treeStatus?: string;
  run?: RunCommand;
  log?: (line: string) => void;
};

export type NpmViewResult =
  | { kind: "unpublished"; detail: string }
  | { kind: "published"; name: string; version: string; detail: string };

export type DryRunResult = {
  exitCode: number;
  output: string;
  steps: DryRunStep[];
  packedFiles: string[];
  unexpectedFiles: string[];
  npmView: NpmViewResult | null;
  executed: string[][];
};

const SHA_RE = /^[0-9a-f]{40}$/i;

const ALWAYS_PACKED = new Set([
  "package.json",
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
]);

const FORBIDDEN_ARGV = [
  ["npm", "publish"],
  ["git", "tag"],
  ["git", "push"],
  ["gh", "workflow", "run"],
  ["gh", "api"],
];

export function parseRcSha(value: string): string {
  const sha = value.trim().toLowerCase();
  if (!SHA_RE.test(sha)) {
    throw new Error("RC SHA must be the full 40-character commit from main (not a branch name or short hash).");
  }
  return sha;
}

/** How Lead cuts the RC from main and pins later steps to that SHA. */
export function rcCutFromMainInstructions(sha: string): string[] {
  const pin = parseRcSha(sha);
  return [
    "Lead cuts the RC from main (never from a feature branch):",
    "  git fetch origin main",
    "  RC=$(git rev-parse origin/main)",
    `  # this dry-run is pinned to ${pin}`,
    "  test \"$RC\" = \"" + pin + "\"",
    "  git checkout \"$RC\"",
    `  npx tsx src/release/dry-run.ts --sha ${pin}`,
  ];
}

export function releaseDryRunPlan(sha: string): DryRunStep[] {
  const pin = parseRcSha(sha);
  return [
    {
      id: "rc-cut",
      title: "Cut the RC from main",
      owner: "Lead",
      sha: pin,
      command: `git fetch origin main && test "$(git rev-parse origin/main)" = "${pin}" && git checkout ${pin}`,
      execute: "print-only",
    },
    {
      id: "gate-5",
      title: "Credentialed certify-cloud on the exact RC commit",
      owner: "Kieran",
      sha: pin,
      command: `gh workflow run certify-cloud.yml --ref ${pin} -f engine=all`,
      execute: "print-only",
    },
    {
      id: "gate-8",
      title: "QA independent RC certification",
      owner: "QA",
      sha: pin,
      command:
        `git checkout ${pin} && npx tsx src/cli/index.ts certify --engine snowflake` +
        ` && npx tsx src/cli/index.ts certify --engine bigquery` +
        ` && npx tsx src/cli/index.ts certify --engine databricks` +
        ` && npx tsx src/cli/index.ts certify --engine redshift`,
      execute: "print-only",
    },
    {
      id: "npm-pack",
      title: "npm pack --dry-run file-list check",
      owner: "Lead",
      sha: pin,
      command: `git rev-parse HEAD # expect ${pin} && npm pack --dry-run --json`,
      execute: "run",
    },
    {
      id: "npm-view",
      title: "package-name ownership check (read-only)",
      owner: "Lead",
      sha: pin,
      command: `npm view ${PACKAGE_NAME} --json # read-only at RC ${pin}`,
      execute: "run",
    },
    {
      id: "npm-publish-hold",
      title: "npm publish (on hold — not run)",
      owner: "Lead",
      sha: pin,
      command: `# not run at ${pin}: npm publish`,
      execute: "print-only",
    },
  ];
}

export function isForbiddenPackPath(rel: string): boolean {
  const n = rel.replaceAll("\\", "/").replace(/^\.?\//, "");
  const parts = n.split("/");
  if (parts.some((p) => p === "tests" || p === "test" || p === "fixtures")) return true;
  if (parts.some((p) => p === ".env" || p.startsWith(".env."))) return true;
  if (/(?:^|\/)\.env(?:$|\.)/.test(n)) return true;
  if (/\.(pem|p8|p12|pfx|key)$/i.test(n)) return true;
  if (/(?:^|\/)id_rsa(?:$|\.)/i.test(n)) return true;
  return false;
}

export function isAllowedPackPath(rel: string, filesField: readonly string[]): boolean {
  const n = rel.replaceAll("\\", "/").replace(/^\.?\//, "");
  if (isForbiddenPackPath(n)) return false;
  if (ALWAYS_PACKED.has(n)) return true;
  return filesField.some((entry) => {
    const prefix = entry.replace(/\/$/, "");
    return n === prefix || n.startsWith(`${prefix}/`);
  });
}

export function unexpectedPackedFiles(paths: readonly string[], filesField: readonly string[]): string[] {
  return paths.filter((p) => !isAllowedPackPath(p, filesField));
}

export function packedPathsFromNpmPackJson(stdout: string): string[] {
  const start = stdout.search(/[\[{]/);
  if (start < 0) {
    throw new Error("npm pack --dry-run produced no JSON file list.");
  }
  const parsed = JSON.parse(stdout.slice(start)) as unknown;
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const last = entries[entries.length - 1] as { files?: Array<{ path?: string } | string> } | undefined;
  const files = last?.files ?? [];
  return files
    .map((f) => (typeof f === "string" ? f : String(f.path ?? "")))
    .filter((p) => p.length > 0);
}

export function parseNpmViewResult(stdout: string, stderr: string, status: number): NpmViewResult {
  const text = `${stdout}\n${stderr}`;
  if (status !== 0) {
    if (/E404|404 Not Found|not in this registry|is not in this registry/i.test(text)) {
      return { kind: "unpublished", detail: `${PACKAGE_NAME} is unpublished (npm publish stays on hold).` };
    }
    throw new Error(`npm view ${PACKAGE_NAME} failed (read-only): ${text.trim() || `exit ${status}`}`);
  }
  const start = stdout.search(/[\[{]/);
  if (start >= 0) {
    const parsed = JSON.parse(stdout.slice(start)) as { name?: string; version?: string };
    const name = parsed.name ?? PACKAGE_NAME;
    if (name !== PACKAGE_NAME) {
      throw new Error(`npm view expected package ${PACKAGE_NAME}, got ${name}.`);
    }
    return {
      kind: "published",
      name,
      version: String(parsed.version ?? ""),
      detail: `${name}@${parsed.version ?? "unknown"} (read-only; not published by this script).`,
    };
  }
  if (stdout.includes(PACKAGE_NAME)) {
    return { kind: "published", name: PACKAGE_NAME, version: "", detail: stdout.trim() };
  }
  throw new Error(`npm view ${PACKAGE_NAME} returned no ownership data.`);
}

export function refuseMutatingCliArgs(argv: readonly string[]): void {
  for (const arg of argv) {
    if (arg === "--publish" || arg === "--tag" || arg === "--push") {
      throw new Error("release dry-run refuses --publish / --tag / --push; it does not publish, tag, or push.");
    }
  }
}

export function parseDryRunArgs(argv: readonly string[]): { sha: string } {
  refuseMutatingCliArgs(argv);
  const i = argv.indexOf("--sha");
  const value = i >= 0 ? argv[i + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error("usage: npx tsx src/release/dry-run.ts --sha <40-character RC SHA>");
  }
  return { sha: parseRcSha(value) };
}

export function assertSafeArgv(argv: readonly string[]): void {
  for (const banned of FORBIDDEN_ARGV) {
    let i = 0;
    for (let j = 0; j < argv.length && i < banned.length; j++) {
      if (argv[j] === banned[i]) i++;
    }
    if (i === banned.length) {
      throw new Error(`release dry-run must not execute ${banned.join(" ")}.`);
    }
  }
}

export function assertCertifyCloudPinsDispatchRef(workflow: string): void {
  if (!/workflow_dispatch/.test(workflow)) {
    throw new Error("certify-cloud.yml must declare workflow_dispatch so Kieran can pin --ref <RC SHA>.");
  }
  if (/uses:\s*actions\/checkout@v\d[\s\S]{0,120}\n\s+with:[\s\S]{0,80}\n\s+ref:/.test(workflow)) {
    throw new Error("certify-cloud.yml checkout must not hardcode ref; dispatch --ref <RC SHA> must win.");
  }
}

function defaultRun(argv: readonly string[], opts?: { cwd?: string }): { stdout: string; stderr: string; status: number } {
  assertSafeArgv(argv);
  const cmd = argv[0];
  if (!cmd) throw new Error("empty command");
  const result = spawnSync(cmd, argv.slice(1) as string[], {
    cwd: opts?.cwd,
    encoding: "utf8",
    env: process.env,
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

function readFilesField(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name?: string; files?: string[] };
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`package.json name must be ${PACKAGE_NAME}, got ${pkg.name ?? "(missing)"}.`);
  }
  return pkg.files ?? [];
}

export function runReleaseDryRun(options: DryRunOptions): DryRunResult {
  const sha = parseRcSha(options.sha);
  refuseMutatingCliArgs(options.argv ?? []);
  const run = options.run ?? defaultRun;
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    options.log?.(line);
  };
  const executed: string[][] = [];
  const exec = (argv: readonly string[]) => {
    assertSafeArgv(argv);
    executed.push([...argv]);
    return run(argv, { cwd: options.root });
  };

  const steps = releaseDryRunPlan(sha);
  log(`Release-checklist dry-run`);
  log(`RC SHA: ${sha}`);
  log(`This script does not publish, tag, or push.`);
  log("");
  for (const line of rcCutFromMainInstructions(sha)) log(line);
  log("");

  const workflow = readFileSync(join(options.root, ".github/workflows/certify-cloud.yml"), "utf8");
  assertCertifyCloudPinsDispatchRef(workflow);

  const head =
    options.headSha ??
    exec(["git", "rev-parse", "HEAD"]).stdout.trim();
  const headSha = parseRcSha(head);
  if (headSha !== sha) {
    throw new Error(
      `HEAD is ${headSha}; checkout the RC SHA first so npm pack inspects ${sha} (git checkout ${sha}).`,
    );
  }
  const porcelain =
    options.treeStatus ??
    exec(["git", "status", "--porcelain"]).stdout;
  if (porcelain.trim()) {
    throw new Error(
      `working tree is dirty; checkout ${sha} cleanly so npm pack --dry-run matches the RC.`,
    );
  }

  for (const step of steps) {
    log(`[${step.id}] owner=${step.owner} pin=${step.sha} (${step.execute})`);
    log(`  ${step.command}`);
  }
  log("");

  const filesField = readFilesField(options.root);
  const pack = exec(["npm", "pack", "--dry-run", "--json"]);
  if (pack.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${(pack.stderr || pack.stdout).trim()}`);
  }
  const packedFiles = packedPathsFromNpmPackJson(pack.stdout || pack.stderr);
  const unexpectedFiles = unexpectedPackedFiles(packedFiles, filesField);
  if (unexpectedFiles.length > 0) {
    throw new Error(
      `npm pack --dry-run file-list check failed (tests, fixtures, .env, keys, or other unexpected files):\n` +
        unexpectedFiles.map((f) => `  ${f}`).join("\n"),
    );
  }
  log(`npm pack --dry-run: ${packedFiles.length} files, none unexpected.`);

  const view = exec(["npm", "view", PACKAGE_NAME, "--json"]);
  const npmView = parseNpmViewResult(view.stdout, view.stderr, view.status);
  log(`npm view ${PACKAGE_NAME}: ${npmView.detail}`);
  log("PASS");

  return {
    exitCode: 0,
    output: lines.join("\n"),
    steps,
    packedFiles,
    unexpectedFiles,
    npmView,
    executed,
  };
}

function invokedAsCli(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  return resolve(arg) === fileURLToPath(import.meta.url);
}

export function main(argv: readonly string[] = process.argv.slice(2), root = join(dirname(fileURLToPath(import.meta.url)), "../..")): number {
  try {
    const { sha } = parseDryRunArgs(argv);
    const result = runReleaseDryRun({ sha, root, argv });
    console.log(result.output);
    return result.exitCode;
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    return 1;
  }
}

if (invokedAsCli()) {
  process.exit(main());
}
