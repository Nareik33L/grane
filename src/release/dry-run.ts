#!/usr/bin/env node
/**
 * Release-checklist dry-run (P0-3).
 *
 * Pins every gate to an exact RC SHA cut from main. Refuses pack-time
 * lifecycle scripts (npm 10 still runs `prepare` with `--ignore-scripts`),
 * then runs a file-list `npm pack --dry-run --ignore-scripts` check and a
 * read-only `npm view grane-analytics` ownership check. Does not publish,
 * tag, push, version, dist-tag, or dispatch certify-cloud.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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

export type PackageMeta = {
  name?: string;
  main?: string;
  bin?: Record<string, string>;
  scripts?: Record<string, string>;
  files?: string[];
};

export type DryRunResult = {
  exitCode: number;
  output: string;
  steps: DryRunStep[];
  packedFiles: string[];
  unexpectedFiles: string[];
  missingRequired: string[];
  npmView: NpmViewResult | null;
  executed: string[][];
};

const SHA_RE = /^[0-9a-f]{40}$/i;

/** prepack/prepare/postpack must not run — always pass --ignore-scripts. */
export const NPM_PACK_ARGV = ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"] as const;
export const NPM_VIEW_ARGV = ["npm", "view", PACKAGE_NAME, "--json"] as const;

/**
 * Pack-time lifecycle hooks. npm 10.x `npm pack --ignore-scripts` still
 * runs `prepare`; refuse these so the dry-run never executes them.
 * `prepublishOnly` is publish-only and is not invoked (we never publish).
 */
export const PACK_TIME_LIFECYCLE_SCRIPTS = ["prepare", "prepack", "postpack", "prepublish"] as const;

/** Demo/example/root files that may appear in the tarball — not a glob. */
export const EXACT_PACK_FILES = new Set([
  "package.json",
  "README.md",
  "README",
  "LICENSE",
  "LICENSE.md",
  "CHANGELOG.md",
  "demo/README.md",
  "demo/analytics/dimensions.yml",
  "demo/analytics/grane.yml",
  "demo/analytics/metrics.yml",
  "demo/analytics/relationships.yml",
  "demo/mcp.json",
  "demo/questions.md",
  "demo/run.sh",
  "demo/scripts/generate_shop.py",
  "demo/seed/01_schema.sql",
  "demo/seed/02_data.sql",
  "demo/seed/duckdb.sql",
  "demo/seed/duckdb_schema.sql",
  "demo/why-revenue-fell.gif",
  "demo/why-revenue-fell.svg",
  "example/DEMO.md",
  "example/analytics-duckdb/databricks_load.sql",
  "example/analytics-duckdb/dimensions.yml",
  "example/analytics-duckdb/grane.yml",
  "example/analytics-duckdb/metrics.yml",
  "example/analytics-duckdb/parquet/customers.parquet",
  "example/analytics-duckdb/parquet/order_items.parquet",
  "example/analytics-duckdb/parquet/orders.parquet",
  "example/analytics-duckdb/parquet/payments.parquet",
  "example/analytics-duckdb/parquet/products.parquet",
  "example/analytics-duckdb/parquet/refunds.parquet",
  "example/analytics-duckdb/relationships.yml",
  "example/analytics-from-dbt/grane.yml",
  "example/analytics/dimensions.yml",
  "example/analytics/grane.yml",
  "example/analytics/metrics.yml",
  "example/analytics/relationships.yml",
  "example/dbt-shop/dbt_project.yml",
  "example/dbt-shop/models/customers.yml",
  "example/dbt-shop/models/metrics.yml",
  "example/dbt-shop/models/orders.yml",
  "example/docker-compose.yml",
  "example/scripts/build_duckdb.py",
  "example/seed/README.md",
]);

/** Compiled output only — never `dist/tests/**` or `*.map`. */
export const PACK_ALLOW_PATTERNS: readonly RegExp[] = [
  /^dist\/(?!tests\/).+\.js$/,
  /^dist\/(?!tests\/).+\.d\.ts$/,
];

