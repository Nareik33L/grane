/**
 * Read-only GitHub branch-protection check (T2).
 *
 * GETs classic branch protection and repository rulesets for the customer's
 * `origin` repo. Never PUT/PATCH/POST/DELETE — this module must not change
 * any repository's protection settings.
 */
import { spawnSync } from "node:child_process";
import { configuredBaseBranch, githubRepoFromOrigin, parseGithubOrigin } from "../authoring/git.js";

export const BRANCH_PROTECTION_SETTINGS = [
  "PR required with >=1 approval",
  "CODEOWNERS review for metric YAML and grane.pin.json",
  "dismiss stale approvals",
  "require approval of most recent push",
  "required status checks",
  "branch up to date",
  "no force-push/deletion",
  "no bypass",
] as const;

export type BranchProtectionSetting = (typeof BRANCH_PROTECTION_SETTINGS)[number];

export type BranchProtectionStatus = "ok" | "missing" | "couldn't verify";

export interface BranchProtectionReport {
  status: BranchProtectionStatus;
  repo: string | null;
  branch: string | null;
  missing: string[];
  detail: string;
  warnings: string[];
}

/** GET-only GitHub JSON helper. Tests inject this so no live network is required. */
export type GithubGet = (url: string) => Promise<{ status: number; body: string }>;

const API = "https://api.github.com";
const UNVERIFIED = "couldn't verify";

export function resolveGithubToken(
  env: NodeJS.ProcessEnv = process.env,
  readGhAuthToken: () => string | null = defaultGhAuthToken,
): string | null {
  const fromEnv = env.GITHUB_TOKEN?.trim() || env.GH_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readGhAuthToken();
}

function defaultGhAuthToken(): string | null {
  try {
    const result = spawnSync("gh", ["auth", "token"], {
      encoding: "utf8",
      timeout: 8_000,
    });
    if (result.status !== 0) return null;
    const token = (result.stdout ?? "").trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * GET https://api.github.com/… only. Refuses any other method or host so a
 * caller cannot accidentally change protection settings.
 */
export async function githubGet(
  url: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
  method: string = "GET",
): Promise<{ status: number; body: string }> {
  const verb = method.toUpperCase();
  if (verb !== "GET") {
    throw new Error(`branch protection check is GET-only; refused ${verb}`);
  }
  if (!url.startsWith(`${API}/`)) {
    throw new Error("branch protection check only GETs https://api.github.com/");
  }
  const res = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "grane",
    },
  });
  return { status: res.status, body: await res.text() };
}

function unverified(
  reason: string,
  repo: string | null = null,
  branch: string | null = null,
): BranchProtectionReport {
  const detail = `${UNVERIFIED} (${reason})`;
  if (/\bprotected\b/i.test(detail)) {
    throw new Error("unverified branch-protection copy must not say protected");
  }
  const report: BranchProtectionReport = {
    status: UNVERIFIED,
    repo,
    branch,
    missing: [],
    detail,
    warnings: [],
  };
  report.warnings = formatBranchProtectionWarnings(report);
  return report;
}

export function formatBranchProtectionWarnings(report: BranchProtectionReport): string[] {
  if (report.status === UNVERIFIED) {
    return [`WARNING: branch protection: ${report.detail}`];
  }
  if (report.status === "missing") {
    const where = report.repo && report.branch ? `${report.repo}@${report.branch}` : "origin";
    return report.missing.map((setting) => `WARNING: ${where}: enable ${setting}`);
  }
  return [];
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function messageOf(body: string): string {
  const parsed = parseJson(body);
  if (parsed && typeof parsed === "object" && "message" in parsed) {
    return String((parsed as { message: unknown }).message);
  }
  return body;
}

/** true/false only when the API actually returned a boolean (or `{enabled: boolean}`). */
function explicitBool(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value && typeof value === "object" && "enabled" in value) {
    const enabled = (value as { enabled: unknown }).enabled;
    if (enabled === true || enabled === false) return enabled;
  }
  return undefined;
}

