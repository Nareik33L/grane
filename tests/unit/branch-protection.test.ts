import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { exampleConfig } from "../fixtures.js";
import { formatProductionLint, lintProduction } from "../../src/cli/production-lint.js";
import {
  BRANCH_PROTECTION_SETTINGS,
  checkBranchProtection,
  formatDoctorOutput,
  githubGet,
  type GithubGet,
} from "../../src/github/branch-protection.js";
import { parseGithubOrigin } from "../../src/authoring/git.js";
import { stringify as stringifyYaml } from "yaml";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SNAPSHOT = join(ROOT, "tests/fixtures/doctor-branch-protection.txt");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-t2-"));
  temps.push(dir);
  return dir;
}

const CLASSIC_FULL = {
  required_pull_request_reviews: {
    required_approving_review_count: 1,
    require_code_owner_reviews: true,
    dismiss_stale_reviews: true,
    require_last_push_approval: true,
  },
  required_status_checks: {
    strict: true,
    contexts: ["ci"],
    checks: [{ context: "ci" }],
  },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
};

const RULESET_FULL = {
  id: 11,
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["refs/heads/main"], exclude: [] } },
  rules: [
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 1,
        require_code_owner_review: true,
        dismiss_stale_reviews_on_push: true,
        require_last_push_approval: true,
      },
    },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "ci" }],
      },
    },
    { type: "non_fast_forward" },
    { type: "deletion" },
  ],
};

type Recorded = { method: string; url: string };

function mockGet(
  routes: Record<string, { status: number; body: unknown }>,
  recorded: Recorded[],
): GithubGet {
  return async (url) => {
    recorded.push({ method: "GET", url });
    const hits = Object.entries(routes).filter(([key]) => url === key || url.startsWith(key));
    hits.sort((a, b) => b[0].length - a[0].length);
    const hit = hits[0];
    if (!hit) {
      return { status: 404, body: JSON.stringify({ message: "Not Found" }) };
    }
    const { status, body } = hit[1];
    return { status, body: typeof body === "string" ? body : JSON.stringify(body) };
  };
}

function api(path: string): string {
  return `https://api.github.com/repos/acme/shop${path}`;
}

async function reportFor(
  routes: Record<string, { status: number; body: unknown }>,
  extra: { originUrl?: string | null; branch?: string; token?: string | null } = {},
) {
  return checkBranchProtection({
    projectDir: tempDir(),
    originUrl: extra.originUrl === undefined ? "https://github.com/acme/shop.git" : extra.originUrl,
    branch: extra.branch ?? "main",
    token: extra.token === undefined ? "t" : extra.token,
    get: mockGet(routes, []),
  });
}

function expectNotOkOrUnverified(report: { status: string; detail: string; missing: string[] }): void {
  expect(report.status).not.toBe("ok");
  expect(["missing", "couldn't verify"]).toContain(report.status);
  expect(report.detail).not.toMatch(/protected/i);
  expect(JSON.stringify(report)).not.toMatch(/protected/i);
}

