import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { GraneError } from "../../src/errors.js";
import { loadDbtProvider } from "../../src/providers/dbt/index.js";
import { parseDbtYamlFiles, parseSemanticManifest } from "../../src/providers/dbt/parse.js";
import { mapMetricFlowGraph } from "../../src/providers/dbt/map.js";
import { mergeContributions } from "../../src/providers/merge.js";
import { loadProvider } from "../../src/providers/registry.js";
import { GraneKernel } from "../../src/kernel.js";
import { graneConfigSchema } from "../../src/config/schema.js";

const fixtureShop = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-shop");

describe("dbt / MetricFlow YAML (legacy + latest spec)", () => {
  const graph = parseDbtYamlFiles(fixtureShop);
  const contribution = mapMetricFlowGraph(graph);

  it("imports simple metrics from legacy semantic_models", () => {
    expect(contribution.metrics.revenue?.type).toBe("sum");
    expect(contribution.metrics.revenue?.sql).toBe("${orders.net_amount}");
    expect(contribution.metrics.revenue?.entity).toBe("order");
    expect(contribution.metrics.revenue?.time_dimension).toBe("${orders.completed_at}");
    expect(contribution.metrics.revenue?.filters).toEqual({ "orders.status": "completed" });
    expect(contribution.metrics.revenue?.source?.provider).toBe("dbt");
    expect(contribution.metrics.orders?.type).toBe("count");
  });

  it("imports latest-spec models nested under models:", () => {
    expect(contribution.entities.customer?.table).toBe("customers");
    expect(contribution.dimensions.country?.sql).toBe("${customers.country}");
    expect(contribution.metrics.customers?.type).toBe("count");
    expect(contribution.metrics.customers?.synonyms).toContain("Customer count");
  });

  it("imports ratio metrics and skips unsupported MetricFlow types", () => {
    expect(contribution.metrics.average_order_value?.type).toBe("ratio");
    expect(contribution.metrics.average_order_value?.numerator).toBe("revenue");
    expect(contribution.metrics.average_order_value?.denominator).toBe("orders");
    expect(contribution.metrics.average_order_value?.synonyms).toContain("AOV");
    expect(contribution.metrics.trailing_revenue).toBeUndefined();
    expect(contribution.warnings.some((w) => w.includes("trailing_revenue") && w.includes("cumulative"))).toBe(
      true,
    );
  });

  it("infers many_to_one relationships from shared MetricFlow entities", () => {
    expect(contribution.relationships.orders_to_customers).toEqual(
      expect.objectContaining({
        from: "orders.customer_id",
        to: "customers.id",
        type: "many_to_one",
      }),
    );
    expect(contribution.relationships.payments_to_orders).toEqual(
      expect.objectContaining({
        from: "payments.order_id",
        to: "orders.id",
        type: "many_to_one",
      }),
    );
  });

  it("compiles a dbt-imported metric through the Grane kernel", () => {
    const kernel = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "from-dbt", timezone: "UTC" },
        connection: { type: "postgres", schema: "public" },
        entities: contribution.entities,
        metrics: contribution.metrics,
        dimensions: contribution.dimensions,
        relationships: contribution.relationships,
      }),
    );
    const { compiled, resolved } = kernel.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
    });
    expect(resolved.trust).toBe("governed");
    expect(compiled.sql).toMatch(/SUM\("orders"\."net_amount"\)/i);
    expect(compiled.sql).toMatch(/"customers"\."country"/i);
    expect(compiled.sql).toMatch(/"orders"\."status"/i);
    expect(kernel.governedCatalog().metrics.find((m) => m.name === "revenue")?.source.provider).toBe("dbt");
  });
});

describe("semantic_manifest.json", () => {
  it("maps measures referenced by SIMPLE metrics", () => {
    const graph = parseSemanticManifest(join(fixtureShop, "target/semantic_manifest.json"));
    const contribution = mapMetricFlowGraph(graph);
    expect(contribution.metrics.manifest_revenue?.sql).toBe("${orders.net_amount}");
    expect(contribution.metrics.manifest_revenue?.type).toBe("sum");
    expect(contribution.entities.order?.table).toBe("orders");
  });

  it("loads a manifest-only provider without a dbt project", () => {
    const contribution = loadDbtProvider(
      { type: "dbt", semantic_manifest: join(fixtureShop, "target/semantic_manifest.json") },
      { projectDir: fixtureShop },
    );
    expect(contribution.metrics.manifest_revenue).toBeDefined();
  });
});

describe("semantic provider merge", () => {
  it("lets native YAML add definitions that dbt does not have", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-dbt-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
project: { name: mix }
connection: { type: postgres, schema: public }
providers:
  - type: dbt
    project: ${JSON.stringify(fixtureShop)}
dimensions:
  device:
    entity: order
    sql: \${orders.device_type}
`,
    );
    const loaded = loadConfig(dir);
    expect(loaded.config.metrics.revenue?.source?.provider).toBe("dbt");
    expect(loaded.config.dimensions.device?.source?.provider).toBe("native");
    expect(loaded.config.dimensions.country?.source?.provider).toBe("dbt");
    expect(loaded.warnings.some((w) => w.includes("trailing_revenue"))).toBe(true);
  });

  it("refuses the same metric name from two providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-dup-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres }
providers:
  - type: dbt
    project: ${JSON.stringify(fixtureShop)}
metrics:
  revenue:
    entity: order
    type: sum
    sql: \${orders.net_amount}
`,
    );
    expect(() => loadConfig(dir)).toThrow(GraneError);
    try {
      loadConfig(dir);
    } catch (err) {
      expect((err as GraneError).refusal.message).toMatch(/Duplicate metric "revenue"/);
    }
  });

  it("errors on unknown provider types without guessing", () => {
    expect(() =>
      loadProvider({ type: "cube" }, { projectDir: fixtureShop }),
    ).toThrow(/Unknown semantic provider "cube"/);
  });

  it("mergeContributions is used by the registry path", () => {
    const a = mapMetricFlowGraph(parseDbtYamlFiles(fixtureShop));
    const merged = mergeContributions([a]);
    expect(Object.keys(merged.metrics).length).toBeGreaterThan(3);
  });
});
