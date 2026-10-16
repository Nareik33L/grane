import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { preflightAuditWrite, recordPinAudit, recordProposalAudit } from "../audit.js";
import { findProjectDir, isAdopterTestYaml, loadConfig, type LoadedConfig } from "../config/load.js";
import { graneConfigSchema, type GraneConfig } from "../config/schema.js";
import { configError } from "../errors.js";
import { SemanticModel } from "../model/model.js";
import { validateModel } from "../validate/validate.js";
import { isDemoAuthoringProject, DEMO_AUTHORING_MARKER } from "./demo-marker.js";
import {
  combineSemanticYamlWithReport,
  emptyRestored,
  SEMANTIC_YAML_KEYS,
  type SemanticYamlRestored,
} from "./yaml-merge.js";

const FULL_SHA = /^[0-9a-fA-F]{40}$/;

/**
 * Git proposal library (V2-03). Shells out to `git` only — no GitHub SDK.
 *
 * Kieran's decisions: proposals are GitHub PRs; approval is merging the PR;
 * anyone with merge rights can approve; AI-generated metrics stay
 * `experimental` until that merge, after which they are `governed`.
 *
 * This module never writes to the active branch. Proposal commits are created
 * with plumbing (`commit-tree` + `update-ref` on `grane/proposal/*` only).
 * `approveProposal` validates YAML, pins the proposal's merged commit on
 * the configured base (merge commit, or the squash/rebase commit whose
 * metric YAML matches — never the moving base tip), commits the tracked
 * pin on `grane/pin/*`, and prints a PR plan. If no matching base commit
 * exists it refuses with a clear error; it never pins silently. It never
 * pushes to or merges the base branch. Rollback re-pins the last good
 * local pin. Reject deletes a proposal ref only.
 */

export const PROPOSAL_BRANCH_PREFIX = "grane/proposal/";
export const PIN_BRANCH_PREFIX = "grane/pin/";
/** Legacy local-only pin (gitignored). Honoured when no tracked pin is present. */
export const ACTIVE_PIN_PATH = ".grane/active.json";
/** Shared pin committed on `grane/pin/*` and merged via PR. Not gitignored. */
export const TRACKED_PIN_PATH = "grane.pin.json";

export const LEGACY_PIN_MIGRATION =
  `WARNING: ${ACTIVE_PIN_PATH} is local-only; other clones will not see this pin. ` +
  `After merging a proposal, run \`grane proposals approve\` to commit ${TRACKED_PIN_PATH} ` +
  `on a ${PIN_BRANCH_PREFIX}* branch and open a PR (never merged or pushed to the base by Grane).`;

export const activePinSchema = z.object({
  ref: z.string().min(1),
  commit: z.string().min(1),
  approved_by: z.string().min(1),
  approved_at: z.string().min(1),
  proposal: z.string().optional(),
  previous_commit: z.string().nullable().optional(),
});
export type ActivePin = z.infer<typeof activePinSchema>;
export type PinSource = "tracked" | "legacy";

export interface ApproveResult extends ActivePin {
  pin_branch: string;
  pin_file: typeof TRACKED_PIN_PATH;
  github: GitHubPrPlan;
}

export interface Proposal {
  id: string;
  branch: string;
  commit: string;
  base_branch: string;
  base_commit: string;
  title: string;
}

export interface NameDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface SemanticMergeReport {
  restored: SemanticYamlRestored;
  lost_comments: string[];
}

export interface SemanticProposalDiff {
  metrics: NameDiff;
  dimensions: NameDiff;
  relationships: NameDiff;
  entities: NameDiff;
  merge: SemanticMergeReport;
}

export interface ProposalDiff {
  unified: string;
  files: string[];
  semantic: SemanticProposalDiff | null;
  semantic_error?: string;
}

export interface GitHubPrPlan {
  title: string;
  body: string;
  head: string;
  base: string;
  repo: string | null;
  command: string;
}

export interface MergedApproval {
  merged: boolean;
  proposal_id: string;
  proposal_branch: string;
  proposal_commit: string;
  base_branch: string;
  merge_commit: string | null;
  /** After a merged PR, AI-generated metrics are governed. Until then, experimental. */
  metric_trust: "experimental" | "governed";
}

export interface CreateProposalInput {
  slug: string;
  files: Record<string, string>;
  message?: string;
  title?: string;
  at?: Date;
}

interface GitRunOptions {
  input?: string;
  env?: NodeJS.ProcessEnv;
  allowFail?: boolean;
}

/** Drop inherited GIT_* so a hostile env cannot redirect the repo (GIT_DIR, GIT_WORK_TREE, …). */
function envWithoutInheritedGit(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("GIT_")) continue;
    env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_NO_REPLACE_OBJECTS = "1";
  if (overrides) {
    for (const [key, value] of Object.entries(overrides)) {
      if (key === "GIT_NO_REPLACE_OBJECTS") continue;
      env[key] = value;
    }
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  return env;
}

function runGit(repoDir: string, args: string[], options: GitRunOptions = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    input: options.input,
    env: envWithoutInheritedGit(options.env),
  });
  if (result.error) {
    throw configError(
      `git is not available (${result.error.message}). Install git, then retry.`,
    );
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const status = result.status ?? 1;
  if (status !== 0 && !options.allowFail) {
    throw configError(`git ${args.join(" ")} failed: ${(stderr || stdout).trim() || `exit ${status}`}`);
  }
  return { stdout, stderr, status };
}

function git(repoDir: string, args: string[], options: GitRunOptions = {}): string {
  return runGit(repoDir, args, options).stdout.replace(/\n$/, "");
}

function gitRoot(projectDir: string): string {
  const probe = runGit(projectDir, ["rev-parse", "--is-inside-work-tree"], { allowFail: true });
  if (probe.status !== 0 || probe.stdout.trim() !== "true") {
    throw configError(
      `No git repository in ${resolve(projectDir)}. Run "git init", commit the Grane YAML, and add a GitHub remote. ` +
        `Proposals are GitHub PRs; approval is merging the PR. Grane will not invent a repo or write to a missing one.`,
    );
  }
  const root = git(projectDir, ["rev-parse", "--show-toplevel"]).trim();
  assertTrustedGitHistory(root);
  return root;
}

/**
 * Refuse history rewriting via `git replace` or a non-empty `.git/info/grafts`.
 * `GIT_NO_REPLACE_OBJECTS=1` is also set on every spawn so a replace ref
 * cannot fake ancestry (`git replace` making a proposal look like a parent
 * of the base). Shallow clones (`.git/shallow`) are allowed: they omit
 * parents, they do not add them.
 */
function assertTrustedGitHistory(root: string): void {
  const replace = runGit(root, ["for-each-ref", "--format=%(refname)", "refs/replace"], { allowFail: true });
  if (replace.stdout.trim()) {
    throw configError(
      `Refusing git replace objects under refs/replace/. ` +
        `Delete them (\`git replace -d <rev>\`) before using Grane authoring. ` +
        `Replace refs can make a proposal look like a parent of the base.`,
    );
  }
  const gitDir = runGit(root, ["rev-parse", "--absolute-git-dir"], { allowFail: true }).stdout.trim();
  if (!gitDir) return;
  const grafts = join(gitDir, "info", "grafts");
  if (existsSync(grafts)) {
    const body = readFileSync(grafts, "utf8").trim();
    if (body) {
      throw configError(
        `Refusing git grafts at .git/info/grafts. Remove that file before using Grane authoring.`,
      );
    }
  }
}

function porcelainPath(line: string): string {
  const body = line.slice(3);
  const renamed = body.split(" -> ");
  return (renamed[renamed.length - 1] ?? body).replace(/^"/, "").replace(/"$/, "");
}

function isRuntimeStatePath(path: string): boolean {
  const normalised = path.replaceAll("\\", "/");
  return normalised === ".grane" || normalised.startsWith(".grane/");
}

function isDeniedProposalPath(path: string): boolean {
  const normalised = path.replaceAll("\\", "/");
  return (
    normalised === TRACKED_PIN_PATH ||
    normalised === ACTIVE_PIN_PATH ||
    isRuntimeStatePath(normalised)
  );
}

function isProjectYamlName(filename: string): boolean {
  return (filename.endsWith(".yml") || filename.endsWith(".yaml")) && !isAdopterTestYaml(filename);
}

/** Basenames `loadConfig` would merge from `projectDir` (non-recursive). */
export function projectYamlBasenames(projectDir: string): string[] {
  const dir = resolve(projectDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => isProjectYamlName(name) && statSync(join(dir, name)).isFile())
    .sort();
}