describe("branch protection check (T2)", () => {
  it("unprotected: warns once per missing setting", async () => {
    const recorded: Recorded[] = [];
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "git@github.com:acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
          [api("/rulesets")]: { status: 200, body: [] },
        },
        recorded,
      ),
    });
    expect(report.status).toBe("missing");
    expect(report.status).not.toBe("couldn't verify");
    expect(report.missing).toEqual([...BRANCH_PROTECTION_SETTINGS]);
    for (const setting of BRANCH_PROTECTION_SETTINGS) {
      expect(report.warnings.join("\n")).toContain(`enable ${setting}`);
    }
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });

  it("fully protected via classic settings", async () => {
    const recorded: Recorded[] = [];
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 200, body: CLASSIC_FULL },
          [api("/rulesets")]: { status: 200, body: [] },
        },
        recorded,
      ),
    });
    expect(report.status).toBe("ok");
    expect(report.missing).toEqual([]);
    expect(report.warnings).toEqual([]);
    expect(report.detail).not.toMatch(/protected/i);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });

  it("rulesets only: classic 404 + active ruleset covers every setting", async () => {
    const recorded: Recorded[] = [];
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
          [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
          [api("/rulesets/11")]: { status: 200, body: RULESET_FULL },
        },
        recorded,
      ),
    });
    expect(report.status).toBe("ok");
    expect(report.missing).toEqual([]);
    expect(report.detail).not.toMatch(/protected/i);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
    expect(recorded.some((r) => r.url.includes("/rulesets/11"))).toBe(true);
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
  });

  it("classic 200 omitting force-push/deletion flags is missing, not ok", async () => {
    const { allow_force_pushes, allow_deletions, ...partial } = CLASSIC_FULL;
    void allow_force_pushes;
    void allow_deletions;
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 200, body: partial },
          [api("/rulesets")]: { status: 200, body: [] },
        },
        [],
      ),
    });
    expect(report.status).toBe("missing");
    expect(report.missing).toContain("no force-push/deletion");
    expect(report.detail).not.toMatch(/protected/i);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("partial ruleset (list without details, GET 403) is couldn't verify, not ok", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 200, body: CLASSIC_FULL },
          [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
          [api("/rulesets/11")]: { status: 403, body: { message: "Resource not accessible" } },
        },
        [],
      ),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toMatch(/couldn't verify \(incomplete|403\)/);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("ruleset with bypass actors does not report no bypass as on", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
          [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
          [api("/rulesets/11")]: {
            status: 200,
            body: { ...RULESET_FULL, bypass_actors: [{ actor_id: 1, actor_type: "OrganizationAdmin" }] },
          },
        },
        [],
      ),
    });
    expect(report.status).toBe("missing");
    expect(report.missing).toContain("no bypass");
    expect(report.detail).not.toMatch(/protected/i);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("ruleset omitting bypass_actors is couldn't verify, not ok", async () => {
    const { bypass_actors, ...noBypassField } = RULESET_FULL;
    void bypass_actors;
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
          [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
          [api("/rulesets/11")]: { status: 200, body: noBypassField },
        },
        [],
      ),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toMatch(/couldn't verify \(incomplete\)/);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("classic no-bypass plus ruleset bypass actors does not over-claim no bypass", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 200, body: CLASSIC_FULL },
          [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
          [api("/rulesets/11")]: {
            status: 200,
            body: { ...RULESET_FULL, bypass_actors: [{ actor_id: 5, actor_type: "Team" }] },
          },
        },
        [],
      ),
    });
    expect(report.status).toBe("missing");
    expect(report.missing).toContain("no bypass");
    expect(report.detail).not.toMatch(/protected/i);
  });

  it("classic 200 + unreadable rulesets is couldn't verify, not ok", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 200, body: CLASSIC_FULL },
          [api("/rulesets")]: { status: 403, body: { message: "Resource not accessible" } },
        },
        [],
      ),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (403)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("403 is couldn't verify, never protected", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 403, body: { message: "Resource not accessible" } },
          [api("/rulesets")]: { status: 403, body: { message: "Resource not accessible" } },
        },
        [],
      ),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (403)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
    expect(report.warnings.join("\n")).toMatch(/couldn't verify \(403\)/);
  });

  it("404 is couldn't verify, never protected", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Not Found" } },
          [api("/rulesets")]: { status: 404, body: { message: "Not Found" } },
        },
        [],
      ),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (404)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("network error is couldn't verify, never protected", async () => {
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: async () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (network error)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("no token is couldn't verify and makes no request", async () => {
    const recorded: Recorded[] = [];
    const report = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: null,
      env: {},
      readGhAuthToken: () => null,
      get: mockGet({}, recorded),
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (no token)");
    expect(recorded).toEqual([]);
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("--offline and non-GitHub remotes are couldn't verify", async () => {
    const recorded: Recorded[] = [];
    const offline = await checkBranchProtection({
      projectDir: tempDir(),
      offline: true,
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet({}, recorded),
    });
    expect(offline.status).toBe("couldn't verify");
    expect(offline.detail).toBe("couldn't verify (--offline)");
    expect(recorded).toEqual([]);

    const gitlab = await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "git@gitlab.com:acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet({}, recorded),
    });
    expect(gitlab.status).toBe("couldn't verify");
    expect(gitlab.detail).toBe("couldn't verify (not a GitHub remote)");
    expect(recorded).toEqual([]);
  });

  it("fails if any non-GET request is made", async () => {
    const recorded: Recorded[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      recorded.push({ method: String(init?.method ?? ""), url: String(input) });
      if (String(init?.method ?? "").toUpperCase() !== "GET") {
        throw new Error(`non-GET ${String(init?.method)}`);
      }
      return new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 });
    };
    const protection = "https://api.github.com/repos/acme/shop/branches/main/protection";
    await githubGet(protection, "t", fetchImpl);
    expect(recorded).toEqual([{ method: "GET", url: protection }]);
    await expect(githubGet(protection, "t", fetchImpl, "PUT")).rejects.toThrow(/GET-only|refused PUT/);
    await expect(githubGet("https://example.com/x", "t", fetchImpl)).rejects.toThrow(/api\.github\.com/);

    recorded.length = 0;
    await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: (url) => githubGet(url, "t", fetchImpl),
    });
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
    expect(recorded.every((r) => r.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(recorded.some((r) => r.url.includes("/branches/main/protection"))).toBe(true);
    expect(recorded.some((r) => r.url.includes("/rulesets"))).toBe(true);
  });

  it("doctor output snapshot (unprotected + lint passed)", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".grane"), { recursive: true });
    const config = exampleConfig({
      connection: { type: "postgres", ssl: true, ssl_verify: true },
      auth: { agents: [{ id: "finance", token: "secret", exploration: false }] },
      audit: { enabled: true, path: ".grane/audit.jsonl" },
    });
    const lint = lintProduction(config, dir);
    expect(lint.ok).toBe(true);
    const branch_protection = await checkBranchProtection({
      projectDir: dir,
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get: mockGet(
        {
          [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
          [api("/rulesets")]: { status: 200, body: [] },
        },
        [],
      ),
    });
    const text = formatDoctorOutput({
      lintText: formatProductionLint(lint),
      pin_warnings: [],
      branch_protection,
    }).replace(/writable \S+\/\.grane\/audit\.jsonl/, "writable <PROJECT>/.grane/audit.jsonl");
    expect(text).toBe(readFileSync(SNAPSHOT, "utf8"));
    expect(text).toContain("enable PR required with >=1 approval");
    expect(text).toContain("enable CODEOWNERS review for metric YAML and grane.pin.json");
  });

  it("doctor --offline never fails the process for T2 and reports couldn't verify", () => {
    const dir = tempDir();
    mkdirSync(join(dir, ".grane"), { recursive: true });
    const config = exampleConfig({
      connection: { type: "postgres", ssl: true, ssl_verify: true },
      auth: { agents: [{ id: "finance", token: "secret", exploration: false }] },
      audit: { enabled: true, path: ".grane/audit.jsonl" },
    });
    const dumped = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
    delete dumped.unsupported;
    writeFileSync(join(dir, "grane.yml"), stringifyYaml(dumped));
    const doctor = spawnSync("npx", ["tsx", "src/cli/index.ts", "-p", dir, "doctor", "--offline", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 45_000,
      env: { ...process.env, GITHUB_TOKEN: "", GH_TOKEN: "" },
    });
    expect(doctor.status, `${doctor.stderr}\n${doctor.stdout}`).toBe(0);
    const body = JSON.parse(doctor.stdout) as {
      ok: boolean;
      branch_protection: { status: string; detail: string };
    };
    expect(body.ok).toBe(true);
    expect(doctor.status).toBe(0);
    expect(body.branch_protection.status).toBe("couldn't verify");
    expect(body.branch_protection.detail).toMatch(/couldn't verify/);
    expect(JSON.stringify(body.branch_protection)).not.toMatch(/"protected"/);
  });

  it("docs/team-setup.md names the GitHub settings and does not claim Grane enforces them", () => {
    const docs = readFileSync(join(ROOT, "docs/team-setup.md"), "utf8");
    for (const setting of BRANCH_PROTECTION_SETTINGS) {
      expect(docs).toContain(setting);
    }
    expect(docs).toMatch(/couldn't verify/);
    expect(docs).toMatch(/What Grane enforces vs what GitHub enforces/);
    expect(docs).toMatch(/serves only the pinned commit/);
    expect(docs).toMatch(/AI \/ MCP tools cannot approve/);
    expect(docs).toMatch(/who can merge/);
    expect(docs).toMatch(/identical YAML committed straight to `main`/);
    expect(docs).toMatch(/two-person-test\.md/);
    expect(docs).toMatch(/never PUT, PATCH, POST, or DELETE/i);
    expect(docs).not.toMatch(/Grane (will|does) turn on branch protection/i);
    expect(docs).toMatch(/partial ruleset|unreadable/);
    expect(docs).toMatch(/do not claim GitHub is enforcing a setting unless that setting is/);
    expect(docs).not.toMatch(/\bstatus\b[^\n]*protected/i);
  });

  it("docs/team-setup.md org-wide MCP example has no literal secret", () => {
    const docs = readFileSync(join(ROOT, "docs/team-setup.md"), "utf8");
    expect(docs).toMatch(/## 6\. Org-wide rollout/);
    const fences = [...docs.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    expect(fences.length).toBeGreaterThanOrEqual(1);
    const example = fences.find((block) => block.includes("mcpServers"));
    expect(example, "org-wide MCP JSON example").toBeTruthy();
    const parsed = JSON.parse(example!) as {
      mcpServers: { grane: { command: string; args: string[]; env?: Record<string, string> } };
    };
    expect(parsed.mcpServers.grane.command).toBe("grane");
    expect(parsed.mcpServers.grane.args).toContain("serve");
    expect(parsed.mcpServers.grane.env?.DATABASE_URL).toBeUndefined();
    expect(docs).toMatch(
      /url:\s*postgres:\/\/grane_ro:\$\{GRANE_DB_PASSWORD\}@warehouse\.example\.com:5432\/analytics/,
    );
    expect(literalSecretInSharedExample(example!)).toBe(false);
    expect(literalSecretInSharedExample(docs)).toBe(false);
  });

  it("docs secret scanner catches a JSON PGPASSWORD hunter2 entry", () => {
    expect(literalSecretInSharedExample('"PGPASSWORD": "hunter2"')).toBe(true);
    expect(literalSecretInSharedExample(JSON.stringify({ PGPASSWORD: "hunter2" }))).toBe(true);
    const docs = readFileSync(join(ROOT, "docs/team-setup.md"), "utf8");
    expect(literalSecretInSharedExample(docs)).toBe(false);
  });

  it("bypass_actors missing is not ok", async () => {
    const { bypass_actors, ...noBypassField } = RULESET_FULL;
    void bypass_actors;
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: { status: 200, body: noBypassField },
    });
    expectNotOkOrUnverified(report);
    expect(report.status).toBe("couldn't verify");
  });

  it("current_user_can_bypass always is not ok", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: { ...RULESET_FULL, current_user_can_bypass: "always" },
      },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toContain("no bypass");
  });

  it("enforce_admins false with only an unrelated ruleset is not ok", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: {
        status: 200,
        body: { ...CLASSIC_FULL, enforce_admins: { enabled: false } },
      },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } },
        },
      },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toContain("no bypass");
  });

  it("ruleset detail 403 is couldn't verify, not ok", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 200, body: CLASSIC_FULL },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: { status: 403, body: { message: "Resource not accessible" } },
    });
    expectNotOkOrUnverified(report);
    expect(report.status).toBe("couldn't verify");
  });

  it("does not add classic protection and rulesets together", async () => {
    const { required_status_checks, ...classicNoChecks } = CLASSIC_FULL;
    void required_status_checks;
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 200, body: classicNoChecks },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          rules: [
            {
              type: "required_status_checks",
              parameters: {
                strict_required_status_checks_policy: true,
                required_status_checks: [{ context: "ci" }],
              },
            },
          ],
        },
      },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing.length).toBeGreaterThan(0);
  });

  it("mutation: enforce_admins forced on", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: {
        status: 200,
        body: { ...CLASSIC_FULL, enforce_admins: { enabled: false } },
      },
      [api("/rulesets")]: { status: 200, body: [] },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toContain("no bypass");
  });

  it("mutation: force-push OR deletion where both are required", async () => {
    const forceOnly = await reportFor({
      [api("/branches/main/protection")]: {
        status: 200,
        body: { ...CLASSIC_FULL, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: true } },
      },
      [api("/rulesets")]: { status: 200, body: [] },
    });
    expectNotOkOrUnverified(forceOnly);
    expect(forceOnly.missing).toContain("no force-push/deletion");

    const delOnly = await reportFor({
      [api("/branches/main/protection")]: {
        status: 200,
        body: { ...CLASSIC_FULL, allow_force_pushes: { enabled: true }, allow_deletions: { enabled: false } },
      },
      [api("/rulesets")]: { status: 200, body: [] },
    });
    expectNotOkOrUnverified(delOnly);
    expect(delOnly.missing).toContain("no force-push/deletion");
  });

  it("mutation: ref match-all", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          conditions: { ref_name: { include: ["refs/heads/dev"], exclude: [] } },
        },
      },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toEqual([...BRANCH_PROTECTION_SETTINGS]);
  });

  it("mutation: ruleset non_fast_forward OR deletion where both are required", async () => {
    const forceOnly = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          rules: RULESET_FULL.rules.filter((rule) => rule.type !== "deletion"),
        },
      },
    });
    expectNotOkOrUnverified(forceOnly);
    expect(forceOnly.missing).toContain("no force-push/deletion");

    const delOnly = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          rules: RULESET_FULL.rules.filter((rule) => rule.type !== "non_fast_forward"),
        },
      },
    });
    expectNotOkOrUnverified(delOnly);
    expect(delOnly.missing).toContain("no force-push/deletion");
  });

  it("mutation: ruleset required_approving_review_count 0", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "active" }] },
      [api("/rulesets/11")]: {
        status: 200,
        body: {
          ...RULESET_FULL,
          rules: RULESET_FULL.rules.map((rule) =>
            rule.type === "pull_request"
              ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 0 } }
              : rule,
          ),
        },
      },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toContain("PR required with >=1 approval");
  });

  it("mutation: 0 approvals", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: {
        status: 200,
        body: {
          ...CLASSIC_FULL,
          required_pull_request_reviews: {
            ...CLASSIC_FULL.required_pull_request_reviews,
            required_approving_review_count: 0,
          },
        },
      },
      [api("/rulesets")]: { status: 200, body: [] },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toContain("PR required with >=1 approval");
  });

  it("mutation: evaluate mode", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Branch not protected" } },
      [api("/rulesets?")]: { status: 200, body: [{ id: 11, target: "branch", enforcement: "evaluate" }] },
      [api("/rulesets/11")]: { status: 200, body: { ...RULESET_FULL, enforcement: "evaluate" } },
    });
    expectNotOkOrUnverified(report);
    expect(report.missing).toEqual([...BRANCH_PROTECTION_SETTINGS]);
  });

  it("non-admin 404 is couldn't verify", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 404, body: { message: "Not Found" } },
      [api("/rulesets")]: { status: 200, body: [] },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (404)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("rate-limit 403 is couldn't verify", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 403, body: { message: "API rate limit exceeded" } },
      [api("/rulesets")]: { status: 403, body: { message: "API rate limit exceeded" } },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (rate limit)");
    expect(JSON.stringify(report)).not.toMatch(/protected/i);
  });

  it("labels 401 correctly", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 401, body: { message: "Bad credentials" } },
      [api("/rulesets")]: { status: 401, body: { message: "Bad credentials" } },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (401)");
  });

  it("labels 429 correctly", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 429, body: { message: "Too many requests" } },
      [api("/rulesets")]: { status: 429, body: { message: "Too many requests" } },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (429)");
  });

  it("labels 500 correctly", async () => {
    const report = await reportFor({
      [api("/branches/main/protection")]: { status: 500, body: { message: "Internal Server Error" } },
      [api("/rulesets")]: { status: 500, body: { message: "Internal Server Error" } },
    });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toBe("couldn't verify (500)");
  });

  it("unparseable remote is couldn't verify", async () => {
    const report = await reportFor({}, { originUrl: "not-a-remote" });
    expect(report.status).toBe("couldn't verify");
    expect(report.detail).toMatch(/couldn't verify \(not a GitHub remote\)/);
  });
});

