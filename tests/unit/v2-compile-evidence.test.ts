/**
 * V2-15 AC1: supported configs keep the same metrics, meaning, and compiled
 * SQL as pre-V2 main (7a7ffc6). The committed evidence report is the fixture.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  collectAllEvidence,
  EVIDENCE_PROJECTS,
  PRE_V2_BASELINE,
  type ProjectEvidence,
} from "../certification/compile-evidence.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE = join(ROOT, "tests/fixtures/v2-compat/pre-v2-compile-evidence.json");

describe("pre-V2 compile evidence", () => {
  it("committed evidence report matches live compile of example/demo YAML", async () => {
    const expected = JSON.parse(readFileSync(FIXTURE, "utf8")) as Awaited<ReturnType<typeof collectAllEvidence>>;
    const live = await collectAllEvidence(ROOT);
    expect(expected.baseline_commit).toBe(PRE_V2_BASELINE);
    expect(live.baseline_commit).toBe(PRE_V2_BASELINE);
    expect(live.projects.map((project) => project.project)).toEqual([...EVIDENCE_PROJECTS]);
    expect(expected.projects.map((project) => project.project)).toEqual([...EVIDENCE_PROJECTS]);

    for (const project of live.projects) {
      const frozen = expected.projects.find((item) => item.project === project.project) as ProjectEvidence;
      expect(project.yaml_bytes_identical_to_pre_v2, project.project).toBe(true);
      expect(frozen.yaml_bytes_identical_to_pre_v2, project.project).toBe(true);
      expect(project.yaml_hashes_now, project.project).toEqual(project.yaml_hashes_pre_v2);
      expect(project.yaml_hashes_now, project.project).toEqual(frozen.yaml_hashes_now);
      expect(project.metrics, `${project.project} metric meaning`).toEqual(frozen.metrics);
      expect(project.validate_ok, project.project).toBe(true);
      expect(project.compiles, `${project.project} compiled SQL`).toEqual(frozen.compiles);
    }
  }, 60_000);

  it("docs/v2-compat-evidence.md records the baseline and the three projects", () => {
    const docs = readFileSync(join(ROOT, "docs/v2-compat-evidence.md"), "utf8");
    expect(docs).toMatch(/7a7ffc6/);
    expect(docs).toMatch(/same metrics/);
    expect(docs).toMatch(/same meaning/);
    expect(docs).toMatch(/compiled SQL/);
    for (const rel of EVIDENCE_PROJECTS) {
      expect(docs).toContain(rel);
    }
  });
});