function commitProjectYamlBasenames(root: string, commit: string, relProject: string): string[] {
  const prefix = relProject ? `${relProject.replace(/\/$/, "")}/` : "";
  const listing = git(root, ["ls-tree", "-r", "--name-only", commit]);
  const names: string[] = [];
  for (const path of listing.split("\n").map((line) => line.trim()).filter(Boolean)) {
    if (prefix) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      if (rest.includes("/") || !isProjectYamlName(rest)) continue;
      names.push(rest);
      continue;
    }
    if (path.includes("/") || !isProjectYamlName(path)) continue;
    names.push(path);
  }
  return [...new Set(names)].sort();
}

/**
 * Import pins `commit`. Refuse if any YAML `loadConfig` would read (including
 * untracked or gitignored files) differs from that commit.
 */
export function assertProjectYamlMatchesCommit(projectDir: string, commit: string): void {
  const root = gitRoot(projectDir);
  const absProject = resolve(projectDir);
  let relProject = relative(root, absProject).replaceAll("\\", "/");
  if (relProject === "." || relProject === "") relProject = "";
  resolveCommit(root, commit);

  const names = [
    ...new Set([...projectYamlBasenames(absProject), ...commitProjectYamlBasenames(root, commit, relProject)]),
  ].sort();
  for (const name of names) {
    const diskPath = join(absProject, name);
    const gitPath = relProject ? `${relProject}/${name}` : name;
    const disk = existsSync(diskPath) && statSync(diskPath).isFile() ? readFileSync(diskPath, "utf8") : null;
    const shown = runGit(root, ["show", `${commit}:${gitPath}`], { allowFail: true });
    const committed = shown.status === 0 ? shown.stdout : null;
    if (disk !== committed) {
      throw configError(
        `Refusing to activate: "${name}" does not match commit ${commit.slice(0, 7)}. ` +
          `Import pins that commit, not the working tree (untracked and ignored *.yml count). ` +
          `Commit, revert, or remove the file so the project directory matches the configured base branch.`,
      );
    }
  }
}

export function assertCleanWorktree(projectDir: string): void {
  const root = gitRoot(projectDir);
  const status = git(root, ["status", "--porcelain", "-uall"]);
  const dirty = status
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .filter((line) => !isRuntimeStatePath(porcelainPath(line)));
  if (dirty.length > 0) {
    throw configError(
      `Working tree is dirty. Commit or stash your changes, then retry.\n` +
        dirty.map((line) => `  ${line}`).join("\n") +
        `\nGrane only commits drafts on ${PROPOSAL_BRANCH_PREFIX}* branches so the active branch stays untouched.`,
    );
  }
}

function localHeadsBranch(root: string, name: string): boolean {
  return runGit(root, ["rev-parse", "--verify", `refs/heads/${name}`], { allowFail: true }).status === 0;
}

function originHeadBranch(root: string): string | null {
  const originHead = git(root, ["rev-parse", "--abbrev-ref", "origin/HEAD"], { allowFail: true }).trim();
  if (originHead && originHead !== "origin/HEAD") {
    return originHead.replace(/^origin\//, "");
  }
  return null;
}

function parseBaseBranchFromYamlContents(contents: Record<string, string>): string | null {
  for (const name of ["grane.yml", "grane.yaml"]) {
    const raw = contents[name];
    if (!raw) continue;
    try {
      const doc = parseYaml(raw);
      if (!doc || typeof doc !== "object") continue;
      const value = (doc as { project?: { base_branch?: unknown } }).project?.base_branch;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      continue;
    }
  }
  return null;
}

function normalizeBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * Established refs only: origin/HEAD, main, master.
 * Never HEAD and never `.grane/active.json` — a feature branch that commits
 * `base_branch: feature`, or a hand-edited pin with `ref: feature`, must not
 * become the configured base. A valid pin is checked against this base.
 */
function establishedBaseRefs(root: string): string[] {
  const refs: string[] = [];
  if (originHeadBranch(root)) refs.push("origin/HEAD");
  for (const name of ["main", "master"]) {
    if (localHeadsBranch(root, name)) refs.push(`refs/heads/${name}`);
  }
  return refs;
}

function committedExplicitBaseBranch(projectDir: string): string | null {
  const root = gitRoot(projectDir);
  const seen = new Set<string>();
  for (const ref of establishedBaseRefs(root)) {
    const probe = runGit(root, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFail: true });
    if (probe.status !== 0) continue;
    const commit = probe.stdout.trim();
    if (seen.has(commit)) continue;
    seen.add(commit);
    try {
      const explicit = parseBaseBranchFromYamlContents(yamlContentsAtCommit(projectDir, commit));
      if (explicit) return explicit;
    } catch {
      continue;
    }
  }
  return null;
}

function isUsableBaseName(name: string): boolean {
  return Boolean(
    name &&
      name !== "HEAD" &&
      !name.startsWith("refs/") &&
      !name.startsWith(PROPOSAL_BRANCH_PREFIX),
  );
}

/**
 * GitHub PR / pin base. Trusted sources only (never HEAD, never a pin file,
 * never the working tree):
 * 1. `project.base_branch` from the committed tree at origin/HEAD, main, or
 *    master
 * 2. origin/HEAD, else local main/master, only when no base_branch is set
 *
 * A valid pin's `ref` must equal this value (`assertServablePin`); the pin
 * is not a source of the base, so a hand-edit cannot redirect it.
 * origin/HEAD disagreeing with committed base_branch, or (when base_branch is
 * unset) with local main/master, is refused. No established base → refuse;
 * run `grane setup` after main/master or origin/HEAD exists.
 */
export function configuredBaseBranch(projectDir: string): string {
  const root = gitRoot(projectDir);
  const originHead = originHeadBranch(root);
  const localConventional = localHeadsBranch(root, "main")
    ? "main"
    : localHeadsBranch(root, "master")
      ? "master"
      : null;
  const explicit = committedExplicitBaseBranch(projectDir);
  if (explicit) {
    if (!isUsableBaseName(explicit)) {
      throw configError(
        `Committed project.base_branch "${explicit}" is not a usable branch name. ` +
          `Set project.base_branch on the established base (main/master/origin/HEAD) and commit it.`,
      );
    }
    if (originHead && originHead !== explicit) {
      throw configError(
        `Refusing to resolve the configured base: origin/HEAD is "${originHead}" but committed ` +
          `project.base_branch is "${explicit}". Point origin/HEAD at the configured base, or ` +
          `change project.base_branch on that base and commit it. Working-tree and HEAD edits are ignored.`,
      );
    }
    if (!localHeadsBranch(root, explicit)) {
      throw configError(
        `Committed project.base_branch "${explicit}" is not an existing local refs/heads/ branch. ` +
          `Create that branch or set project.base_branch to an existing local branch and commit it.`,
      );
    }
    return explicit;
  }
  if (originHead && localConventional && originHead !== localConventional) {
    throw configError(
      `Refusing to resolve the configured base: origin/HEAD is "${originHead}" but local ` +
        `"${localConventional}" exists and no project.base_branch is committed on that established base. ` +
        `Point origin/HEAD at ${localConventional}, or set project.base_branch and commit it.`,
    );
  }
  if (originHead) return originHead;
  if (localConventional) return localConventional;
  throw configError(
    `Cannot determine the configured base branch (no established base). ` +
      `Grane will not read project.base_branch from HEAD or a feature branch. ` +
      `Create refs/heads/main (or master), set origin/HEAD, or run \`grane setup\` after that base exists.`,
  );
}

function assertNotDemoAuthoring(projectDir: string, action: string): void {
  if (!isDemoAuthoringProject(projectDir)) return;
  throw configError(
    `Refusing to ${action} in a nested demo authoring repo (${DEMO_AUTHORING_MARKER}). ` +
      `Setup --dir is for proposal branches only; approve, rollback, and pin from a real project.`,
  );
}

/**
 * Audit settings for pin / proposal writes come from the committed config at
 * the configured base — never the working tree. `audit.enabled: false` on
 * disk must not silence approve or pin-write.
 */
function pinAuditConfig(projectDir: string): { config: GraneConfig; dir: string } {
  try {
    const root = gitRoot(projectDir);
    const base = configuredBaseBranch(projectDir);
    const commit = git(root, ["rev-parse", `refs/heads/${base}`]).trim();
    const yamlContents = yamlContentsAtCommit(projectDir, commit);
    const loaded = loadConfig(projectDir, { yamlContents });
    return { config: loaded.config, dir: loaded.projectDir };
  } catch {
    return { config: graneConfigSchema.parse({}), dir: projectDir };
  }
}

