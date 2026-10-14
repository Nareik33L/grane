/**
 * V2-15 AC4: representative real-world projects, not only hand-built
 * single-metric fixtures. Sources are documented in docs/v2-authoring.md.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { SemanticModel } from "../../src/model/model.js";
import { detectConnectorKinds, type ConnectorKind } from "../../src/providers/detect.js";
import { loadAutoProvider } from "../../src/providers/auto.js";
import { validateModel } from "../../src/validate/validate.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const CORPORA: Array<{
  rel: string;
  kind: ConnectorKind | "grane";
  source: RegExp;
}> = [
  { rel: "example/analytics", kind: "grane", source: /Shipped shop|multi-entity Grane/i },
  { rel: "example/analytics-duckdb", kind: "grane", source: /Shipped shop|byte-identical/i },
  { rel: "demo/analytics", kind: "grane", source: /Shipped shop|demo/i },
  { rel: "example/analytics-from-dbt", kind: "dbt", source: /dbt \/ MetricFlow|providers:/i },
  { rel: "tests/fixtures/dbt-shop", kind: "dbt", source: /MetricFlow shop/i },
  { rel: "tests/fixtures/dbt-saas", kind: "dbt", source: /SaaS/i },
  { rel: "tests/fixtures/cube-shop", kind: "cube", source: /Cube/i },
  { rel: "tests/fixtures/cube-js-shop", kind: "cube", source: /cube\.js/i },
  { rel: "tests/fixtures/lookml-shop", kind: "lookml", source: /Looker|LookML/i },
  { rel: "tests/fixtures/malloy-shop", kind: "malloy", source: /Malloy/i },
  { rel: "tests/fixtures/ossie-shop", kind: "ossie", source: /Ossie/i },
  {
    rel: "tests/fixtures/jaffle_shop",
    kind: "dbt",
    source: /dbt-labs\/jaffle|jaffle-shop-classic|Apache-2\.0|fd7bfaca/i,
  },
];

describe("representative real-world corpora", () => {
  it("docs/v2-authoring.md documents every corpus source", () => {
    const docs = readFileSync(join(ROOT, "docs/v2-authoring.md"), "utf8");
    expect(docs).toMatch(/## Real-world corpora/);
    expect(docs).toMatch(/Hand-built representative shapes/);
    expect(docs).toMatch(/Pinned public project/);
    expect(docs).toContain("tests/fixtures/jaffle_shop-import");
    for (const corpus of CORPORA) {
      expect(docs, corpus.rel).toContain(corpus.rel);
      expect(docs, `${corpus.rel} source`).toMatch(corpus.source);
    }
  });

  it("native Grane trees load a multi-entity catalog", () => {
    for (const rel of ["example/analytics", "example/analytics-duckdb", "demo/analytics"]) {
      const loaded = loadConfig(join(ROOT, rel));
      expect(Object.keys(loaded.config.entities).length, rel).toBeGreaterThanOrEqual(3);
      expect(Object.keys(loaded.config.metrics).length, rel).toBeGreaterThanOrEqual(5);
      const report = validateModel(new SemanticModel(loaded.config));
      expect(report.ok, rel).toBe(true);
    }
  });

  it("example/analytics-from-dbt imports the dbt shop via providers", () => {
    const loaded = loadConfig(join(ROOT, "example/analytics-from-dbt"));
    expect(loaded.config.providers[0]?.path).toMatch(/dbt-shop/);
    expect(Object.keys(loaded.config.metrics).length).toBeGreaterThan(0);
    expect(Object.values(loaded.config.metrics).some((metric) => metric.source?.provider === "dbt")).toBe(true);
  });

  it("provider fixtures detect the expected kind and import metrics", () => {
    const fixtures: Array<{ rel: string; kind: ConnectorKind }> = [
      { rel: "tests/fixtures/dbt-shop", kind: "dbt" },
      { rel: "tests/fixtures/dbt-saas", kind: "dbt" },
      { rel: "tests/fixtures/cube-shop", kind: "cube" },
      { rel: "tests/fixtures/cube-js-shop", kind: "cube" },
      { rel: "tests/fixtures/lookml-shop", kind: "lookml" },
      { rel: "tests/fixtures/malloy-shop", kind: "malloy" },
      { rel: "tests/fixtures/ossie-shop", kind: "ossie" },
    ];
    for (const { rel, kind } of fixtures) {
      const path = join(ROOT, rel);
      expect(detectConnectorKinds(path), rel).toContain(kind);
      const contribution = loadAutoProvider({ path }, { projectDir: path });
      const names = Object.keys(contribution.metrics);
      expect(names.length, `${rel} imported no metrics`).toBeGreaterThan(0);
    }
  });

  it("pins dbt-labs/jaffle_shop (Apache-2.0) and runs detect/import/validate", () => {
    const fixture = join(ROOT, "tests/fixtures/jaffle_shop");
    const source = readFileSync(join(fixture, "SOURCE.md"), "utf8");
    expect(source).toMatch(/fd7bfacae4f497ff044a6a0275268676bf1b64c3/);
    expect(source).toMatch(/Apache-2\.0/);
    expect(readFileSync(join(fixture, "LICENSE"), "utf8")).toMatch(/Apache License/);
    expect(detectConnectorKinds(fixture)).toContain("dbt");
    const contribution = loadAutoProvider({ path: fixture }, { projectDir: fixture });
    expect(contribution.warnings.join("\n")).toMatch(/no MetricFlow/i);
    expect(Object.keys(contribution.metrics)).toHaveLength(0);
    const loaded = loadConfig(join(ROOT, "tests/fixtures/jaffle_shop-import"));
    expect(loaded.config.providers[0]?.path).toMatch(/jaffle_shop/);
    const report = validateModel(new SemanticModel(loaded.config));
    expect(report.ok).toBe(true);
  });
});
