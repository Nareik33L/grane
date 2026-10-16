import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  NPM_PACK_ARGV,
  PACKAGE_NAME,
  RELEASE_OWNERS,
  assertCertifyCloudPinsDispatchRef,
  assertRunnable,
  assertSafeArgv,
  isAllowedPackPath,
  missingRequiredPackedFiles,
  packedPathsFromNpmPackJson,
  parseDryRunArgs,
  parseNpmViewResult,
  parseRcSha,
  rcCutFromMainInstructions,
  refuseMutatingCliArgs,
  releaseDryRunPlan,
  runReleaseDryRun,
  runnableSteps,
  unexpectedPackedFiles,
  type RunCommand,
} from "../../src/release/dry-run.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SHA = "a".repeat(40);
const OTHER = "b".repeat(40);
const SHORT_SHA = "e72c8ff";

const PKG = {
  name: PACKAGE_NAME,
  main: "dist/index.js",
  bin: { grane: "dist/cli/index.js", "grane-analytics": "dist/cli/index.js" },
};

const REQUIRED_PACK = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/cli/index.js"];

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
      expect(argv).toEqual([...NPM_PACK_ARGV]);
      return { stdout: packJson(opts.pack ?? REQUIRED_PACK), stderr: "", status: 0 };
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
    expect(runnableSteps(steps).map((s) => s.id)).toEqual(["npm-pack", "npm-view"]);
  });

  it("enforces print-only: those steps are not executed", () => {
    const gate5 = releaseDryRunPlan(SHA).find((s) => s.id === "gate-5");
    expect(gate5).toBeTruthy();
    expect(() => assertRunnable(gate5!)).toThrow(/print-only step gate-5/);
    const result = runReleaseDryRun({
      sha: SHA,
      root: ROOT,
      headSha: SHA,
      treeStatus: "",
      run: mockRun({}),
    });
    const executed = result.executed.map((a) => a.join(" ")).join("\n");
    expect(executed).not.toMatch(/gh workflow run/);
    expect(executed).not.toMatch(/git checkout/);
    expect(executed).not.toMatch(/\bnpm publish\b/);
    expect(result.executed).toEqual([
      [...NPM_PACK_ARGV],
      ["npm", "view", PACKAGE_NAME, "--json"],
    ]);
  });

  it("refuses a 7-character short SHA, publish/tag/push flags, and mutating commands", () => {
    expect(() => parseRcSha("abc")).toThrow(/40-character/);
    expect(() => parseRcSha(SHORT_SHA)).toThrow(/40-character/);
    expect(SHORT_SHA).toHaveLength(7);
    expect(() => parseDryRunArgs([])).toThrow(/--sha/);
    expect(() => parseDryRunArgs(["--sha", SHA, "--publish"])).toThrow(/does not publish, tag, or push/);
    expect(() => refuseMutatingCliArgs(["--tag"])).toThrow(/does not publish, tag, or push/);
    expect(() => refuseMutatingCliArgs(["--push"])).toThrow(/does not publish, tag, or push/);
    expect(() => assertSafeArgv(["npm", "publish"])).toThrow(/must not execute npm publish/);
    expect(() => assertSafeArgv(["npm", "version", "patch"])).toThrow(/must not execute npm version/);
    expect(() => assertSafeArgv(["npm", "dist-tag", "add", `${PACKAGE_NAME}@0.7.0`, "latest"])).toThrow(
      /must not execute npm dist-tag/,
    );
    expect(() => assertSafeArgv(["git", "tag", "v0.7.0"])).toThrow(/must not execute git tag/);
    expect(() => assertSafeArgv(["git", "push", "origin", "v0.7.0"])).toThrow(/must not execute git push/);
    expect(() => assertSafeArgv(["gh", "workflow", "run", "certify-cloud.yml"])).toThrow(/must not execute gh workflow run/);
    expect(() => assertSafeArgv(["gh", "release", "create", "v0.7.0"])).toThrow(/must not execute gh release/);
    expect(() => assertSafeArgv([...NPM_PACK_ARGV])).not.toThrow();
    expect(() => assertSafeArgv(["npm", "view", PACKAGE_NAME, "--json"])).not.toThrow();
  });

  it("npm pack argv includes --ignore-scripts so prepack/prepare/postpack do not run", () => {
    expect(NPM_PACK_ARGV).toEqual(["npm", "pack", "--dry-run", "--ignore-scripts", "--json"]);
    expect(NPM_PACK_ARGV).toContain("--ignore-scripts");
    const src = readFileSync(join(ROOT, "src/release/dry-run.ts"), "utf8");
    expect(src).toMatch(/prepack\/prepare\/postpack must not run/);
    expect(src).toMatch(/--ignore-scripts/);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    expect(pkg.scripts?.prepack).toBeUndefined();
    expect(pkg.scripts?.prepare).toBeUndefined();
    expect(pkg.scripts?.postpack).toBeUndefined();
    const result = runReleaseDryRun({
      sha: SHA,
      root: ROOT,
      headSha: SHA,
      treeStatus: "",
      run: mockRun({}),
    });
    expect(result.executed[0]).toEqual(["npm", "pack", "--dry-run", "--ignore-scripts", "--json"]);
    expect(result.executed[0]?.includes("--ignore-scripts")).toBe(true);
  });

  it("fails if --ignore-scripts is removed: prepack and postpack would run", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-pack-scripts-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          name: "ignore-scripts-probe",
          version: "0.0.0",
          scripts: {
            prepack: "node -e \"require('fs').writeFileSync('prepack.ran','1')\"",
            prepare: "node -e \"require('fs').writeFileSync('prepare.ran','1')\"",
            postpack: "node -e \"require('fs').writeFileSync('postpack.ran','1')\"",
          },
        }),
      );
      writeFileSync(join(dir, "index.js"), "module.exports = {};\n");
      const packed = spawnSync(NPM_PACK_ARGV[0]!, NPM_PACK_ARGV.slice(1) as string[], {
        cwd: dir,
        encoding: "utf8",
      });
      expect(packed.status, packed.stderr).toBe(0);
      expect(existsSync(join(dir, "prepack.ran")), "prepack must not run").toBe(false);
      expect(existsSync(join(dir, "postpack.ran")), "postpack must not run").toBe(false);
      expect(NPM_PACK_ARGV.includes("--ignore-scripts")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pack allowlist rejects secrets.json, id_ed25519, notes.txt, and dist source maps", () => {
    expect(isAllowedPackPath("demo/secrets.json")).toBe(false);
    expect(isAllowedPackPath("demo/id_ed25519")).toBe(false);
    expect(isAllowedPackPath("example/notes.txt")).toBe(false);
    expect(isAllowedPackPath("dist/cli/index.js.map")).toBe(false);
    expect(isAllowedPackPath("dist/index.js.map")).toBe(false);
    expect(unexpectedPackedFiles(["demo/secrets.json"])).toEqual(["demo/secrets.json"]);
    expect(unexpectedPackedFiles(["demo/id_ed25519"])).toEqual(["demo/id_ed25519"]);
    expect(unexpectedPackedFiles(["example/notes.txt"])).toEqual(["example/notes.txt"]);
    expect(unexpectedPackedFiles(["dist/cli/index.js.map"])).toEqual(["dist/cli/index.js.map"]);
    expect(isAllowedPackPath("dist/cli/index.js")).toBe(true);
    expect(isAllowedPackPath("dist/index.js")).toBe(true);
    expect(isAllowedPackPath("README.md")).toBe(true);
    expect(isAllowedPackPath("demo/analytics/grane.yml")).toBe(true);
    expect(unexpectedPackedFiles(REQUIRED_PACK)).toEqual([]);
  });

  it("requires bin target, dist/index.js, and README in the pack", () => {
    expect(missingRequiredPackedFiles(REQUIRED_PACK, PKG)).toEqual([]);
    expect(missingRequiredPackedFiles(["package.json", "dist/index.js", "dist/cli/index.js"], PKG)).toEqual([
      "README.md",
    ]);
    expect(missingRequiredPackedFiles(["package.json", "README.md", "dist/cli/index.js"], PKG)).toEqual([
      "dist/index.js",
    ]);
    expect(missingRequiredPackedFiles(["package.json", "README.md", "dist/index.js"], PKG)).toEqual([
      "dist/cli/index.js",
    ]);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: ["package.json", "dist/index.js", "dist/cli/index.js"] }),
      }),
    ).toThrow(/missing required files: README\.md/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: ["package.json", "README.md", "dist/cli/index.js"] }),
      }),
    ).toThrow(/missing required files: dist\/index\.js/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: ["package.json", "README.md", "dist/index.js"] }),
      }),
    ).toThrow(/missing required files: dist\/cli\/index\.js/);
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
        pack: [...REQUIRED_PACK, "demo/README.md", "example/analytics/grane.yml"],
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/does not publish, tag, or push/);
    expect(result.output).toContain(SHA);
    expect(result.output).toMatch(/owner=Kieran/);
    expect(result.output).toMatch(/owner=QA/);
    expect(result.npmView?.kind).toBe("published");
    expect(result.unexpectedFiles).toEqual([]);
    expect(result.missingRequired).toEqual([]);
    expect(result.executed).toEqual([
      ["npm", "pack", "--dry-run", "--ignore-scripts", "--json"],
      ["npm", "view", PACKAGE_NAME, "--json"],
    ]);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bpublish\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bversion\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bdist-tag\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\btag\b/);
    expect(result.executed.flat().join(" ")).not.toMatch(/\bpush\b/);
  });

  it("fails when HEAD is not the RC SHA, the tree is dirty, or pack is off the allowlist", () => {
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
        run: mockRun({ pack: [...REQUIRED_PACK, "demo/secrets.json"] }),
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: [...REQUIRED_PACK, "demo/id_ed25519"] }),
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: [...REQUIRED_PACK, "example/notes.txt"] }),
      }),
    ).toThrow(/allowlist/);
    expect(() =>
      runReleaseDryRun({
        sha: SHA,
        root: ROOT,
        headSha: SHA,
        treeStatus: "",
        run: mockRun({ pack: [...REQUIRED_PACK, "dist/index.js.map"] }),
      }),
    ).toThrow(/allowlist/);
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
    expect(checklist).toMatch(/npm pack --dry-run --ignore-scripts/);
    expect(checklist).toMatch(/allowlist/);
    expect(checklist).toMatch(/npm view grane-analytics/);
    expect(checklist).toMatch(/does not publish, tag, or push/);
    expect(checklist).toMatch(/npm version/);
    expect(checklist).toMatch(/npm dist-tag/);
    expect(checklist).toMatch(/gh release/);
    expect(checklist).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN/);
  });

  it("dry-run source adds no tokens and does not call publish/tag/push", () => {
    const src = readFileSync(join(ROOT, "src/release/dry-run.ts"), "utf8");
    expect(src).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|GH_TOKEN|GITHUB_TOKEN\s*=/);
    expect(src).toMatch(/execute: "print-only"/);
    expect(src).toMatch(/"npm", "pack", "--dry-run", "--ignore-scripts", "--json"/);
    expect(src).toMatch(/"npm", "view", PACKAGE_NAME, "--json"/);
  });

  it("live npm pack --dry-run --ignore-scripts file-list matches the allowlist", () => {
    const result = spawnSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const paths = packedPathsFromNpmPackJson(result.stdout || result.stderr);
    expect(paths.length).toBeGreaterThan(0);
    expect(unexpectedPackedFiles(paths), unexpectedPackedFiles(paths).join("\n")).toEqual([]);
    for (const path of paths) {
      expect(isAllowedPackPath(path), path).toBe(true);
    }
    expect(paths).toContain("README.md");
    expect(paths).toContain("package.json");
  });
});