/** Settings observed on a classic protection object. Omits "no bypass" (AND'd across sources). */
function settingsFromClassic(protection: Record<string, unknown>): Set<string> {
  const have = new Set<string>();
  const reviews = (protection.required_pull_request_reviews ?? null) as Record<string, unknown> | null;
  if (reviews && Number(reviews.required_approving_review_count ?? 0) >= 1) {
    have.add("PR required with >=1 approval");
  }
  if (reviews?.require_code_owner_reviews === true) {
    have.add("CODEOWNERS review for metric YAML and grane.pin.json");
  }
  if (reviews?.dismiss_stale_reviews === true) {
    have.add("dismiss stale approvals");
  }
  if (reviews?.require_last_push_approval === true) {
    have.add("require approval of most recent push");
  }
  const checks = (protection.required_status_checks ?? null) as Record<string, unknown> | null;
  const contexts = [
    ...((checks?.contexts as unknown[]) ?? []),
    ...((checks?.checks as unknown[]) ?? []),
  ];
  if (checks && contexts.length > 0) {
    have.add("required status checks");
  }
  if (checks?.strict === true) {
    have.add("branch up to date");
  }
  const force = explicitBool(protection.allow_force_pushes);
  const del = explicitBool(protection.allow_deletions);
  if (force === false && del === false) {
    have.add("no force-push/deletion");
  }
  return have;
}

/** Settings observed on a fully-read ruleset. Omits "no bypass" (AND'd across sources). */
function settingsFromRuleset(ruleset: Record<string, unknown>): Set<string> {
  const have = new Set<string>();
  const rules = Array.isArray(ruleset.rules) ? ruleset.rules : [];
  const pr = rules.find((r) => r && typeof r === "object" && (r as { type?: string }).type === "pull_request") as
    | { parameters?: Record<string, unknown> }
    | undefined;
  const params = pr?.parameters ?? {};
  if (Number(params.required_approving_review_count ?? 0) >= 1) {
    have.add("PR required with >=1 approval");
  }
  if (params.require_code_owner_review === true) {
    have.add("CODEOWNERS review for metric YAML and grane.pin.json");
  }
  if (params.dismiss_stale_reviews_on_push === true) {
    have.add("dismiss stale approvals");
  }
  if (params.require_last_push_approval === true) {
    have.add("require approval of most recent push");
  }
  const status = rules.find(
    (r) => r && typeof r === "object" && (r as { type?: string }).type === "required_status_checks",
  ) as { parameters?: Record<string, unknown> } | undefined;
  const required = (status?.parameters?.required_status_checks as unknown[]) ?? [];
  if (status && required.length > 0) {
    have.add("required status checks");
  }
  if (status?.parameters?.strict_required_status_checks_policy === true) {
    have.add("branch up to date");
  }
  const noForce = rules.some(
    (r) => r && typeof r === "object" && (r as { type?: string }).type === "non_fast_forward",
  );
  const noDel = rules.some((r) => r && typeof r === "object" && (r as { type?: string }).type === "deletion");
  if (noForce && noDel) {
    have.add("no force-push/deletion");
  }
  return have;
}

type UnreadableReason = "401" | "403" | "404" | "429" | "500" | "rate limit" | "network error" | "incomplete";

function httpReason(status: number, body: string): UnreadableReason {
  if (status === 401) return "401";
  if (status === 429) return "429";
  if (status >= 500) return "500";
  if (status === 403) {
    return /rate\s*limit/i.test(messageOf(body)) ? "rate limit" : "403";
  }
  if (status === 404) return "404";
  return "incomplete";
}

type RulesetEval =
  | { kind: "skip" }
  | { kind: "incomplete" }
  | { kind: "ok"; settings: Set<string>; noBypass: boolean };