function recordPinEvent(
  projectDir: string,
  input: { operation: "load" | "refuse" | "write"; ref?: string; commit?: string; approved_by?: string; reason?: string },
  config?: GraneConfig,
): void {
  const resolved = config ? { config, dir: projectDir } : pinAuditConfig(projectDir);
  recordPinAudit(resolved.config, resolved.dir, input);
}

function requireProposalBranch(branch: string): string {
  if (!branch.startsWith(PROPOSAL_BRANCH_PREFIX) || branch === PROPOSAL_BRANCH_PREFIX) {
    throw configError(
      `Refusing to write to "${branch}". Grane only creates commits on ${PROPOSAL_BRANCH_PREFIX}* — never on the active branch.`,
    );
  }
  return branch;
}

function requirePinBranch(branch: string): string {
  if (!branch.startsWith(PIN_BRANCH_PREFIX) || branch === PIN_BRANCH_PREFIX) {
    throw configError(
      `Refusing to write to "${branch}". Grane only commits ${TRACKED_PIN_PATH} on ${PIN_BRANCH_PREFIX}* — never on the active branch.`,
    );
  }
  return branch;
}

function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (!slug) {
    throw configError(`Proposal slug "${raw}" is empty after sanitising. Use letters or digits.`);
  }
  return slug;
}

function yyyymmdd(at: Date): string {
  return at.toISOString().slice(0, 10).replaceAll("-", "");
}

function proposalIdFromBranch(branch: string): string {
  requireProposalBranch(branch);
  return branch.slice(PROPOSAL_BRANCH_PREFIX.length);
}

function resolveProposalBranch(root: string, idOrBranch: string): string {
  const branch = idOrBranch.startsWith(PROPOSAL_BRANCH_PREFIX)
    ? idOrBranch
    : `${PROPOSAL_BRANCH_PREFIX}${idOrBranch}`;
  requireProposalBranch(branch);
  const probe = runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true });
  if (probe.status !== 0) {
    throw configError(
      `No proposal branch "${branch}". Create one with createProposal, then open a GitHub PR.`,
    );
  }
  return branch;
}

function fileAtCommit(root: string, commit: string, path: string): string | undefined {
  const probe = runGit(root, ["cat-file", "-e", `${commit}:${path}`], { allowFail: true });
  if (probe.status !== 0) return undefined;
  return git(root, ["show", `${commit}:${path}`]);
}

function gitPath(root: string, projectDir: string, rel: string): string {
  if (isAbsolute(rel) || rel.split(/[/\\]/).includes("..") || rel.startsWith(".git/") || rel === ".git") {
    throw configError(`Refusing to commit path "${rel}" onto a proposal branch.`);
  }
  const abs = resolve(projectDir, rel);
  const fromRoot = relative(root, abs).replaceAll(sep, "/");
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || isDeniedProposalPath(fromRoot)) {
    throw configError(`Refusing to commit path "${rel}" onto a proposal branch.`);
  }
  return fromRoot;
}

