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
    expect(recorded.some((r) => r.url.includes("/rulesets/11"))).toBe(true);
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
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
    const methods: string[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      const method = String(init?.method ?? "GET");
      methods.push(method);
      if (method.toUpperCase() !== "GET") {
        throw new Error(`non-GET ${method}`);
      }
      return new Response(JSON.stringify({ message: "Branch not protected" }), { status: 404 });
    };
    await githubGet("https://api.github.com/repos/acme/shop/branches/main/protection", "t", fetchImpl);
    expect(methods).toEqual(["GET"]);
    await expect(githubGet("https://api.github.com/repos/acme/shop/branches/main/protection", "t", fetchImpl, "PUT")).rejects.toThrow(
      /GET-only|refused PUT/,
    );
    await expect(githubGet("https://example.com/x", "t", fetchImpl)).rejects.toThrow(/api\.github\.com/);

    const recorded: Recorded[] = [];
    const get: GithubGet = async (url) => {
      recorded.push({ method: "GET", url });
      if (!url.startsWith("https://api.github.com/")) {
        throw new Error(`non-api ${url}`);
      }
      return { status: 404, body: JSON.stringify({ message: "Branch not protected" }) };
    };
    await checkBranchProtection({
      projectDir: tempDir(),
      originUrl: "https://github.com/acme/shop.git",
      branch: "main",
      token: "t",
      get,
    });
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded.every((r) => r.method === "GET")).toBe(true);
    expect(recorded.every((r) => r.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(recorded.some((r) => /\/protection$/.test(r.url) || r.url.includes("/rulesets"))).toBe(true);
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
  });

  it("docs/team-setup.md org-wide MCP example has no literal secret", () => {
    const docs = readFileSync(join(ROOT, "docs/team-setup.md"), "utf8");
    expect(docs).toMatch(/## 6\. Org-wide rollout/);
    const fences = [...docs.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    expect(fences.length).toBeGreaterThanOrEqual(1);
    const example = fences.find((block) => block.includes("mcpServers") && block.includes("DATABASE_URL"));
    expect(example, "org-wide MCP JSON example").toBeTruthy();
    const parsed = JSON.parse(example!) as {
      mcpServers: { grane: { command: string; args: string[]; env: { DATABASE_URL: string } } };
    };
    const url = parsed.mcpServers.grane.env.DATABASE_URL;
    expect(parsed.mcpServers.grane.command).toBe("grane");
    expect(parsed.mcpServers.grane.args).toContain("serve");
    expect(url).toContain("warehouse.example.com");
    expect(url).toContain("5432");
    expect(url).toContain("analytics");
    expect(url).toContain("grane_ro");
    expect(url).toContain("${GRANE_DB_PASSWORD}");
    expect(literalSecretInSharedExample(example!)).toBe(false);
    expect(literalSecretInSharedExample(url)).toBe(false);
  });
});

/** user:literal@ or password: literal — ${VAR} placeholders are allowed. */
function literalSecretInSharedExample(text: string): boolean {
  if (/:\/\/[^/\s:]+:(?!\$\{)[^/\s@]+@/.test(text)) return true;
  if (/\bpassword\s*[:=]\s*['"]?(?!\$\{)[^\s'"]+/i.test(text)) return true;
  if (/\b(P|GRANE_DB_)?PASSWORD\s*=\s*['"]?(?!\$\{)[^\s'"]+/i.test(text)) return true;
  return false;
}