/** Names that must never ship, even if someone adds them to the exact list. */
export const FORBIDDEN_PACK_NAME_RES: readonly RegExp[] = [
  /(^|\/)creds(\.|\/|$)/i,
  /credentials/i,
  /(^|\/)\.secrets(\.|\/|$)/i,
  /(^|\/)secrets?(\.|\/|$)/i,
  /deploy-key/i,
  /(^|\/)fixtures\//,
  /(^|\/)tests\//,
  /\.map$/i,
  /(^|\/)id_(rsa|ed25519|ecdsa)(\.|\/|$)/,
  /(^|\/)\.env(\.|\/|$)/,
];

const FORBIDDEN_ARGV = [
  ["npm", "publish"],
  ["npm", "version"],
  ["npm", "dist-tag"],
  ["git", "tag"],
  ["git", "push"],
  ["gh", "workflow", "run"],
  ["gh", "release"],
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
      title: "npm pack --dry-run --ignore-scripts file-list check",
      owner: "Lead",
      sha: pin,
      command: `git rev-parse HEAD # expect ${pin} && ${NPM_PACK_ARGV.join(" ")}`,
      execute: "run",
    },
    {
      id: "npm-view",
      title: "package-name ownership check (read-only)",
      owner: "Lead",
      sha: pin,
      command: `${NPM_VIEW_ARGV.join(" ")} # read-only at RC ${pin}`,
      execute: "run",
    },
    {
      id: "npm-publish-hold",
      title: "npm publish (on hold — not run)",
      owner: "Lead",
      sha: pin,
      command: `# not run at ${pin}: npm publish / npm version / npm dist-tag / gh release`,
      execute: "print-only",
    },
  ];
}

export function normalizePackPath(rel: string): string {
  return rel.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/^package\//, "");
}

export function packLifecycleScriptHits(scripts: Record<string, unknown> | undefined): string[] {
  return Object.keys(scripts ?? {}).filter((name) => {
    const key = name.toLowerCase();
    if (key === "prepublishonly") return false;
    if ((PACK_TIME_LIFECYCLE_SCRIPTS as readonly string[]).includes(key)) return true;
    return key.startsWith("prepublish");
  });
}

export function assertNoPackLifecycleScripts(scripts: Record<string, unknown> | undefined): void {
  const hits = packLifecycleScriptHits(scripts);
  if (hits.length > 0) {
    throw new Error(
      `package.json must not define pack-time scripts (${hits.join(", ")}): ` +
        `npm pack --dry-run --ignore-scripts still runs prepare on npm 10. ` +
        `Remove them; prepublishOnly (publish-only) is the exception because this dry-run never publishes.`,
    );
  }
}

export function isForbiddenPackName(rel: string): boolean {
  const n = normalizePackPath(rel);
  return FORBIDDEN_PACK_NAME_RES.some((re) => re.test(n));
}

export function isAllowedPackPath(rel: string): boolean {
  const n = normalizePackPath(rel);
  if (isForbiddenPackName(n)) return false;
  if (EXACT_PACK_FILES.has(n)) return true;
  return PACK_ALLOW_PATTERNS.some((re) => re.test(n));
}

export function unexpectedPackedFiles(paths: readonly string[]): string[] {
  return paths.filter((p) => !isAllowedPackPath(p));
}

export function requiredPackedPaths(pkg: PackageMeta): string[] {
  const bins = [...new Set(Object.values(pkg.bin ?? {}))];
  const main = pkg.main?.trim() || "dist/index.js";
  return [...new Set(["README.md", main, ...bins])];
}