/** Pin/audit state must live inside the project, not a redirected `.grane/`. */
export function assertRegularGraneDir(projectDir: string): void {
  const dir = join(projectDir, ".grane");
  try {
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw configError(`Refusing .grane/: must be a regular directory, not a symlink or special file.`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function assertRegularPinFile(path: string, label: string): void {
  try {
    const st = lstatSync(path);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw configError(
        `Refusing ${label}: must be a regular file, not a symlink or special file.`,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function parsePinJson(rawText: string, label: string): ActivePin {
  let raw: unknown;
  try {
    raw = JSON.parse(rawText);
  } catch (err) {
    throw configError(
      `Invalid ${label}: ${(err as Error).message}. ` +
        `Expected {ref, commit, approved_by, approved_at}. Serve refuses to start.`,
    );
  }
  const parsed = activePinSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    throw configError(
      `Invalid ${label}: ${issues}. ` +
        `Expected {ref, commit, approved_by, approved_at}. Serve refuses to start.`,
    );
  }
  return parsed.data;
}

function readPinFile(projectDir: string, rel: string): ActivePin | null {
  if (rel.startsWith(".grane/") || rel === ACTIVE_PIN_PATH) {
    assertRegularGraneDir(projectDir);
  }
  const path = join(projectDir, rel);
  assertRegularPinFile(path, rel);
  if (!existsSync(path)) return null;
  return parsePinJson(readFileSync(path, "utf8"), rel);
}

export function readTrackedPin(projectDir: string): ActivePin | null {
  return readPinFile(projectDir, TRACKED_PIN_PATH);
}

export function readLegacyPin(projectDir: string): ActivePin | null {
  return readPinFile(projectDir, ACTIVE_PIN_PATH);
}

/**
 * Prefer the tracked pin (`grane.pin.json`) when present so clones share the
 * approved version. If there is no tracked pin, honour the legacy local
 * `.grane/active.json` (today's behaviour).
 */
export function readActivePin(projectDir: string): ActivePin | null {
  return readTrackedPin(projectDir) ?? readLegacyPin(projectDir);
}

export function readActivePinWithSource(projectDir: string): { pin: ActivePin; source: PinSource } | { pin: null; source: null } {
  const tracked = readTrackedPin(projectDir);
  if (tracked) return { pin: tracked, source: "tracked" };
  const legacy = readLegacyPin(projectDir);
  if (legacy) return { pin: legacy, source: "legacy" };
  return { pin: null, source: null };
}

/** YAML `loadConfig` would merge from `commit` at `projectDir` (non-recursive). */
export function yamlContentsAtCommit(projectDir: string, commit: string): Record<string, string> {
  const dir = resolve(projectDir);
  const root = gitRoot(dir);
  const resolved = resolveCommit(root, commit);
  let relProject = relative(root, dir).replaceAll("\\", "/");
  if (relProject === "." || relProject === "") relProject = "";
  const names = commitProjectYamlBasenames(root, resolved, relProject);
  const contents: Record<string, string> = {};
  for (const name of names) {
    const path = relProject ? `${relProject}/${name}` : name;
    contents[name] = git(root, ["show", `${resolved}:${path}`]);
  }
  return contents;
}

function pinLabel(source: PinSource | string | null | undefined): string {
  if (source === "tracked" || source === TRACKED_PIN_PATH) return TRACKED_PIN_PATH;
  return ACTIVE_PIN_PATH;
}

function assertServablePin(
  projectDir: string,
  pin: ActivePin,
  label: string = ACTIVE_PIN_PATH,
): { commit: string; ref: string } {
  const approvedBy = pin.approved_by.trim();
  if (!approvedBy) {
    throw configError(
      `Invalid ${label}: approved_by is empty. Expected {ref, commit, approved_by, approved_at}. Serve refuses to start.`,
    );
  }
  if (!FULL_SHA.test(pin.commit)) {
    throw configError(
      `Pinned commit "${pin.commit}" is not a full 40-character hex SHA. ` +
        `Serve refuses to start. The pin looks tampered. Fix ${label}.`,
    );
  }
  const base = configuredBaseBranch(projectDir);
  if (pin.ref !== base && pin.ref !== `refs/heads/${base}`) {
    throw configError(
      `Pinned ref "${pin.ref}" is not the configured base branch "${base}" under refs/heads/. ` +
        `Serve refuses to start. The pin looks tampered. Fix ${label}.`,
    );
  }
  const root = gitRoot(projectDir);
  const heads = `refs/heads/${base}`;
  const refProbe = runGit(root, ["rev-parse", "--verify", `${heads}^{commit}`], { allowFail: true });
  if (refProbe.status !== 0) {
    throw configError(
      `Pinned ref "${pin.ref}" is not a branch in this repository. Serve refuses to start. Fix ${label}.`,
    );
  }
  const commitProbe = runGit(root, ["rev-parse", "--verify", `${pin.commit}^{commit}`], { allowFail: true });
  if (commitProbe.status !== 0) {
    throw configError(
      `Pinned commit "${pin.commit}" is not in this repository. ` +
        `Serve refuses to start. Restore the commit or fix ${label}.`,
    );
  }
  const commit = commitProbe.stdout.trim();
  if (commit.toLowerCase() !== pin.commit.toLowerCase()) {
    throw configError(
      `Pinned commit "${pin.commit}" is not a full 40-character hex SHA. ` +
        `Serve refuses to start. The pin looks tampered. Fix ${label}.`,
    );
  }
  if (!isAncestor(root, commit, heads)) {
    throw configError(
      `Pinned commit ${commit} is not on "${base}". Serve refuses to start. The pin looks tampered. Fix ${label}.`,
    );
  }
  return { commit, ref: base };
}

function originTrackedPin(projectDir: string): ActivePin | null {
  try {
    const root = gitRoot(projectDir);
    const base = configuredBaseBranch(projectDir);
    const origin = originBaseTip(root, base);
    if (!origin) return null;
    const raw = fileAtCommit(root, origin, TRACKED_PIN_PATH);
    if (!raw) return null;
    return parsePinJson(raw, `origin/${base}:${TRACKED_PIN_PATH}`);
  } catch {
    return null;
  }
}

function pinCommitOnBase(projectDir: string, commit: string, base: string): boolean {
  try {
    const root = gitRoot(projectDir);
    const resolved = resolveCommit(root, commit);
    const heads = `refs/heads/${base}`;
    const origin = originBaseTip(root, base);
    if (runGit(root, ["rev-parse", "--verify", `${heads}^{commit}`], { allowFail: true }).status === 0) {
      if (isAncestor(root, resolved, heads)) return true;
    }
    if (origin && isAncestor(root, resolved, origin)) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Warnings only. Never auto-switches the served pin to origin's copy.
 * Serve still refuses a tampered local pin (not on the base branch).
 */
export function pinHealthWarnings(projectDir: string): string[] {
  const warnings: string[] = [];
  let local: { pin: ActivePin; source: PinSource } | { pin: null; source: null };
  try {
    local = readActivePinWithSource(projectDir);
  } catch (err) {
    warnings.push(`WARNING: ${err instanceof Error ? err.message : String(err)}`);
    return warnings;
  }
  if (!local.pin) {
    try {
      const originPin = originTrackedPin(projectDir);
      if (originPin) {
        const base = configuredBaseBranch(projectDir);
        warnings.push(
          `WARNING: origin/${base} has ${TRACKED_PIN_PATH} at ${originPin.commit.slice(0, 7)}; this clone has no local pin. ` +
            `Keeping the last good local pin (working tree); not auto-switching. git pull to take the shared pin.`,
        );
      }
    } catch {
      // no git / no origin
    }
    return warnings;
  }
  if (local.source === "legacy") warnings.push(LEGACY_PIN_MIGRATION);

  try {
    const base = configuredBaseBranch(projectDir);
    if (!pinCommitOnBase(projectDir, local.pin.commit, base)) {
      warnings.push(
        `WARNING: pinned commit ${local.pin.commit} is not on "${base}". Keeping the last good local pin; not auto-switching.`,
      );
    }

    const originPin = originTrackedPin(projectDir);
    if (originPin) {
      const originOnBase = pinCommitOnBase(projectDir, originPin.commit, base);
      if (!originOnBase) {
        warnings.push(
          `WARNING: origin/${base} ${TRACKED_PIN_PATH} commit ${originPin.commit} is not on "${base}". ` +
            `Keeping the last good local pin; not auto-switching.`,
        );
      }
      if (
        originPin.commit.toLowerCase() !== local.pin.commit.toLowerCase() ||
        originPin.approved_by !== local.pin.approved_by
      ) {
        warnings.push(
          `WARNING: local pin ${local.pin.commit.slice(0, 7)} (${local.pin.approved_by}) differs from origin/${base} ` +
            `${originPin.commit.slice(0, 7)} (${originPin.approved_by}, ${TRACKED_PIN_PATH}). ` +
            `Keeping the last good local pin; not auto-switching.`,
        );
      }
    }
  } catch (err) {
    warnings.push(`WARNING: ${err instanceof Error ? err.message : String(err)}`);
  }
  return warnings;
}

/** Load + structural-validate YAML at `commit`. Refuse before any pin write. */
export function assertPinnableYaml(projectDir: string, commit: string): void {
  const dir = findProjectDir(projectDir);
  let yamlContents: Record<string, string>;
  try {
    yamlContents = yamlContentsAtCommit(dir, commit);
  } catch (err) {
    throw configError(
      `Refusing to pin invalid YAML at ${commit}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!yamlContents["grane.yml"] && !yamlContents["grane.yaml"]) {
    throw configError(`Refusing to pin invalid YAML at ${commit}: no grane.yml.`);
  }
  let loaded: LoadedConfig;
  try {
    loaded = loadConfig(dir, { yamlContents });
  } catch (err) {
    throw configError(
      `Refusing to pin invalid YAML at ${commit}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const report = validateModel(new SemanticModel(loaded.config));
  const errors = [...report.issues, ...report.metrics.flatMap((metric) => metric.issues)].filter(
    (issue) => issue.severity === "error",
  );
  if (!report.ok || errors.length > 0) {
    const detail = errors.map((issue) => `${issue.code}: ${issue.message}`).join("; ") || "validation failed";
    throw configError(`Refusing to pin invalid YAML at ${commit}: ${detail}`);
  }
}

/**
 * Config `grane serve` loads. No pin: identical to `loadConfig` (working tree).
 * Tracked pin wins; otherwise the legacy local pin (with a migration warning).
 * Origin's pin is compared for warnings only — never auto-switched.
 * Malformed, missing-commit, or tampered local pins fail closed.
 */
export function loadServingConfig(
  projectDir: string,
): LoadedConfig & { pin: ActivePin | null; pin_source: PinSource | null; pin_warnings: string[] } {
  const dir = findProjectDir(projectDir);
  let local: { pin: ActivePin; source: PinSource } | { pin: null; source: null };
  try {
    local = readActivePinWithSource(dir);
  } catch (err) {
    recordPinEvent(dir, {
      operation: "refuse",
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  if (!local.pin) {
    return { ...loadConfig(dir), pin: null, pin_source: null, pin_warnings: pinHealthWarnings(dir) };
  }
  const label = pinLabel(local.source);
  try {
    const resolved = assertServablePin(dir, local.pin, label);
    const yamlContents = yamlContentsAtCommit(dir, resolved.commit);
    if (!yamlContents["grane.yml"] && !yamlContents["grane.yaml"]) {
      throw configError(
        `Pinned commit ${resolved.commit} has no grane.yml. Serve refuses to start. Fix ${label}.`,
      );
    }
    const loaded = loadConfig(dir, { yamlContents });
    const next = { ...local.pin, ref: resolved.ref, commit: resolved.commit };
    const pin_warnings = pinHealthWarnings(dir);
    recordPinEvent(
      dir,
      { operation: "load", ref: next.ref, commit: next.commit, approved_by: next.approved_by },
      loaded.config,
    );
    return { ...loaded, pin: next, pin_source: local.source, pin_warnings };
  } catch (err) {
    recordPinEvent(dir, {
      operation: "refuse",
      ref: local.pin.ref,
      commit: local.pin.commit,
      approved_by: local.pin.approved_by,
      reason: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

function resolveCommit(root: string, rev: string): string {
  const probe = runGit(root, ["rev-parse", "--verify", `${rev}^{commit}`], { allowFail: true });
  if (probe.status !== 0) {
    throw configError(`"${rev}" is not a commit in this repository.`);
  }
  return probe.stdout.trim();
}

function previouslyApprovedCommits(root: string, pin: ActivePin | null): Set<string> {
  const out = new Set<string>();
  if (!pin) return out;
  for (const rev of [pin.commit, pin.previous_commit]) {
    if (!rev) continue;
    const probe = runGit(root, ["rev-parse", "--verify", `${rev}^{commit}`], { allowFail: true });
    if (probe.status === 0) out.add(probe.stdout.trim());
  }
  return out;
}

/**
 * The pin ref is the GitHub PR base, never a proposal branch. On the first pin it
 * must match `configuredBaseBranch()` (not HEAD); afterwards it must keep the existing pin's ref.
 */
function assertPinRef(projectDir: string, requested: string): string {
  const ref = normalizeBranchRef(requested);
  if (ref.startsWith(PROPOSAL_BRANCH_PREFIX) || ref === PROPOSAL_BRANCH_PREFIX) {
    throw configError(
      `Refusing to pin against "${requested}". The active pin cannot use a ${PROPOSAL_BRANCH_PREFIX}* proposal branch. ` +
        `Pin the GitHub PR base after the PR is merged.`,
    );
  }
  const existing = readActivePin(projectDir);
  if (existing && (normalizeBranchRef(existing.ref).startsWith(PROPOSAL_BRANCH_PREFIX) || existing.ref === PROPOSAL_BRANCH_PREFIX)) {
    throw configError(
      `Existing pin ref "${existing.ref}" is a proposal branch and cannot be used. Delete ${ACTIVE_PIN_PATH} and pin the GitHub PR base.`,
    );
  }
  const expected = configuredBaseBranch(projectDir);
  if (existing) {
    const existingRef = normalizeBranchRef(existing.ref);
    if (existingRef !== expected && existing.ref !== `refs/heads/${expected}`) {
      throw configError(
        `Existing pin ref "${existing.ref}" is not the configured base branch "${expected}". ` +
          `The pin looks tampered. Fix ${ACTIVE_PIN_PATH}.`,
      );
    }
  }
  if (ref !== expected) {
    throw configError(
      `Refusing to pin against "${requested}". The pin ref must be "${expected}" (the approved/active base branch, not HEAD).`,
    );
  }
  return expected;
}

/** A pin may only record commits on `ref`'s history, or a SHA this pin already approved. */
function assertPinnableCommit(root: string, rev: string, ref: string, approved: Set<string>, label: string): string {
  const commit = resolveCommit(root, rev);
  resolveCommit(root, ref);
  if (approved.has(commit) || isAncestor(root, commit, ref)) return commit;
  throw configError(
    `Refusing to pin ${label} ${commit}: it is not reachable from "${ref}" and is not a previously approved commit. ` +
      `Only merged commits on the active line can be pinned. Merge the GitHub PR before pinning a proposal.`,
  );
}

export function writeActivePin(projectDir: string, pin: ActivePin): ActivePin {
  assertNotDemoAuthoring(projectDir, "write the active pin");
  const parsed = activePinSchema.parse(pin);
  const ref = assertPinRef(projectDir, parsed.ref);
  const root = gitRoot(projectDir);
  const approved = previouslyApprovedCommits(root, readActivePin(projectDir));
  const commit = assertPinnableCommit(root, parsed.commit, ref, approved, "commit");
  const previous_commit = parsed.previous_commit
    ? assertPinnableCommit(root, parsed.previous_commit, ref, approved, "previous_commit")
    : parsed.previous_commit;
  const next = { ...parsed, ref, commit, previous_commit };
  assertServablePin(projectDir, next);
  const audit = pinAuditConfig(projectDir);
  preflightAuditWrite(audit.config, audit.dir);
  assertRegularGraneDir(projectDir);
  const path = join(projectDir, ACTIVE_PIN_PATH);
  assertRegularPinFile(path, ACTIVE_PIN_PATH);
  const previous = existsSync(path) ? readFileSync(path) : null;
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify(next, null, 2)}\n`);
  try {
    recordPinEvent(
      projectDir,
      {
        operation: "write",
        ref: next.ref,
        commit: next.commit,
        approved_by: next.approved_by,
      },
      audit.config,
    );
  } catch (err) {
    if (previous === null) rmSync(path, { force: true });
    else atomicWriteFile(path, previous);
    throw err;
  }
  return next;
}

function atomicWriteFile(path: string, contents: string | Buffer): void {
  const tmpPath = join(dirname(path), `.active-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`);
  try {
    writeFileSync(tmpPath, contents);
    renameSync(tmpPath, path);
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

export interface ActiveRef {
  branch: string;
  commit: string;
  pinned: boolean;
}

export function resolveActiveRef(projectDir: string): ActiveRef {
  const root = gitRoot(projectDir);
  const pin = readActivePin(projectDir);
  const branch = configuredBaseBranch(projectDir);
  if (branch.startsWith(PROPOSAL_BRANCH_PREFIX)) {
    throw configError(
      `Active ref is proposal branch "${branch}". Check out the base branch (the GitHub PR base) first. ` +
        `Grane never writes proposals onto another proposal or the active branch.`,
    );
  }
  const commit = pin?.commit ?? git(root, ["rev-parse", `${branch}^{commit}`]).trim();
  const verify = runGit(root, ["rev-parse", "--verify", `${commit}^{commit}`], { allowFail: true });
  if (verify.status !== 0) {
    throw configError(`Active commit "${commit}" is not in this repository.`);
  }
  return { branch, commit: verify.stdout.trim(), pinned: Boolean(pin) };
}

function identity(root: string): { name: string; email: string } {
  const name = git(root, ["config", "--get", "user.name"], { allowFail: true }).trim();
  const email = git(root, ["config", "--get", "user.email"], { allowFail: true }).trim();
  if (!name || !email) {
    throw configError(
      `git user.name and user.email must be set so proposal commits are attributed. ` +
        `Run: git config user.name "Your Name" && git config user.email "you@example.com"`,
    );
  }
  return { name, email };
}

function commitOnProposalBranch(
  root: string,
  branch: string,
  parent: string,
  files: Record<string, string>,
  message: string,
): string {
  requireProposalBranch(branch);
  return commitOnSideBranch(root, branch, parent, files, message);
}

function commitOnPinBranch(
  root: string,
  branch: string,
  parent: string,
  files: Record<string, string>,
  message: string,
): string {
  requirePinBranch(branch);
  const exists = runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true });
  if (exists.status === 0) {
    throw configError(
      `Pin branch "${branch}" already exists. Competing approvals must open separate PRs; Grane will not overwrite it.`,
    );
  }
  return commitOnSideBranch(root, branch, parent, files, message);
}

function commitOnSideBranch(
  root: string,
  branch: string,
  parent: string,
  files: Record<string, string>,
  message: string,
): string {
  if (
    !(
      (branch.startsWith(PROPOSAL_BRANCH_PREFIX) && branch !== PROPOSAL_BRANCH_PREFIX) ||
      (branch.startsWith(PIN_BRANCH_PREFIX) && branch !== PIN_BRANCH_PREFIX)
    )
  ) {
    throw configError(
      `Refusing to write to "${branch}". Grane only creates commits on ${PROPOSAL_BRANCH_PREFIX}* or ${PIN_BRANCH_PREFIX}* — never on the active branch.`,
    );
  }
  const { name, email } = identity(root);
  const indexFile = join(root, ".git", `grane-proposal-index-${process.pid}-${Date.now()}`);
  const env = { GIT_INDEX_FILE: indexFile, GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
  try {
    git(root, ["read-tree", parent], { env });
    for (const [path, contents] of Object.entries(files)) {
      const blob = git(root, ["hash-object", "-w", "--stdin"], { env, input: contents }).trim();
      git(root, ["update-index", "--add", "--cacheinfo", "100644", blob, path], { env });
    }
    const tree = git(root, ["write-tree"], { env }).trim();
    const commit = git(root, ["commit-tree", tree, "-p", parent, "-F", "-"], { env, input: `${message}\n` }).trim();
    git(root, ["update-ref", `refs/heads/${branch}`, commit]);
    return commit;
  } finally {
    rmSync(indexFile, { force: true });
  }
}

function formatRestoredTrailer(restored: SemanticYamlRestored): string | undefined {
  const parts = SEMANTIC_YAML_KEYS
    .filter((key) => restored[key].length > 0)
    .map((key) => `${key}=${restored[key].join(",")}`);
  return parts.length > 0 ? parts.join(";") : undefined;
}

function parseRestoredTrailer(raw: string | undefined): SemanticYamlRestored {
  const restored = emptyRestored();
  if (!raw) return restored;
  for (const part of raw.split(";")) {
    const [key, names] = part.split("=");
    if (!key || !names || !(SEMANTIC_YAML_KEYS as readonly string[]).includes(key)) continue;
    restored[key as keyof SemanticYamlRestored] = names
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
  }
  return restored;
}

function proposalMessage(
  id: string,
  title: string,
  baseBranch: string,
  baseCommit: string,
  body?: string,
  merge?: { restored: SemanticYamlRestored; lost_comments: string[] },
): string {
  const subject = body ?? `feat(authoring): propose ${id}`;
  const lines = [
    subject.split("\n")[0],
    "",
    title,
    "",
    `Grane-Proposal: ${id}`,
    `Grane-Base: ${baseBranch}`,
    `Grane-Base-Commit: ${baseCommit}`,
  ];
  const restored = merge ? formatRestoredTrailer(merge.restored) : undefined;
  if (restored) lines.push(`Grane-Merge-Restored: ${restored}`);
  if (merge?.lost_comments.length) lines.push(`Grane-Lost-Comments: ${merge.lost_comments.join(",")}`);
  lines.push(
    "",
    "AI-generated metrics in this proposal are experimental until the GitHub PR is merged.",
    "Merging (anyone with merge rights) marks them governed.",
  );
  return lines.join("\n");
}

function parseTrailer(message: string, key: string): string | undefined {
  const match = message.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

/** Create `grane/proposal/<yyyymmdd>-<slug>` and commit `files` on it. Never updates HEAD. */
export function createProposal(projectDir: string, input: CreateProposalInput): Proposal {
  const audit = pinAuditConfig(projectDir);
  preflightAuditWrite(audit.config, audit.dir);
  const root = gitRoot(projectDir);
  assertCleanWorktree(projectDir);
  const active = resolveActiveRef(projectDir);
  const id = `${yyyymmdd(input.at ?? new Date())}-${slugify(input.slug)}`;
  const branch = `${PROPOSAL_BRANCH_PREFIX}${id}`;
  requireProposalBranch(branch);
  const exists = runGit(root, ["rev-parse", "--verify", `refs/heads/${branch}`], { allowFail: true });
  if (exists.status === 0) {
    throw configError(`Proposal branch "${branch}" already exists. Choose a different slug.`);
  }
  const entries = Object.entries(input.files);
  if (entries.length === 0) {
    throw configError("Proposal has no draft files to commit.");
  }
  const staged: Record<string, string> = {};
  const mergeRestored = emptyRestored();
  const lostComments: string[] = [];
  for (const [rel, contents] of entries) {
    const path = gitPath(root, projectDir, rel);
    const report = combineSemanticYamlWithReport(fileAtCommit(root, active.commit, path), contents, rel);
    staged[path] = report.contents;
    for (const key of SEMANTIC_YAML_KEYS) {
      mergeRestored[key] = [...new Set([...mergeRestored[key], ...report.restored[key]])].sort();
    }
    if (report.lost_comments) lostComments.push(path);
  }
  const title = input.title?.trim() || `Grane proposal: ${id}`;
  const headBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const activeBefore = git(root, ["rev-parse", active.branch]).trim();
  const commit = commitOnProposalBranch(
    root,
    branch,
    active.commit,
    staged,
    proposalMessage(id, title, active.branch, active.commit, input.message, {
      restored: mergeRestored,
      lost_comments: lostComments,
    }),
  );
  const headAfter = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const activeAfter = git(root, ["rev-parse", active.branch]).trim();
  if (headAfter !== headBefore || activeAfter !== activeBefore) {
    throw configError(
      `Internal error: creating proposal "${branch}" would have moved the active branch. Refusing.`,
    );
  }
  return { id, branch, commit, base_branch: active.branch, base_commit: active.commit, title };
}

function loadCommitMaps(
  root: string,
  commit: string,
): {
  metrics: Record<string, unknown>;
  dimensions: Record<string, unknown>;
  relationships: Record<string, unknown>;
  entities: Record<string, unknown>;
} {
  const dest = mkdtempSync(join(tmpdir(), "grane-proposal-tree-"));
  try {
    const names = git(root, ["ls-tree", "-r", "--name-only", commit])
      .split("\n")
      .map((name) => name.trim())
      .filter((name) => /\.ya?ml$/i.test(name));
    for (const name of names) {
      const contents = git(root, ["show", `${commit}:${name}`]);
      const path = join(dest, name);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    const loaded = loadConfig(dest);
    return {
      metrics: loaded.config.metrics,
      dimensions: loaded.config.dimensions,
      relationships: loaded.config.relationships,
      entities: loaded.config.entities,
    };
  } finally {
    rmSync(dest, { recursive: true, force: true });
  }
}

function nameDiff(before: Record<string, unknown>, after: Record<string, unknown>): NameDiff {
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  for (const name of Object.keys(after).sort()) {
    if (!(name in before)) added.push(name);
    else if (JSON.stringify(before[name]) !== JSON.stringify(after[name])) changed.push(name);
  }
  for (const name of Object.keys(before).sort()) {
    if (!(name in after)) removed.push(name);
  }
  return { added, changed, removed };
}

function yamlCommentLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("#") || /(?:^|\s)#.+$/.test(line));
}

function lostCommentFiles(root: string, baseCommit: string, proposalCommit: string, files: string[]): string[] {
  const lost: string[] = [];
  for (const file of files) {
    const before = runGit(root, ["show", `${baseCommit}:${file}`], { allowFail: true });
    const after = runGit(root, ["show", `${proposalCommit}:${file}`], { allowFail: true });
    if (before.status !== 0 || after.status !== 0) continue;
    const kept = new Set(yamlCommentLines(after.stdout));
    if (yamlCommentLines(before.stdout).some((line) => !kept.has(line))) lost.push(file);
  }
  return lost;
}

export function diffProposal(projectDir: string, idOrBranch: string): ProposalDiff {
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  const active = resolveActiveRef(projectDir);
  const proposal = git(root, ["rev-parse", branch]).trim();
  const unified = git(root, ["diff", "--no-color", "--no-ext-diff", active.commit, proposal]);
  const files = git(root, ["diff", "--name-only", "--no-color", active.commit, proposal])
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  try {
    const before = loadCommitMaps(root, active.commit);
    const after = loadCommitMaps(root, proposal);
    const message = git(root, ["log", "-1", "--format=%B", proposal]);
    const trailerLost = (parseTrailer(message, "Grane-Lost-Comments") ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean);
    const lost_comments = [...new Set([...trailerLost, ...lostCommentFiles(root, active.commit, proposal, files)])].sort();
    return {
      unified,
      files,
      semantic: {
        metrics: nameDiff(before.metrics, after.metrics),
        dimensions: nameDiff(before.dimensions, after.dimensions),
        relationships: nameDiff(before.relationships, after.relationships),
        entities: nameDiff(before.entities, after.entities),
        merge: {
          restored: parseRestoredTrailer(parseTrailer(message, "Grane-Merge-Restored")),
          lost_comments,
        },
      },
    };
  } catch (err) {
    return { unified, files, semantic: null, semantic_error: (err as Error).message };
  }
}

function readProposal(root: string, branch: string): Proposal {
  const commit = git(root, ["rev-parse", branch]).trim();
  const message = git(root, ["log", "-1", "--format=%B", commit]);
  const id = proposalIdFromBranch(branch);
  const base_branch = parseTrailer(message, "Grane-Base") ?? "";
  const base_commit = parseTrailer(message, "Grane-Base-Commit") ?? "";
  const subject = message.split("\n")[0] ?? branch;
  return { id, branch, commit, base_branch, base_commit, title: subject };
}

export function listProposals(projectDir: string): Proposal[] {
  const root = gitRoot(projectDir);
  const raw = git(root, [
    "for-each-ref",
    "--sort=-committerdate",
    "--format=%(refname:short)",
    `refs/heads/${PROPOSAL_BRANCH_PREFIX}`,
  ]);
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .map((branch) => branch.trim())
    .filter(Boolean)
    .map((branch) => readProposal(root, branch));
}

/** `owner/repo` from a GitHub remote URL, or null for GitLab / SSH hosts that are not github.com. */
export function parseGithubOrigin(url: string): string | null {
  const match = url.trim().match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?\/?$/i);
  if (!match?.groups) return null;
  return `${match.groups.owner}/${match.groups.repo}`;
}

export function githubRepoFromOrigin(root: string): string | null {
  const url = git(root, ["remote", "get-url", "origin"], { allowFail: true }).trim();
  if (!url) return null;
  return parseGithubOrigin(url);
}

function formatGhPrCreate(plan: { base: string; head: string; title: string; body: string }): string {
  return ["gh", "pr", "create", "--base", plan.base, "--head", plan.head, "--title", plan.title, "--body", plan.body]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
}

export function githubPrPlan(projectDir: string, idOrBranch: string): GitHubPrPlan {
  const root = gitRoot(projectDir);
  const proposal = readProposal(root, resolveProposalBranch(root, idOrBranch));
  const active = resolveActiveRef(projectDir);
  const title = `Grane proposal: ${proposal.id}`;
  const body = [
    `Proposal \`${proposal.id}\` on \`${proposal.branch}\`.`,
    "",
    "Approval is merging this GitHub PR. Anyone with merge rights on the repository can merge it.",
    "AI-generated metrics in this PR are **experimental** until merge; the merge marks them **governed**.",
    "",
    `Grane-Proposal: ${proposal.id}`,
    `Grane-Base: ${active.branch}`,
    `Grane-Base-Commit: ${active.commit}`,
  ].join("\n");
  return {
    title,
    body,
    head: proposal.branch,
    base: active.branch,
    repo: githubRepoFromOrigin(root),
    command: formatGhPrCreate({ base: active.branch, head: proposal.branch, title, body }),
  };
}

export function githubPinPrPlan(projectDir: string, pinBranch: string, pin: ActivePin): GitHubPrPlan {
  requirePinBranch(pinBranch);
  const root = gitRoot(projectDir);
  const base = configuredBaseBranch(projectDir);
  const title = `Pin approved version ${pin.commit.slice(0, 7)}`;
  const body = [
    `Commit \`${TRACKED_PIN_PATH}\` so every clone serves the same approved version.`,
    "",
    `- ref: \`${pin.ref}\``,
    `- commit: \`${pin.commit}\``,
    `- approved_by: ${pin.approved_by}`,
    pin.proposal ? `- proposal: \`${pin.proposal}\`` : "",
    "",
    "Grane does not merge or push this PR. A human with merge rights merges it onto the base branch.",
    "MCP tools cannot approve or pin.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return {
    title,
    body,
    head: pinBranch,
    base,
    repo: githubRepoFromOrigin(root),
    command: formatGhPrCreate({ base, head: pinBranch, title, body }),
  };
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true }).status === 0;
}

/** First-parent SHAs of `tip`, newest first. */
function firstParentHistory(root: string, tip: string): string[] {
  const raw = git(root, ["log", "--first-parent", "--format=%H", tip], { allowFail: true }).trim();
  return raw ? raw.split("\n").filter((line) => FULL_SHA.test(line)) : [];
}

/** Serving YAML at `commit` (metrics + the other project YAML `loadConfig` merges). */
export function projectYamlFingerprint(projectDir: string, commit: string): string {
  const contents = yamlContentsAtCommit(projectDir, commit);
  return Object.keys(contents)
    .sort()
    .map((name) => `${name}\n${contents[name]}`)
    .join("\n\u001e\n");
}

/**
 * Commit on `tip`'s first-parent history to pin for this proposal.
 * Merge/FF: the merge commit (or the proposal itself) — not later tips.
 * Squash/rebase: the oldest first-parent commit whose project YAML matches
 * the proposal. Returns null if nothing matches (caller must refuse; never
 * pin the moving tip).
 */
export function resolveProposalMergedCommit(
  projectDir: string,
  proposalCommit: string,
  tip: string,
): string | null {
  const root = gitRoot(projectDir);
  const proposal = resolveCommit(root, proposalCommit);
  const tipSha = resolveCommit(root, tip);
  const history = firstParentHistory(root, tipSha);
  if (history.length === 0) return null;

  if (isAncestor(root, proposal, tipSha)) {
    let found: string | null = null;
    for (const sha of history) {
      if (isAncestor(root, proposal, sha)) found = sha;
      else break;
    }
    if (found && isAncestor(root, found, tipSha)) return found;
    return null;
  }

  const wanted = projectYamlFingerprint(projectDir, proposal);
  let found: string | null = null;
  const mergeBaseProbe = runGit(root, ["merge-base", proposal, tipSha], { allowFail: true });
  const mergeBase = mergeBaseProbe.status === 0 ? mergeBaseProbe.stdout.trim() || null : null;
  for (const sha of history) {
    if (mergeBase && sha === mergeBase) break;
    if (projectYamlFingerprint(projectDir, sha) === wanted) {
      found = sha;
      continue;
    }
    if (found) break;
  }
  if (found && isAncestor(root, found, tipSha)) return found;
  return null;
}

export function pinCommitUnmatchedMessage(approval: {
  proposal_id: string;
  proposal_commit: string;
  base_branch: string;
}): string {
  return (
    `Merge the GitHub PR for "${approval.proposal_id}" before approving. ` +
    `Proposal commit ${approval.proposal_commit} is not on "${approval.base_branch}" ` +
    `(squash and rebase merges rewrite the commit). ` +
    `No commit on "${approval.base_branch}" has metric YAML matching the proposal. ` +
    `Refusing to pin — will not silently pin the ${approval.base_branch} tip. ` +
    `Approve pins the proposal's merged commit; it does not merge. ` +
    `Merge, squash, or rebase the proposal onto ${approval.base_branch} so its YAML is reachable from that branch, then retry.`
  );
}

/** When origin/<base> exists, merge detection uses that tip — not a local-only rewrite. */
function originBaseTip(root: string, base_branch: string): string | null {
  const probe = runGit(root, ["rev-parse", "--verify", `refs/remotes/origin/${base_branch}^{commit}`], {
    allowFail: true,
  });
  if (probe.status !== 0) return null;
  const sha = probe.stdout.trim();
  return sha || null;
}

function escapeExtendedRegexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Exact line `Grane-Proposal: <id>` — not a prefix/substring match. */
function findExactProposalTrailer(root: string, baseCommit: string, proposalId: string): string {
  const pattern = `^Grane-Proposal: ${escapeExtendedRegexp(proposalId)}$`;
  return git(
    root,
    ["log", baseCommit, "--format=%H", "--extended-regexp", "--grep", pattern, "-n", "1"],
    { allowFail: true },
  ).trim();
}

/**
 * Read whether a proposal has been merged into the active branch.
 * Does not merge, fast-forward, or otherwise write to the active branch.
 * The proposal id always comes from the branch name, never from the commit trailer.
 * `merge_commit` is the proposal's merged commit on the base (merge / FF /
 * squash / rebase YAML match), never the moving tip after later commits.
 */
export function readMergedApproval(
  projectDir: string,
  idOrBranch: string,
  options: { against?: "active" | "base" } = {},
): MergedApproval {
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  const proposal_id = proposalIdFromBranch(branch);
  const proposal_commit = git(root, ["rev-parse", branch]).trim();
  const against = options.against ?? "active";
  const base_branch = against === "base" ? configuredBaseBranch(projectDir) : resolveActiveRef(projectDir).branch;
  const tip =
    against === "base"
      ? originBaseTip(root, base_branch) ?? git(root, ["rev-parse", `refs/heads/${base_branch}`]).trim()
      : resolveActiveRef(projectDir).commit;
  // Trailer-only "merges" (forged Grane-Proposal on an empty commit) are not
  // merged. Merge/FF requires the proposal commit on the base; squash/rebase
  // requires a base commit whose metric YAML matches. Never pin the tip.
  const merge_commit = resolveProposalMergedCommit(projectDir, proposal_commit, tip);
  const merged = merge_commit !== null;
  return {
    merged,
    proposal_id,
    proposal_branch: branch,
    proposal_commit,
    base_branch,
    merge_commit,
    metric_trust: merged ? "governed" : "experimental",
  };
}

function baseHeadsSha(root: string, projectDir: string): string {
  const base = configuredBaseBranch(projectDir);
  return git(root, ["rev-parse", `refs/heads/${base}`]).trim();
}

function recordProposalLine(
  projectDir: string,
  input: { operation: "list" | "diff" | "approve" | "reject" | "rollback"; proposal_id?: string; branch?: string; commit?: string; reason?: string },
): void {
  const audit = pinAuditConfig(projectDir);
  recordProposalAudit(audit.config, audit.dir, input);
}

/** Delete `refs/heads/grane/proposal/*` only. Never touches the configured base. */
export function deleteProposalBranch(projectDir: string, idOrBranch: string): string {
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  const mainBefore = baseHeadsSha(root, projectDir);
  git(root, ["update-ref", "-d", `refs/heads/${branch}`]);
  const mainAfter = baseHeadsSha(root, projectDir);
  if (mainAfter !== mainBefore) {
    throw configError("Internal error: deleting a proposal branch moved the configured base. Refusing.");
  }
  return branch;
}

export function listProposalsAction(projectDir: string): Proposal[] {
  const listed = listProposals(projectDir);
  recordProposalLine(projectDir, { operation: "list" });
  return listed;
}

export function diffProposalAction(projectDir: string, idOrBranch: string): ProposalDiff {
  const diff = diffProposal(projectDir, idOrBranch);
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  recordProposalLine(projectDir, {
    operation: "diff",
    proposal_id: proposalIdFromBranch(branch),
    branch,
  });
  return diff;
}

/**
 * Pin the proposal's merged commit on the configured base (not the moving
 * tip). Validates YAML first (refuse before writing anything if invalid).
 * Writes the last-good local pin, then commits `grane.pin.json` on a
 * `grane/pin/*` branch and returns a `gh pr create` plan. Never merges,
 * fast-forwards, pushes, or moves the configured base. Squash/rebase
 * matches metric YAML on the base; no match → refuse, never pin silently.
 */
export function approveProposal(
  projectDir: string,
  idOrBranch: string,
  options: { tty?: boolean; approved_by?: string; at?: Date } = {},
): ApproveResult {
  assertNotDemoAuthoring(projectDir, "approve");
  const approval = readMergedApproval(projectDir, idOrBranch, { against: "base" });
  if (!approval.merged || !approval.merge_commit) {
    const unmatched = pinCommitUnmatchedMessage(approval);
    const reason = options.tty
      ? unmatched
      : `approve requires a human TTY or a merged GitHub PR. ${unmatched}`;
    recordProposalLine(projectDir, {
      operation: "approve",
      proposal_id: approval.proposal_id,
      branch: approval.proposal_branch,
      reason,
    });
    throw configError(reason);
  }
  const root = gitRoot(projectDir);
  const mainBefore = baseHeadsSha(root, projectDir);
  const headBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  assertPinnableYaml(projectDir, approval.merge_commit);
  if (baseHeadsSha(root, projectDir) !== mainBefore) {
    throw configError("Internal error: YAML validation moved the configured base branch. Refusing.");
  }

  const existing = readActivePin(projectDir);
  const previous =
    existing && existing.commit !== approval.merge_commit
      ? existing.commit
      : (existing?.previous_commit ?? null);
  const legacyPath = join(projectDir, ACTIVE_PIN_PATH);
  const previousLegacy = existsSync(legacyPath) ? readFileSync(legacyPath) : null;
  const pin = writeActivePin(projectDir, {
    ref: configuredBaseBranch(projectDir),
    commit: approval.merge_commit,
    approved_by: options.approved_by ?? identity(root).name,
    approved_at: (options.at ?? new Date()).toISOString(),
    proposal: approval.proposal_id,
    previous_commit: previous,
  });
  let published: ApproveResult;
  try {
    published = commitTrackedPinPlan(projectDir, root, pin, {
      at: options.at,
      verb: "approve",
    });
  } catch (err) {
    if (previousLegacy === null) rmSync(legacyPath, { force: true });
    else atomicWriteFile(legacyPath, previousLegacy);
    throw err;
  }
  recordProposalLine(projectDir, {
    operation: "approve",
    proposal_id: approval.proposal_id,
    branch: approval.proposal_branch,
    commit: published.commit,
  });
  const mainAfter = baseHeadsSha(root, projectDir);
  const headAfter = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (mainAfter !== mainBefore || headAfter !== headBefore) {
    throw configError("Internal error: approve moved the configured base branch. Refusing.");
  }
  return published;
}

export function isTrackedPinPlan(value: ActivePin | ApproveResult): value is ApproveResult {
  return "pin_branch" in value && "github" in value;
}

function commitTrackedPinPlan(
  projectDir: string,
  root: string,
  pin: ActivePin,
  options: { at?: Date; verb: "approve" | "rollback"; parent?: string },
): ApproveResult {
  const stamp = yyyymmdd(options.at ?? new Date());
  const suffix = options.verb === "rollback" ? "-rollback" : "";
  const pin_branch = `${PIN_BRANCH_PREFIX}${stamp}-${pin.commit.slice(0, 12)}-${slugify(pin.approved_by)}${suffix}`;
  commitOnPinBranch(
    root,
    pin_branch,
    options.parent ?? pin.commit,
    { [TRACKED_PIN_PATH]: `${JSON.stringify(pin, null, 2)}\n` },
    [
      `chore(pin): ${options.verb} ${pin.commit.slice(0, 7)}`,
      "",
      `Grane-Pin: ${TRACKED_PIN_PATH}`,
      `Grane-Pin-Commit: ${pin.commit}`,
      `Grane-Base: ${pin.ref}`,
      pin.proposal ? `Grane-Proposal: ${pin.proposal}` : "",
      "",
      "This branch only adds the tracked pin. It must not be merged by Grane.",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return {
    ...pin,
    pin_branch,
    pin_file: TRACKED_PIN_PATH,
    github: githubPinPrPlan(projectDir, pin_branch, pin),
  };
}

/** Delete a proposal branch. Never writes the pin or the configured base. */
export function rejectProposal(
  projectDir: string,
  idOrBranch: string,
  options: { tty?: boolean; yes?: boolean; confirm?: () => boolean } = {},
): { id: string; branch: string; commit: string } {
  assertNotDemoAuthoring(projectDir, "reject");
  if (!options.yes) {
    if (!options.tty) {
      const reason = `reject requires a human TTY or --yes.`;
      recordProposalLine(projectDir, { operation: "reject", reason });
      throw configError(reason);
    }
    const confirmed = options.confirm ? options.confirm() : false;
    if (!confirmed) {
      const reason = options.confirm
        ? `reject cancelled.`
        : `reject requires confirmation (y/N) or --yes.`;
      recordProposalLine(projectDir, { operation: "reject", reason });
      throw configError(reason);
    }
  }
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  const id = proposalIdFromBranch(branch);
  const commit = git(root, ["rev-parse", branch]).trim();
  const audit = pinAuditConfig(projectDir);
  preflightAuditWrite(audit.config, audit.dir);
  const mainBefore = baseHeadsSha(root, projectDir);
  deleteProposalBranch(projectDir, branch);
  try {
    recordProposalLine(projectDir, { operation: "reject", proposal_id: id, branch, commit });
  } catch (err) {
    restoreProposalRef(root, branch, commit);
    throw err;
  }
  const mainAfter = baseHeadsSha(root, projectDir);
  if (mainAfter !== mainBefore) {
    restoreProposalRef(root, branch, commit);
    throw configError("Internal error: reject moved the configured base branch. Refusing.");
  }
  return { id, branch, commit };
}

function restoreProposalRef(root: string, branch: string, sha: string): void {
  requireProposalBranch(branch);
  runGit(root, ["update-ref", `refs/heads/${branch}`, sha], { allowFail: true });
}

/**
 * Re-pin a previously approved commit. Never resets, pushes, or commits on
 * the active branch. When a tracked `grane.pin.json` exists, last-good local
 * is not enough (tracked wins on serve) — prepare a `grane/pin/*` branch
 * like approve, or refuse. Never pin silently.
 */
export function rollbackPin(
  projectDir: string,
  options: { to?: string; approved_by?: string; at?: Date } = {},
): ActivePin | ApproveResult {
  assertNotDemoAuthoring(projectDir, "rollback");
  gitRoot(projectDir);
  const pin = readActivePin(projectDir);
  if (!pin) {
    const reason = `Nothing to roll back: ${ACTIVE_PIN_PATH} does not exist. After a GitHub PR merge, pin that commit first.`;
    recordProposalLine(projectDir, { operation: "rollback", reason });
    throw configError(reason);
  }
  const ref = assertPinRef(projectDir, pin.ref);
  const target = options.to ?? pin.previous_commit ?? undefined;
  if (!target) {
    const reason =
      `No previous approved commit on the pin. Pass to: "<commit>" of a previously merged proposal. ` +
      `Rollback re-pins; it does not rewrite git history or move the active branch.`;
    recordProposalLine(projectDir, { operation: "rollback", reason });
    throw configError(reason);
  }
  const root = gitRoot(projectDir);
  const resolved = resolveCommit(root, target);
  if (resolved === pin.commit) {
    const reason = `Already pinned at ${resolved}.`;
    recordProposalLine(projectDir, { operation: "rollback", reason, commit: resolved });
    throw configError(reason);
  }
  const approved = previouslyApprovedCommits(root, pin);
  if (!approved.has(resolved)) {
    const reason =
      `Refusing to roll back to ${resolved}: it is not a previously approved pin. ` +
      `Pass --to of a commit recorded on the current pin (commit or previous_commit).`;
    recordProposalLine(projectDir, { operation: "rollback", reason, commit: resolved });
    throw configError(reason);
  }
  const mainBefore = baseHeadsSha(root, projectDir);
  const headBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const tracked = readTrackedPin(projectDir);
  const legacyPath = join(projectDir, ACTIVE_PIN_PATH);
  const previousLegacy = existsSync(legacyPath) ? readFileSync(legacyPath) : null;
  const next = writeActivePin(projectDir, {
    ref,
    commit: resolved,
    approved_by: options.approved_by ?? identity(root).name,
    approved_at: (options.at ?? new Date()).toISOString(),
    proposal: pin.proposal,
    previous_commit: pin.commit,
  });
  let published: ActivePin | ApproveResult = next;
  if (tracked) {
    try {
      published = commitTrackedPinPlan(projectDir, root, next, {
        at: options.at,
        verb: "rollback",
        parent: mainBefore,
      });
    } catch (err) {
      if (previousLegacy === null) rmSync(legacyPath, { force: true });
      else atomicWriteFile(legacyPath, previousLegacy);
      throw err;
    }
  }
  recordProposalLine(projectDir, {
    operation: "rollback",
    commit: next.commit,
    reason: options.to ? `to ${resolved}` : undefined,
  });
  const headAfter = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const mainAfter = baseHeadsSha(root, projectDir);
  if (headAfter !== headBefore || mainAfter !== mainBefore) {
    throw configError("Internal error: rollback moved the configured base branch. Refusing.");
  }
  return published;
}
