#!/usr/bin/env node
/**
 * `npm pack --dry-run --ignore-scripts` file-list check against the exact
 * allowlist. Used by `.github/workflows/publish-npm.yml` after build+tests
 * and before any `npm publish`. Does not publish, tag, or push.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  NPM_PACK_ARGV,
  assertNoPackLifecycleScripts,
  assertPublishFilesExcludeMaps,
  missingRequiredPackedFiles,
  packedPathsFromNpmPackJson,
  strayPackedDistFiles,
  unexpectedPackedFiles,
  type PackageMeta,
} from "./dry-run.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, "../..");

export function runPackAllowlistCheck(root = DEFAULT_ROOT): { packedFiles: string[]; count: number } {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as PackageMeta;
  assertNoPackLifecycleScripts(pkg.scripts);
  assertPublishFilesExcludeMaps(pkg.files);
  const pack = spawnSync(NPM_PACK_ARGV[0]!, NPM_PACK_ARGV.slice(1) as string[], {
    cwd: root,
    encoding: "utf8",
  });
  if (pack.status !== 0) {
    throw new Error(`npm pack --dry-run failed: ${(pack.stderr || pack.stdout).trim()}`);
  }
  const packedFiles = packedPathsFromNpmPackJson(pack.stdout || pack.stderr);
  const unexpected = unexpectedPackedFiles(packedFiles);
  const missing = missingRequiredPackedFiles(packedFiles, pkg);
  const stray = strayPackedDistFiles(packedFiles, root);
  if (unexpected.length > 0 || missing.length > 0 || stray.length > 0) {
    const bits: string[] = [];
    if (missing.length > 0) bits.push(`missing required files: ${missing.join(", ")}`);
    if (unexpected.length > 0) {
      bits.push(`not on the pack allowlist:\n${unexpected.map((f) => `  ${f}`).join("\n")}`);
    }
    if (stray.length > 0) {
      bits.push(`not produced by the build (stray dist/):\n${stray.map((f) => `  ${f}`).join("\n")}`);
    }
    throw new Error(`npm pack --dry-run file-list check failed (${bits.join("; ")})`);
  }
  return { packedFiles, count: packedFiles.length };
}

function invokedAsCli(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  return resolve(arg) === fileURLToPath(import.meta.url);
}

if (invokedAsCli()) {
  try {
    const { count } = runPackAllowlistCheck();
    console.log(`npm pack --dry-run --ignore-scripts: ${count} files, allowlist OK.`);
  } catch (err) {
    console.error(`ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
}
