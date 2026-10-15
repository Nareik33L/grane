/**
 * Existing-YAML compat cert (V2-15). example/ and demo/ must load and
 * validate as they did on pre-V2 main (7a7ffc6). The only extra finding
 * V2 may add is the temporal_semi_additive_group_by warning.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { SemanticModel } from "../../src/model/model.js";
import { validateModel } from "../../src/validate/validate.js";
import { exampleConfig } from "../fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const catalog = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/v2-compat/pre-v2-yaml-catalog.json"), "utf8"),
) as {
  projects: Record<
    string,
    { metrics: string[]; dimensions: string[]; entities: string[]; relationships: string[] }
  >;
};

function catalogOf(dir: string) {
  const loaded = loadConfig(dir);
  return {
    metrics: Object.keys(loaded.config.metrics),
    dimensions: Object.keys(loaded.config.dimensions),
    entities: Object.keys(loaded.config.entities),
    relationships: Object.keys(loaded.config.relationships),
    report: validateModel(new SemanticModel(loaded.config)),
  };
}

function extraCodes(report: ReturnType<typeof validateModel>): string[] {
  return [
    ...new Set(
      [...report.issues, ...report.metrics.flatMap((metric) => metric.issues)]
        .filter((issue) => issue.code !== "temporal_semi_additive_group_by")
        .map((issue) => issue.code),
    ),
  ];
}

describe("V2 existing-YAML compat cert", () => {
  it("docs/v2-authoring.md is the operator guide", () => {
    const docs = readFileSync(join(ROOT, "docs/v2-authoring.md"), "utf8");
    expect(docs).toMatch(/Proposals are GitHub PRs/);
    expect(docs).toMatch(/Experimental vs governed/);
    expect(docs).toMatch(/`--authoring`/);
    expect(docs).toMatch(/Local vs shared/);
    expect(docs).toMatch(/Discovery is read-only/);
    expect(docs).toMatch(/`grane proposals` CLI/);
    expect(docs).toMatch(/`\.grane\/active\.json` pin/);
    expect(docs).toMatch(/only `serve` honours it/);
    expect(docs).toMatch(/`project\.base_branch`/);
    expect(docs).toMatch(/Temporal `group_by` warning/);
    expect(docs).toMatch(/Demo Postgres: ready-made vs build-your-own/);
    expect(docs).toMatch(/Importers \(unchanged\)/);
    expect(docs).toMatch(/Pending release step/);
    expect(docs).toMatch(/self_certifiable`, \*\*not certified\*\*/);
    expect(docs).toMatch(/credentialed `certify-cloud` run has\s+actually passed/);
    expect(docs).toMatch(/runtime-certified/);
    expect(docs).toMatch(/compile-supported/);
    expect(docs).toMatch(/not yet certified/);
    expect(docs).toMatch(/Real-world corpora/);
    expect(docs).toMatch(/release-checklist/);
    expect(docs).toMatch(/never write `\.grane\/active\.json`/);
    expect(docs).toMatch(/[Hh]ow to fix/);
  });

  for (const rel of Object.keys(catalog.projects)) {
    it(`${rel} matches the pre-V2 catalog and has no new validate errors`, () => {
      const got = catalogOf(join(ROOT, rel));
      const expected = catalog.projects[rel];
      expect(got.metrics, rel).toEqual(expected.metrics);
      expect(got.dimensions, rel).toEqual(expected.dimensions);
      expect(got.entities, rel).toEqual(expected.entities);
      expect(got.relationships, rel).toEqual(expected.relationships);
      expect(got.report.ok, rel).toBe(true);
      expect(extraCodes(got.report), rel).toEqual([]);
    });
  }

  it("existing YAML warns on temporal semi-additive group_by; generated drafts error", () => {
    const config = exampleConfig();
    config.metrics["on_hand"] = {
      entity: "order",
      type: "sum",
      sql: "${orders.net_amount}",
      time_dimension: "${orders.completed_at}",
      additive: "semi",
      semi_additive: { window: "last", group_by: ["${orders.completed_at}"] },
      status: "approved",
      synonyms: [],
    };
    const existing = validateModel(new SemanticModel(config));
    const warning = existing.metrics
      .find((metric) => metric.metric === "on_hand")
      ?.issues.find((issue) => issue.code === "temporal_semi_additive_group_by");
    expect(warning?.severity).toBe("warning");
    expect(existing.ok).toBe(true);

    const generated = validateModel(new SemanticModel(config), undefined, { generated: true });
    expect(generated.ok).toBe(false);
    expect(
      generated.metrics
        .find((metric) => metric.metric === "on_hand")
        ?.issues.find((issue) => issue.code === "temporal_semi_additive_group_by")?.severity,
    ).toBe("error");
  });
});
