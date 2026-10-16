import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PACKAGE_NAME,
  RELEASE_OWNERS,
  assertCertifyCloudPinsDispatchRef,
  assertSafeArgv,
  isForbiddenPackPath,
  packedPathsFromNpmPackJson,
  parseDryRunArgs,
  parseNpmViewResult,
  parseRcSha,
  rcCutFromMainInstructions,
  refuseMutatingCliArgs,
  releaseDryRunPlan,
  runReleaseDryRun,
  unexpectedPackedFiles,
  type RunCommand,
} from "../../src/release/dry-run.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);

function packJson(paths: string[]): string {
  return JSON.stringify([{ files: paths.map((path) => ({ path })) }]);
}

function mockRun(opts: {
  pack?: string[];
  viewStdout?: string;
  viewStderr?: string;
  viewStatus?: number;
}): RunCommand {
  return (argv) => {
    if (argv[0] === "npm" && argv[1] === "pack") {
      return { stdout: packJson(opts.pack ?? ["package.json", "dist/cli/index.js"]), stderr: "", status: 0 };
    }
    if (argv[0] === "npm" && argv[1] === "view") {
      expect(argv).toEqual(["npm", "view", PACKAGE_NAME, "--json"]);
      return {
        stdout: opts.viewStdout ?? `{ "name": "${PACKAGE_NAME}", "version": "0.7.0" }`,
        stderr: opts.viewStderr ?? "",
        status: opts.viewStatus ?? 0,
      };
    }
    throw new Error(`test runner should not execute ${argv.join(" ")}`);
  };
}

