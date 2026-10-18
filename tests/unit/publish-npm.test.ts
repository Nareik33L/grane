import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const WORKFLOW = join(ROOT, ".github/workflows/publish-npm.yml");

function workflowText(): string {
  return readFileSync(WORKFLOW, "utf8");
}

describe("publish-npm.yml (R1-4)", () => {
  it("is tag-driven or workflow_dispatch, uses npm-publish, and cannot publish without a token", () => {
    const wf = workflowText();
    expect(wf).toMatch(/name:\s*Publish npm/);
    expect(wf).toMatch(/tags:\s*\n\s+-\s*"v\*"/);
    expect(wf).toMatch(/workflow_dispatch/);
    expect(wf).not.toMatch(/pull_request/);
    expect(wf).not.toMatch(/branches:/);

    expect(wf).toMatch(/permissions:\s*\n\s+contents:\s*read\s*\n\s+id-token:\s*write/);
    expect(wf).toMatch(/environment:\s*npm-publish/);
    expect(wf).toMatch(/npm ci --ignore-scripts/);
    expect(wf).not.toMatch(/cache:\s*npm/);
    expect(wf).toMatch(/npm run build/);
    expect(wf).toMatch(/npm run test:unit/);
    expect(wf).toMatch(/npx tsx src\/release\/check-pack\.ts/);
    expect(wf).toMatch(/npm publish --provenance/);
    expect(wf).toMatch(/\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);
    expect(wf).toMatch(/Fail closed if NPM_TOKEN is missing/);
    expect(wf).toMatch(/NPM_TOKEN is not set on the npm-publish environment\. Fail closed; not publishing\./);
    expect(wf).toMatch(/NODE_AUTH_TOKEN:\s*\$\{\{\s*secrets\.NPM_TOKEN\s*\}\}/);

    const packIdx = wf.indexOf("npx tsx src/release/check-pack.ts");
    const failIdx = wf.indexOf("Fail closed if NPM_TOKEN is missing");
    const publishIdx = wf.indexOf("npm publish --provenance");
    expect(packIdx).toBeGreaterThan(wf.indexOf("npm run test:unit"));
    expect(failIdx).toBeGreaterThan(packIdx);
    expect(publishIdx).toBeGreaterThan(failIdx);

    expect(wf).toMatch(/does not create the `npm-publish` environment/i);
    expect(wf).not.toMatch(/gh secret/);
    expect(wf).not.toMatch(/environments\.create|createEnvironment/);
    expect(wf).not.toMatch(/npm publish --dry-run/);
  });

  it("pins checkout and setup-node to commit SHAs", () => {
    const wf = workflowText();
    expect(wf).toMatch(/uses:\s*actions\/checkout@[0-9a-f]{40}/);
    expect(wf).toMatch(/uses:\s*actions\/setup-node@[0-9a-f]{40}/);
    expect(wf).not.toMatch(/uses:\s*actions\/checkout@v\d/);
    expect(wf).not.toMatch(/uses:\s*actions\/setup-node@v\d/);
  });

  it("fails closed unless GITHUB_REF is a v* tag, before publish", () => {
    const wf = workflowText();
    const step = "Require a v* tag ref";
    expect(wf).toContain(`- name: ${step}`);
    expect(wf).toMatch(/\[\[ "\$\{GITHUB_REF\}" != refs\/tags\/v\* \]/);
    expect(wf).toMatch(/workflow_dispatch from a branch cannot publish/);
    const stepIdx = wf.indexOf(step);
    const publishIdx = wf.indexOf("npm publish --provenance");
    expect(stepIdx).toBeGreaterThan(wf.indexOf("npx tsx src/release/check-pack.ts"));
    expect(publishIdx).toBeGreaterThan(stepIdx);
  });

  it("fails unless GITHUB_REF_NAME without v matches package.json version, before publish", () => {
    const wf = workflowText();
    const step = "Tag version must match package.json";
    expect(wf).toContain(`- name: ${step}`);
    expect(wf).toMatch(/TAG_VERSION="\$\{GITHUB_REF_NAME#v\}"/);
    expect(wf).toMatch(/require\('\.\/package\.json'\)\.version/);
    expect(wf).toMatch(/does not match package\.json version/);
    const stepIdx = wf.indexOf(step);
    const tagIdx = wf.indexOf("Require a v* tag ref");
    const publishIdx = wf.indexOf("npm publish --provenance");
    expect(stepIdx).toBeGreaterThan(tagIdx);
    expect(publishIdx).toBeGreaterThan(stepIdx);
  });

  it("does not embed an npm token value", () => {
    const wf = workflowText();
    expect(wf).not.toMatch(/npm_[A-Za-z0-9]{10,}/);
    expect(wf).not.toMatch(/NPM_TOKEN:\s*['\"]?[a-zA-Z0-9_-]{8,}/);
  });
});
