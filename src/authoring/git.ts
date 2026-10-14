import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { isAdopterTestYaml, loadConfig } from "../config/load.js";
import { configError } from "../errors.js";
import { combineSemanticYaml } from "./yaml-merge.js";

/**
 * Git proposal library (V2-03). Shells out to `git` only — no GitHub SDK.
 *
 * Kieran's decisions: proposals are GitHub PRs; approval is merging the PR;
 * anyone with merge rights can approve; AI-generated metrics stay
 * `experimental` until that merge, after which they are `governed`.
 *
 * This module never writes to the active branch. Proposal commits are created
 * with plumbing (`commit-tree` + `update-ref` on `grane/proposal/*` only).
 * Approval is a read of merged state. Rollback re-pins `.grane/active.json`.
 */

export const PROPOSAL_BRANCH_PREFIX = "grane/proposal/";
export const ACTIVE_PIN_PATH = ".grane/active.json";

export const activePinSchema = z.object({
  ref: z.string().min(1),
  commit: z.string().min(1),
  approved_by: z.string().min(1),
  approved_at: z.string().min(1),
  proposal: z.string().optional(),
  previous_commit: z.string().nullable().optional(),
});
export type ActivePin = z.infer<typeof activePinSchema>;

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

export interface SemanticProposalDiff {
  metrics: NameDiff;
  dimensions: NameDiff;
  relationships: NameDiff;
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

function runGit(repoDir: string, args: string[], options: GitRunOptions = {}): { stdout: string; status: number; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    input: options.input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...options.env },
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
  return git(projectDir, ["rev-parse", "--show-toplevel"]).trim();
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
          `Commit, revert, or remove the file so the project directory matches HEAD.`,
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

function currentBranch(root: string): string {
  const name = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (!name || name === "HEAD") {
    throw configError(
      `HEAD is detached. Check out the active branch (usually main) before creating a proposal.`,
    );
  }
  return name;
}

function requireProposalBranch(branch: string): string {
  if (!branch.startsWith(PROPOSAL_BRANCH_PREFIX) || branch === PROPOSAL_BRANCH_PREFIX) {
    throw configError(
      `Refusing to write to "${branch}". Grane only creates commits on ${PROPOSAL_BRANCH_PREFIX}* — never on the active branch.`,
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
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot) || isRuntimeStatePath(fromRoot)) {
    throw configError(`Refusing to commit path "${rel}" onto a proposal branch.`);
  }
  return fromRoot;
}

export function readActivePin(projectDir: string): ActivePin | null {
  const path = join(projectDir, ACTIVE_PIN_PATH);
  if (!existsSync(path)) return null;
  try {
    return activePinSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch (err) {
    throw configError(`Invalid ${ACTIVE_PIN_PATH}: ${(err as Error).message}`);
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

function normalizeBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/**
 * The pin ref is the GitHub PR base, never a proposal branch. On the first pin it
 * must match `resolveActiveRef().branch`; afterwards it must keep the existing pin's ref.
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
  const expected = existing?.ref ?? resolveActiveRef(projectDir).branch;
  if (ref !== expected) {
    throw configError(
      `Refusing to pin against "${requested}". The pin ref must be "${expected}" (the approved/active base branch).`,
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
  const parsed = activePinSchema.parse(pin);
  const ref = assertPinRef(projectDir, parsed.ref);
  const root = gitRoot(projectDir);
  const approved = previouslyApprovedCommits(root, readActivePin(projectDir));
  const commit = assertPinnableCommit(root, parsed.commit, ref, approved, "commit");
  const previous_commit = parsed.previous_commit
    ? assertPinnableCommit(root, parsed.previous_commit, ref, approved, "previous_commit")
    : parsed.previous_commit;
  const next = { ...parsed, ref, commit, previous_commit };
  const path = join(projectDir, ACTIVE_PIN_PATH);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export interface ActiveRef {
  branch: string;
  commit: string;
  pinned: boolean;
}

export function resolveActiveRef(projectDir: string): ActiveRef {
  const root = gitRoot(projectDir);
  const pin = readActivePin(projectDir);
  const branch = pin?.ref ?? currentBranch(root);
  if (branch.startsWith(PROPOSAL_BRANCH_PREFIX)) {
    throw configError(
      `Active ref is proposal branch "${branch}". Check out the base branch (the GitHub PR base) first. ` +
        `Grane never writes proposals onto another proposal or the active branch.`,
    );
  }
  const commit = pin?.commit ?? git(root, ["rev-parse", "HEAD"]).trim();
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

function proposalMessage(id: string, title: string, baseBranch: string, baseCommit: string, body?: string): string {
  const subject = body ?? `feat(authoring): propose ${id}`;
  return [
    subject.split("\n")[0],
    "",
    title,
    "",
    `Grane-Proposal: ${id}`,
    `Grane-Base: ${baseBranch}`,
    `Grane-Base-Commit: ${baseCommit}`,
    "",
    "AI-generated metrics in this proposal are experimental until the GitHub PR is merged.",
    "Merging (anyone with merge rights) marks them governed.",
  ].join("\n");
}

function parseTrailer(message: string, key: string): string | undefined {
  const match = message.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

/** Create `grane/proposal/<yyyymmdd>-<slug>` and commit `files` on it. Never updates HEAD. */
export function createProposal(projectDir: string, input: CreateProposalInput): Proposal {
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
  for (const [rel, contents] of entries) {
    const path = gitPath(root, projectDir, rel);
    staged[path] = combineSemanticYaml(fileAtCommit(root, active.commit, path), contents, rel);
  }
  const title = input.title?.trim() || `Grane proposal: ${id}`;
  const headBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const activeBefore = git(root, ["rev-parse", active.branch]).trim();
  const commit = commitOnProposalBranch(
    root,
    branch,
    active.commit,
    staged,
    proposalMessage(id, title, active.branch, active.commit, input.message),
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
): { metrics: Record<string, unknown>; dimensions: Record<string, unknown>; relationships: Record<string, unknown> } {
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
    return {
      unified,
      files,
      semantic: {
        metrics: nameDiff(before.metrics, after.metrics),
        dimensions: nameDiff(before.dimensions, after.dimensions),
        relationships: nameDiff(before.relationships, after.relationships),
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

function githubRepoFromOrigin(root: string): string | null {
  const url = git(root, ["remote", "get-url", "origin"], { allowFail: true }).trim();
  if (!url) return null;
  const match = url.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/i);
  if (!match?.groups) return null;
  return `${match.groups.owner}/${match.groups.repo}`;
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
  const command = [
    "gh",
    "pr",
    "create",
    "--base",
    active.branch,
    "--head",
    proposal.branch,
    "--title",
    title,
    "--body",
    body,
  ]
    .map((part) => (/^[A-Za-z0-9_./:-]+$/.test(part) ? part : JSON.stringify(part)))
    .join(" ");
  return {
    title,
    body,
    head: proposal.branch,
    base: active.branch,
    repo: githubRepoFromOrigin(root),
    command,
  };
}

function isAncestor(root: string, ancestor: string, descendant: string): boolean {
  return runGit(root, ["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true }).status === 0;
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
 */
export function readMergedApproval(projectDir: string, idOrBranch: string): MergedApproval {
  const root = gitRoot(projectDir);
  const branch = resolveProposalBranch(root, idOrBranch);
  const proposal_id = proposalIdFromBranch(branch);
  const proposal_commit = git(root, ["rev-parse", branch]).trim();
  const active = resolveActiveRef(projectDir);
  const ancestor = isAncestor(root, proposal_commit, active.commit);
  const trailer_commit = findExactProposalTrailer(root, active.commit, proposal_id);
  const merged = ancestor || Boolean(trailer_commit);
  return {
    merged,
    proposal_id,
    proposal_branch: branch,
    proposal_commit,
    base_branch: active.branch,
    merge_commit: merged ? (ancestor ? active.commit : trailer_commit) : null,
    metric_trust: merged ? "governed" : "experimental",
  };
}

/** Re-pin a previously approved commit. Never checks out, resets, or commits on the active branch. */
export function rollbackPin(
  projectDir: string,
  options: { to?: string; approved_by?: string } = {},
): ActivePin {
  gitRoot(projectDir);
  const pin = readActivePin(projectDir);
  if (!pin) {
    throw configError(
      `Nothing to roll back: ${ACTIVE_PIN_PATH} does not exist. After a GitHub PR merge, pin that commit first.`,
    );
  }
  const ref = assertPinRef(projectDir, pin.ref);
  const target = options.to ?? pin.previous_commit ?? undefined;
  if (!target) {
    throw configError(
      `No previous approved commit on the pin. Pass to: "<commit>" of a previously merged proposal. ` +
        `Rollback re-pins; it does not rewrite git history or move the active branch.`,
    );
  }
  const root = gitRoot(projectDir);
  const resolved = git(root, ["rev-parse", "--verify", `${target}^{commit}`]).trim();
  if (resolved === pin.commit) {
    throw configError(`Already pinned at ${resolved}.`);
  }
  const headBefore = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const branchShaBefore = git(root, ["rev-parse", pin.ref], { allowFail: true }).trim();
  const next = writeActivePin(projectDir, {
    ref,
    commit: resolved,
    approved_by: options.approved_by ?? "rollback",
    approved_at: new Date().toISOString(),
    proposal: pin.proposal,
    previous_commit: pin.commit,
  });
  const headAfter = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  const branchShaAfter = git(root, ["rev-parse", pin.ref], { allowFail: true }).trim();
  if (headAfter !== headBefore || (branchShaBefore && branchShaAfter !== branchShaBefore)) {
    throw configError("Internal error: rollback moved the active branch. Refusing.");
  }
  return next;
}