describe("release-checklist dry-run (P0-3)", () => {
  it("names how the RC is cut from main and pins every step to that SHA", () => {
    const cut = rcCutFromMainInstructions(SHA).join("\n");
    expect(cut).toMatch(/Lead cuts the RC from main/);
    expect(cut).toMatch(/git fetch origin main/);
    expect(cut).toMatch(/git rev-parse origin\/main/);
    expect(cut).toContain(SHA);
    expect(cut).toMatch(new RegExp(`npx tsx src/release/dry-run.ts --sha ${SHA}`));

    const steps = releaseDryRunPlan(SHA);
    expect(steps.length).toBeGreaterThanOrEqual(6);
    for (const step of steps) {
      expect(RELEASE_OWNERS, step.id).toContain(step.owner);
      expect(step.sha).toBe(SHA);
      expect(step.command, step.id).toContain(SHA);
    }
    expect(steps.find((s) => s.id === "rc-cut")?.owner).toBe("Lead");
    expect(steps.find((s) => s.id === "gate-5")?.owner).toBe("Kieran");
    expect(steps.find((s) => s.id === "gate-8")?.owner).toBe("QA");
    expect(steps.find((s) => s.id === "npm-pack")?.owner).toBe("Lead");
    expect(steps.find((s) => s.id === "npm-view")?.owner).toBe("Lead");
    expect(steps.find((s) => s.id === "gate-5")?.command).toMatch(
      new RegExp(`gh workflow run certify-cloud\\.yml --ref ${SHA}`),
    );
    expect(steps.find((s) => s.id === "gate-8")?.command).toMatch(new RegExp(`git checkout ${SHA}`));
    expect(steps.find((s) => s.id === "gate-5")?.execute).toBe("print-only");
    expect(steps.find((s) => s.id === "gate-8")?.execute).toBe("print-only");
    expect(steps.find((s) => s.id === "npm-publish-hold")?.execute).toBe("print-only");
    expect(steps.find((s) => s.id === "npm-publish-hold")?.command).toMatch(/not run/);
  });

  it("refuses short SHAs, publish/tag/push flags, and mutating commands", () => {
    expect(() => parseRcSha("abc")).toThrow(/40-character/);
    expect(() => parseDryRunArgs([])).toThrow(/--sha/);
    expect(() => parseDryRunArgs(["--sha", SHA, "--publish"])).toThrow(/does not publish, tag, or push/);
    expect(() => refuseMutatingCliArgs(["--tag"])).toThrow(/does not publish, tag, or push/);
    expect(() => refuseMutatingCliArgs(["--push"])).toThrow(/does not publish, tag, or push/);
    expect(() => assertSafeArgv(["npm", "publish"])).toThrow(/must not execute npm publish/);
    expect(() => assertSafeArgv(["git", "tag", "v0.7.0"])).toThrow(/must not execute git tag/);
    expect(() => assertSafeArgv(["git", "push", "origin", "v0.7.0"])).toThrow(/must not execute git push/);
    expect(() => assertSafeArgv(["gh", "workflow", "run", "certify-cloud.yml"])).toThrow(/must not execute gh workflow run/);
    expect(() => assertSafeArgv(["npm", "pack", "--dry-run", "--json"])).not.toThrow();
    expect(() => assertSafeArgv(["npm", "view", PACKAGE_NAME, "--json"])).not.toThrow();
  });

  it("fails the pack file-list on tests, fixtures, .env, or keys", () => {
    const filesField = ["dist", "example", "demo"];
    expect(isForbiddenPackPath("tests/unit/foo.test.ts")).toBe(true);
    expect(isForbiddenPackPath("demo/fixtures/seed.sql")).toBe(true);
    expect(isForbiddenPackPath(".env")).toBe(true);
    expect(isForbiddenPackPath("demo/.env.local")).toBe(true);
    expect(isForbiddenPackPath("rsa_key.p8")).toBe(true);
    expect(isForbiddenPackPath("certs/service.pem")).toBe(true);
    expect(isForbiddenPackPath("id_rsa")).toBe(true);
    expect(isForbiddenPackPath("dist/cli/index.js")).toBe(false);

    expect(unexpectedPackedFiles(["tests/unit/a.ts"], filesField)).toEqual(["tests/unit/a.ts"]);
    expect(unexpectedPackedFiles(["example/fixtures/x.yml"], filesField)).toEqual(["example/fixtures/x.yml"]);
    expect(unexpectedPackedFiles([".env"], filesField)).toEqual([".env"]);
    expect(unexpectedPackedFiles(["demo/secrets.pem"], filesField)).toEqual(["demo/secrets.pem"]);
    expect(unexpectedPackedFiles(["src/cli/index.ts"], filesField)).toEqual(["src/cli/index.ts"]);
    expect(
      unexpectedPackedFiles(["package.json", "README.md", "LICENSE", "dist/cli/index.js", "demo/README.md"], filesField),
    ).toEqual([]);

    const parsed = packedPathsFromNpmPackJson(packJson(["package.json", "tests/secret.env"]));
    expect(parsed).toEqual(["package.json", "tests/secret.env"]);
    expect(unexpectedPackedFiles(parsed, filesField)).toContain("tests/secret.env");
  });

  it("treats npm view as read-only ownership and accepts an unpublished 404", () => {
    const published = parseNpmViewResult(`{"name":"${PACKAGE_NAME}","version":"0.6.0"}`, "", 0);
    expect(published).toEqual({
      kind: "published",
      name: PACKAGE_NAME,
      version: "0.6.0",
      detail: `${PACKAGE_NAME}@0.6.0 (read-only; not published by this script).`,
    });
    const missing = parseNpmViewResult("", "npm error code E404\nnpm error 404 Not Found - GET https://registry.npmjs.org/grane-analytics", 1);
    expect(missing.kind).toBe("unpublished");
    expect(() => parseNpmViewResult(`{"name":"someone-else"}`, "", 0)).toThrow(/expected package/);
  });

  it("runs pack + view on the RC SHA and never dispatches, publishes, tags, or pushes", () => {
    const result = runReleaseDryRun({
      sha: SHA,
      root: ROOT,
      headSha: SHA,
      treeStatus: "",
      run: mockRun({
        pack: ["package.json", "LICENSE", "dist/index.js", "demo/README.md", "example/analytics/grane.yml"],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/does not publish, tag, or push/);
    expect(result.output).toContain(SHA);
    expect(result.output).toMatch(/owner=Kieran/);
    expect(result.output).toMatch(/owner=QA/);
    expect(result.npmView?.kind).toBe("published");
    expect(result.unexpectedFiles).toEqual([]);
    expect(result.executed).toEqual([
      ["npm", "pack", "--dry-run", "--json"],
      ["npm", "view", PACKAGE_NAME, "--json"],
    ]);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bpublish\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\btag\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bpush\b/);
  });

  it("fails when HEAD is not the RC SHA, the tree is dirty, or pack includes a forbidden path", () => {
    expect(() =>
      runReleaseDryRun({ sha: SHA, root: ROOT, headSha: OTHER, treeStatus: "", run: mockRun({}) }),
    ).toThrow(/checkout the RC SHA/);
    expect(() =>
      runReleaseDryRun({ sha: SHA, root: ROOT, headSha: SHA, treeStatus: " M package.json", run: mockRun({}) }),
    ).toThrow(/working tree is dirty/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: ["package.json", "tests/unit/foo.test.ts"] }),
      }),
    ).toThrow(/unexpected files/);
  });

  it("certify-cloud dispatch leaves checkout unpinned so --ref SHA wins", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    expect(() => assertCertifyCloudPinsDispatchRef(wf)).not.toThrow();
    expect(() =>
      assertCertifyCloudPinsDispatchRef(`on:\n  push:\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n`),
    ).toThrow(/workflow_dispatch/);
    expect(() =>
      assertCertifyCloudPinsDispatchRef(
        `on:\n  workflow_dispatch:\njobs:\n  x:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: main\n`,
      ),
    ).toThrow(/must not hardcode ref/);
  });

  it("docs/release-checklist.md names the dry-run, owners, and RC cut from main", () => {
    const checklist = readFileSync(join(ROOT, "docs/release-checklist.md"), "utf8");
    expect(checklist).toMatch(/Cut the RC from main/);
    expect(checklist).toMatch(/git fetch origin main/);
    expect(checklist).toMatch(/src\/release\/dry-run\.ts --sha/);
    expect(checklist).toMatch(/owner:\s*Lead/i);
    expect(checklist).toMatch(/Kieran/);
    expect(checklist).toMatch(/QA/);
    expect(checklist).toMatch(/npm pack --dry-run/);
    expect(checklist).toMatch(/npm view grane-analytics/);
    expect(checklist).toMatch(/does not publish, tag, or push/);
    expect(checklist).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("dry-run source adds no tokens and does not call publish/tag/push", () => {
    const src = readFileSync(join(ROOT, "src/release/dry-run.ts"), "utf8");
    expect(src).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN\s*=/);
    expect(src).toMatch(/execute: "print-only"/);
    expect(src).toMatch(/npm pack --dry-run --json/);
    expect(src).toMatch(/npm view \$\{PACKAGE_NAME\} --json/);
  });

  it("live npm pack --dry-run file-list has no tests, fixtures, .env, or keys", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const filesField = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { files: string[] }).files;
    const paths = packedPathsFromNpmPackJson(result.stdout || result.stderr);
    expect(paths.length).toBeGreaterThan(0);
    expect(unexpectedPackedFiles(paths, filesField), paths.filter((p) => unexpectedPackedFiles([p], filesField).length).join("\n")).toEqual([]);
    for (const path of paths) {
      expect(isForbiddenPackPath(path), path).toBe(false);
    }
  });
});