export function missingRequiredPackedFiles(paths: readonly string[], pkg: PackageMeta): string[] {
  const have = new Set(paths.map(normalizePackPath));
  return requiredPackedPaths(pkg).filter((req) => {
    if (req === "README.md") return !have.has("README.md") && !have.has("README");
    return !have.has(req);
  });
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

export function assertRunnable(step: DryRunStep): void {
  if (step.execute !== "run") {
    throw new Error(`refusing to execute print-only step ${step.id}`);
  }
}

export function runnableSteps(steps: readonly DryRunStep[]): DryRunStep[] {
  const run: DryRunStep[] = [];
  for (const step of steps) {
    if (step.execute === "print-only") continue;
    assertRunnable(step);
    run.push(step);
  }
  return run;
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

function readPackageMeta(root: string): PackageMeta {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMeta;
  if (pkg.name !== PACKAGE_NAME) {
    throw new Error(`package.json name must be ${PACKAGE_NAME}, got ${pkg.name ?? "(missing)"}.`);
  }
  return pkg;
}

export function assertPublishFilesExcludeMaps(files: string[] | undefined): void {
  const entries = files ?? [];
  if (!entries.some((f) => f === "!dist/**/*.map" || f === "!dist/**/*.js.map")) {
    throw new Error(
      'package.json files must exclude source maps (`!dist/**/*.map`) so the published tarball cannot ship dist/**/*.js.map.',
    );
  }
}

/** dist JS and d.ts files that tsc emits from src TypeScript. */
export function expectedBuiltDistPaths(root: string): Set<string> {
  const srcRoot = join(root, "src");
  const out = new Set<string>();
  if (!existsSync(srcRoot)) return out;
  const walk = (rel: string) => {
    const abs = rel ? join(srcRoot, rel) : srcRoot;
    for (const name of readdirSync(abs)) {
      const next = rel ? `${rel}/${name}` : name;
      const st = statSync(join(srcRoot, next));
      if (st.isDirectory()) {
        walk(next);
        continue;
      }
      if (!name.endsWith(".ts") || name.endsWith(".d.ts")) continue;
      const dest = next.slice(0, -3);
      out.add(`dist/${dest}.js`);
      out.add(`dist/${dest}.d.ts`);
    }
  };
  walk("");
  return out;
}

/** Packed `dist/` paths that the TypeScript build would not emit. */
export function strayPackedDistFiles(paths: readonly string[], root: string): string[] {
  const expected = expectedBuiltDistPaths(root);
  return paths
    .map(normalizePackPath)
    .filter((n) => n.startsWith("dist/") && !expected.has(n));
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

  let packedFiles: string[] = [];
  let unexpectedFiles: string[] = [];
  let missingRequired: string[] = [];
  const pkg = readPackageMeta(options.root);
  assertNoPackLifecycleScripts(pkg.scripts);
  assertPublishFilesExcludeMaps(pkg.files);

  for (const step of runnableSteps(steps)) {
    if (step.id === "npm-pack") {
      const pack = exec(NPM_PACK_ARGV);
      if (pack.status !== 0) {
        throw new Error(`npm pack --dry-run failed: ${(pack.stderr || pack.stdout).trim()}`);
      }
      packedFiles = packedPathsFromNpmPackJson(pack.stdout || pack.stderr);
      unexpectedFiles = unexpectedPackedFiles(packedFiles);
      missingRequired = missingRequiredPackedFiles(packedFiles, pkg);
      const strayDist = strayPackedDistFiles(packedFiles, options.root);
      if (unexpectedFiles.length > 0 || missingRequired.length > 0 || strayDist.length > 0) {
        const bits: string[] = [];
        if (missingRequired.length > 0) bits.push(`missing required files: ${missingRequired.join(", ")}`);
        if (unexpectedFiles.length > 0) {
          bits.push(
            `not on the pack allowlist:\n${unexpectedFiles.map((f) => `  ${f}`).join("\n")}`,
          );
        }
        if (strayDist.length > 0) {
          bits.push(
            `not produced by the build (stray dist/):\n${strayDist.map((f) => `  ${f}`).join("\n")}`,
          );
        }
        throw new Error(`npm pack --dry-run file-list check failed (${bits.join("; ")})`);
      }
      log(`npm pack --dry-run --ignore-scripts: ${packedFiles.length} files, allowlist + required files OK.`);
      continue;
    }
    if (step.id === "npm-view") {
      const view = exec(NPM_VIEW_ARGV);
      const npmView = parseNpmViewResult(view.stdout, view.stderr, view.status);
      log(`npm view ${PACKAGE_NAME}: ${npmView.detail}`);
      log("PASS");
      return {
        exitCode: 0,
        output: lines.join("\n"),
        steps,
        packedFiles,
        unexpectedFiles,
        missingRequired,
        npmView,
        executed,
      };
    }
    throw new Error(`no runner for step ${step.id}`);
  }

  throw new Error("release dry-run did not run the npm-view step.");
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