function evaluateRuleset(ruleset: Record<string, unknown>, branch: string): RulesetEval {
  if (ruleset.target != null && ruleset.target !== "branch") return { kind: "skip" };
  if (ruleset.enforcement === "disabled" || ruleset.enforcement === "evaluate") return { kind: "skip" };
  if (ruleset.enforcement !== "active") return { kind: "incomplete" };
  if (ruleset.conditions == null || typeof ruleset.conditions !== "object") return { kind: "incomplete" };
  const refName = (ruleset.conditions as { ref_name?: unknown }).ref_name;
  if (refName == null || typeof refName !== "object") return { kind: "incomplete" };
  const include = (refName as { include?: unknown }).include;
  if (!Array.isArray(include) || include.length === 0) return { kind: "incomplete" };
  if (!rulesetApplies(ruleset, branch)) return { kind: "skip" };
  if (!Array.isArray(ruleset.rules)) return { kind: "incomplete" };
  if (!("bypass_actors" in ruleset) || !Array.isArray(ruleset.bypass_actors)) return { kind: "incomplete" };
  const canBypass = ruleset.current_user_can_bypass;
  const userCanAlwaysBypass = canBypass === "always" || canBypass === "pull_requests";
  return {
    kind: "ok",
    settings: settingsFromRuleset(ruleset),
    noBypass: ruleset.bypass_actors.length === 0 && !userCanAlwaysBypass,
  };
}

function refMatches(pattern: string, branch: string): boolean {
  if (pattern === "~ALL" || pattern === "refs/heads/*") return true;
  if (pattern === "~DEFAULT_BRANCH") return branch === "main" || branch === "master";
  if (pattern === `refs/heads/${branch}` || pattern === branch) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1);
    return `refs/heads/${branch}`.startsWith(prefix) || branch.startsWith(prefix);
  }
  return false;
}

function rulesetApplies(ruleset: Record<string, unknown>, branch: string): boolean {
  if (ruleset.target !== "branch") return false;
  if (ruleset.enforcement !== "active") return false;
  const conditions = (ruleset.conditions ?? null) as { ref_name?: { include?: string[]; exclude?: string[] } } | null;
  const include = conditions?.ref_name?.include;
  if (!Array.isArray(include) || include.length === 0) return false;
  const exclude = conditions?.ref_name?.exclude ?? [];
  const included = include.some((p) => refMatches(p, branch));
  const excluded = exclude.some((p) => refMatches(p, branch));
  return included && !excluded;
}

function preferReason(a: UnreadableReason, b: UnreadableReason): UnreadableReason {
  const order: UnreadableReason[] = [
    "401",
    "rate limit",
    "429",
    "403",
    "500",
    "network error",
    "404",
    "incomplete",
  ];
  return order.find((reason) => reason === a || reason === b) ?? "incomplete";
}

function coverageOf(source: { settings: Set<string>; noBypass: boolean }): Set<string> {
  const have = new Set(source.settings);
  if (source.noBypass) have.add("no bypass");
  return have;
}

function missingFrom(have: Set<string>): string[] {
  return BRANCH_PROTECTION_SETTINGS.filter((setting) => !have.has(setting));
}

/**
 * Classic protection and rulesets are alternative pictures of the same
 * branch, not layers to OR together. Bypass on either source still counts.
 */
function pickSingleSource(
  classic: { kind: "absent" } | { kind: "ok"; settings: Set<string>; noBypass: boolean },
  rulesets: { kind: "absent" } | { kind: "ok"; settings: Set<string>; noBypass: boolean },
): Set<string> {
  const classicHave = classic.kind === "ok" ? coverageOf(classic) : null;
  const rulesetHave = rulesets.kind === "ok" ? coverageOf(rulesets) : null;
  if (!classicHave && !rulesetHave) return new Set();
  if (classicHave && !rulesetHave) return classicHave;
  if (rulesetHave && !classicHave) return rulesetHave;

  const classicMissing = missingFrom(classicHave!);
  const rulesetMissing = missingFrom(rulesetHave!);
  const bypassHole = !classicHave!.has("no bypass") || !rulesetHave!.has("no bypass");

  if (classicMissing.length === 0 && !bypassHole) return classicHave!;
  if (rulesetMissing.length === 0 && !bypassHole) return rulesetHave!;
  if (classicMissing.length === 0) {
    const have = new Set(classicHave);
    have.delete("no bypass");
    return have;
  }
  if (rulesetMissing.length === 0) {
    const have = new Set(rulesetHave);
    have.delete("no bypass");
    return have;
  }
  return classicMissing.length <= rulesetMissing.length ? classicHave! : rulesetHave!;
}