describe("parseGithubOrigin", () => {
  it("accepts exact github.com hosts", () => {
    expect(parseGithubOrigin("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(parseGithubOrigin("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(parseGithubOrigin("https://github.com/acme/shop")).toBe("acme/shop");
    expect(parseGithubOrigin("ssh://git@github.com/acme/shop.git")).toBe("acme/shop");
  });

  it("rejects evil.com/github.com/o/r and notgithub.com", () => {
    expect(parseGithubOrigin("https://evil.com/github.com/o/r")).toBeNull();
    expect(parseGithubOrigin("https://notgithub.com/o/r")).toBeNull();
    expect(parseGithubOrigin("https://github.com.evil.com/o/r")).toBeNull();
    expect(parseGithubOrigin("git@notgithub.com:o/r.git")).toBeNull();
  });
});

/** user:literal@ or password: literal — ${VAR} placeholders are allowed. */
function literalSecretInSharedExample(text: string): boolean {
  if (/:\/\/[^/\s:]+:(?!\$\{)[^/\s@]+@/.test(text)) return true;
  if (/"((?:PG)?PASSWORD|GRANE_DB_PASSWORD)"\s*:\s*"(?!\$\{)[^"]+"/i.test(text)) return true;
  if (/\bpassword\s*[:=]\s*['"](?!\$\{)[^'"]+/i.test(text)) return true;
  return false;
}
