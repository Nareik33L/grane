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

function enabledFlag(value: unknown): boolean | undefined {
  if (value === true || value === false) return value;
  if (value && typeof value === "object" && "enabled" in value) {
    return Boolean((value as { enabled: unknown }).enabled);
  }
  return undefined;
}

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
  const force = enabledFlag(protection.allow_force_pushes);
  const del = enabledFlag(protection.allow_deletions);
  if (force !== true && del !== true) {
    have.add("no force-push/deletion");
  }
  if (enabledFlag(protection.enforce_admins) === true) {
    have.add("no bypass");
  }
  return have;
}

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
  const bypass = Array.isArray(ruleset.bypass_actors) ? ruleset.bypass_actors : [];
  if (bypass.length === 0) {
    have.add("no bypass");
  }
  return have;
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
  const include = conditions?.ref_name?.include ?? ["~ALL"];
  const exclude = conditions?.ref_name?.exclude ?? [];
  const included = include.some((p) => refMatches(p, branch));
  const excluded = exclude.some((p) => refMatches(p, branch));
  return included && !excluded;
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

  if (classicStatus === 403 && (rulesetsStatus === 403 || rulesetsRes.kind === "network" || rulesetsStatus === 0)) {
    return unverified("403", repo, branch);
  }
  if (rulesetsStatus === 403 && (classicStatus === 403 || classicRes.kind === "network" || classicStatus === 0)) {
    return unverified("403", repo, branch);
  }

  const classicNotProtected =
    classicStatus === 404 && /not protected/i.test(messageOf(classicBody));
  const classicMissing = classicStatus === 404 && !classicNotProtected;

  if (classicMissing && (rulesetsStatus === 404 || rulesetsRes.kind === "network" || rulesetsStatus === 0)) {
    if (classicStatus === 404 && rulesetsStatus === 404) {
      return unverified("404", repo, branch);
    }
    if (classicRes.kind === "network" || rulesetsRes.kind === "network") {
      return unverified("network error", repo, branch);
    }
  }
  if (classicStatus === 404 && rulesetsStatus === 404) {
    return unverified("404", repo, branch);
  }
  if (classicStatus === 403 && rulesetsStatus === 404) {
    return unverified("403", repo, branch);
  }

  const have = new Set<string>();
  let readOk = false;

  if (classicStatus === 200) {
    const parsed = parseJson(classicBody);
    if (parsed && typeof parsed === "object") {
      for (const setting of settingsFromClassic(parsed as Record<string, unknown>)) have.add(setting);
      readOk = true;
    }
  } else if (classicNotProtected) {
    readOk = true;
  }

  if (rulesetsStatus === 200) {
    const listed = parseJson(rulesetsBody);
    const items = Array.isArray(listed) ? listed : [];
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      let details = row;
      if (!Array.isArray(row.rules) && row.id != null) {
        const detailRes = await readSource(get, `${API}/repos/${owner}/${name}/rulesets/${row.id}`);
        if (detailRes.kind === "network") {
          if (!readOk) return unverified("network error", repo, branch);
          continue;
        }
        if (detailRes.status === 403 && !readOk) return unverified("403", repo, branch);
        if (detailRes.status === 404 && !readOk && items.length === 0) return unverified("404", repo, branch);
        if (detailRes.status === 200) {
          const parsed = parseJson(detailRes.body);
          if (parsed && typeof parsed === "object") details = parsed as Record<string, unknown>;
        }
      }
      if (!rulesetApplies(details, branch)) continue;
      for (const setting of settingsFromRuleset(details)) have.add(setting);
      readOk = true;
    }
    readOk = true;
  }

  if (!readOk) {
    if (classicStatus === 403 || rulesetsStatus === 403) return unverified("403", repo, branch);
    if (classicStatus === 404 || rulesetsStatus === 404) return unverified("404", repo, branch);
    if (classicRes.kind === "network" || rulesetsRes.kind === "network") {
      return unverified("network error", repo, branch);
    }
    return unverified("404", repo, branch);
  }

  const missing = BRANCH_PROTECTION_SETTINGS.filter((setting) => !have.has(setting));
  const report: BranchProtectionReport = {
    status: missing.length === 0 ? "ok" : "missing",
    repo,
    branch,
    missing: [...missing],
    detail:
      missing.length === 0
        ? `${repo}@${branch} meets the required GitHub settings`
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