async function readSource(
  get: GithubGet,
  url: string,
): Promise<{ kind: "ok"; status: number; body: string } | { kind: "network"; error: string }> {
  try {
    const res = await get(url);
    return { kind: "ok", status: res.status, body: res.body };
  } catch (err) {
    return { kind: "network", error: err instanceof Error ? err.message : String(err) };
  }
}

export async function checkBranchProtection(options: {
  projectDir: string;
  offline?: boolean;
  env?: NodeJS.ProcessEnv;
  token?: string | null;
  get?: GithubGet;
  readGhAuthToken?: () => string | null;
  originUrl?: string | null;
  branch?: string;
}): Promise<BranchProtectionReport> {
  if (options.offline) {
    return unverified("--offline");
  }

  let repo: string | null = null;
  if (options.originUrl !== undefined) {
    repo = options.originUrl ? parseGithubOrigin(options.originUrl) : null;
    if (options.originUrl && !repo) {
      return unverified("not a GitHub remote");
    }
    if (!options.originUrl) {
      return unverified("no GitHub remote");
    }
  } else {
    try {
      repo = githubRepoFromOrigin(options.projectDir);
    } catch {
      return unverified("no GitHub remote");
    }
    if (!repo) {
      return unverified("no GitHub remote");
    }
  }

  let branch = options.branch ?? null;
  if (!branch) {
    try {
      branch = configuredBaseBranch(options.projectDir);
    } catch {
      return unverified("couldn't resolve the configured base branch", repo, null);
    }
  }

  if (!repo || !branch) {
    return unverified("no GitHub remote", repo, branch);
  }

  const token =
    options.token !== undefined
      ? options.token
      : resolveGithubToken(options.env ?? process.env, options.readGhAuthToken ?? defaultGhAuthToken);
  if (!token) {
    return unverified("no token", repo, branch);
  }

  const get: GithubGet =
    options.get ??
    ((url) => githubGet(url, token));

  const [owner, name] = repo.split("/");
  const protectionUrl = `${API}/repos/${owner}/${name}/branches/${encodeURIComponent(branch)}/protection`;
  const rulesetsUrl = `${API}/repos/${owner}/${name}/rulesets?per_page=100&includes_parents=true`;

  const classicRes = await readSource(get, protectionUrl);
  const rulesetsRes = await readSource(get, rulesetsUrl);

  if (classicRes.kind === "network" && rulesetsRes.kind === "network") {
    return unverified("network error", repo, branch);
  }

  const classicStatus = classicRes.kind === "ok" ? classicRes.status : 0;
  const rulesetsStatus = rulesetsRes.kind === "ok" ? rulesetsRes.status : 0;
  const classicBody = classicRes.kind === "ok" ? classicRes.body : "";
  const rulesetsBody = rulesetsRes.kind === "ok" ? rulesetsRes.body : "";

  const classicNotProtected =
    classicStatus === 404 && /not protected/i.test(messageOf(classicBody));

  type Source =
    | { kind: "unreadable"; reason: UnreadableReason }
    | { kind: "absent" }
    | { kind: "ok"; settings: Set<string>; noBypass: boolean };

  let classic: Source;
  if (classicRes.kind === "network") {
    classic = { kind: "unreadable", reason: "network error" };
  } else if (classicNotProtected) {
    classic = { kind: "absent" };
  } else if (classicStatus === 200) {
    const parsed = parseJson(classicBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      classic = { kind: "unreadable", reason: "incomplete" };
    } else {
      const body = parsed as Record<string, unknown>;
      classic = {
        kind: "ok",
        settings: settingsFromClassic(body),
        noBypass: explicitBool(body.enforce_admins) === true,
      };
    }
  } else {
    classic = { kind: "unreadable", reason: httpReason(classicStatus, classicBody) };
  }

  let rulesets: Source;
  if (rulesetsRes.kind === "network") {
    rulesets = { kind: "unreadable", reason: "network error" };
  } else if (rulesetsStatus !== 200) {
    rulesets = { kind: "unreadable", reason: httpReason(rulesetsStatus, rulesetsBody) };
  } else {
    const listed = parseJson(rulesetsBody);
    if (!Array.isArray(listed)) {
      rulesets = { kind: "unreadable", reason: "incomplete" };
    } else {
      const settings = new Set<string>();
      const noBypassVotes: boolean[] = [];
      let incomplete = false;
      for (const item of listed) {
        if (!item || typeof item !== "object") continue;
        const row = item as Record<string, unknown>;
        if (row.target != null && row.target !== "branch") continue;
        if (row.enforcement === "disabled" || row.enforcement === "evaluate") continue;
        let details = row;
        if (!Array.isArray(row.rules) && row.id != null) {
          const detailRes = await readSource(get, `${API}/repos/${owner}/${name}/rulesets/${row.id}`);
          if (detailRes.kind === "network") {
            incomplete = true;
            break;
          }
          if (detailRes.status !== 200) {
            incomplete = true;
            break;
          }
          const parsed = parseJson(detailRes.body);
          if (!parsed || typeof parsed !== "object") {
            incomplete = true;
            break;
          }
          details = parsed as Record<string, unknown>;
        }
        const evaled = evaluateRuleset(details, branch);
        if (evaled.kind === "skip") continue;
        if (evaled.kind === "incomplete") {
          incomplete = true;
          break;
        }
        for (const setting of evaled.settings) settings.add(setting);
        noBypassVotes.push(evaled.noBypass);
      }
      if (incomplete) {
        rulesets = { kind: "unreadable", reason: "incomplete" };
      } else if (listed.length === 0 || (settings.size === 0 && noBypassVotes.length === 0)) {
        rulesets = { kind: "absent" };
      } else {
        rulesets = {
          kind: "ok",
          settings,
          noBypass: noBypassVotes.length > 0 && noBypassVotes.every(Boolean),
        };
      }
    }
  }

  if (classic.kind === "unreadable" && rulesets.kind === "unreadable") {
    return unverified(preferReason(classic.reason, rulesets.reason), repo, branch);
  }
  if (classic.kind === "unreadable") {
    return unverified(classic.reason, repo, branch);
  }
  if (rulesets.kind === "unreadable") {
    return unverified(rulesets.reason, repo, branch);
  }

  const have = pickSingleSource(classic, rulesets);

  const missing = BRANCH_PROTECTION_SETTINGS.filter((setting) => !have.has(setting));
  const report: BranchProtectionReport = {
    status: missing.length === 0 ? "ok" : "missing",
    repo,
    branch,
    missing: [...missing],
    detail:
      missing.length === 0
        ? `${repo}@${branch}: GitHub API returned all required settings`
        : `${repo}@${branch} is missing ${missing.length} required GitHub setting(s)`,
    warnings: [],
  };
  report.warnings = formatBranchProtectionWarnings(report);
  return report;
}

export function formatDoctorOutput(opts: {
  lintText: string;
  pin_warnings: string[];
  branch_protection: BranchProtectionReport;
}): string {
  const lines = ["Grane production doctor", "", opts.lintText];
  if (!opts.lintText.endsWith("\n")) lines.push("");
  if (opts.pin_warnings.length > 0) {
    lines.push(opts.pin_warnings.join("\n"));
    lines.push("");
  }
  if (opts.branch_protection.warnings.length > 0) {
    lines.push(...opts.branch_protection.warnings);
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}
