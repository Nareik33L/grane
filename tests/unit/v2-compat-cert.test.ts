/**
 * Static half of the V2 certify compat check: the corpus still lists every
 * pre-V2 scenario. Live report comparison runs in corpus afterAll and in
 * `npx tsx tests/certification/compare-v2-compat.ts` after CI unit tests.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_CERTIFY_ENGINE,
  EXAMPLE_CERTIFY_ENGINE,
  PRE_V2_CERTIFY_SCENARIOS,
} from "../certification/v2-compat.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const CORPUS = readFileSync(join(ROOT, "tests/certification/corpus.test.ts"), "utf8");

describe("V2 example/demo certify compat", () => {
  it("example/ defaults to postgres and demo/ defaults to duckdb", () => {
    const example = readFileSync(join(ROOT, "example/analytics/grane.yml"), "utf8");
    const demo = readFileSync(join(ROOT, "demo/analytics/grane.yml"), "utf8");
    expect(example).toMatch(/type:\s*postgres/);
    expect(demo).toMatch(/type:\s*duckdb/);
    expect(EXAMPLE_CERTIFY_ENGINE).toBe("postgres");
    expect(DEMO_CERTIFY_ENGINE).toBe("duckdb");
  });

  it("the shared corpus still contains every pre-V2 scenario title", () => {
    for (const name of PRE_V2_CERTIFY_SCENARIOS) {
      expect(CORPUS, name).toContain(`it("${name}"`);
    }
  });
});
