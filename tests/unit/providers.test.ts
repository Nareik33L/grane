import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
    expect(contribution.metrics.revenue_per_order?.type).toBe("ratio");
    expect(contribution.metrics.revenue_per_order?.numerator).toBe("revenue");
    expect(contribution.metrics.revenue_per_order?.denominator).toBe("orders");
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

describe("dbt / MetricFlow filter operators", () => {
  it("keeps != filters as inequalities instead of inverting them", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-dbt-neq-"));
    writeFileSync(join(dir, "dbt_project.yml"), "name: neq\nprofile: neq\n");
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(
      join(dir, "models", "orders.yml"),
      `
semantic_models:
  - name: orders
    model: ref('orders')
    entities:
      - name: order
        type: primary
        expr: id
    dimensions:
      - name: status
        type: categorical
        expr: status
      - name: channel
        type: categorical
        expr: channel
    measures:
      - name: live_revenue
        agg: sum
        expr: net_amount
        create_metric: true
        filter: "{{ Dimension('order__status') }} != 'cancelled'"
      - name: web_revenue
        agg: sum
        expr: net_amount
        create_metric: true
        filter: "{{ Dimension('order__channel') }} = 'web' and {{ Dimension('order__status') }} != 'cancelled'"
`,
    );
    const contribution = mapMetricFlowGraph(parseDbtYamlFiles(dir));
    expect(contribution.metrics.live_revenue?.filters).toEqual([
      { field: "orders.status", operator: "!=", value: "cancelled" },
    ]);
    expect(contribution.metrics.web_revenue?.filters).toEqual([
      { field: "orders.channel", operator: "=", value: "web" },
      { field: "orders.status", operator: "!=", value: "cancelled" },
    ]);

    const kernel = new GraneKernel(
      graneConfigSchema.parse({
        connection: { type: "postgres", schema: "public" },
        entities: contribution.entities,
        metrics: contribution.metrics,
        dimensions: contribution.dimensions,
        relationships: contribution.relationships,
      }),
    );
    const { compiled } = kernel.compile({ metrics: ["live_revenue"] });
    expect(compiled.sql).toMatch(/"orders"\."status"\s*(<>|!=)\s*\$1/);
    expect(compiled.params).toEqual(["cancelled"]);
  });
});

describe("dbt / MetricFlow non_additive_dimension", () => {
  function projectWith(yaml: string): string {
    const dir = mkdtempSync(join(tmpdir(), "grane-dbt-nonadd-"));
    writeFileSync(join(dir, "dbt_project.yml"), "name: nonadd\nprofile: nonadd\n");
    mkdirSync(join(dir, "models"), { recursive: true });
    writeFileSync(join(dir, "models", "subscriptions.yml"), yaml);
    return dir;
  }

  const subscriptionsYaml = `
semantic_models:
  - name: subscriptions
    model: ref('subscriptions')
    defaults:
      agg_time_dimension: subscription_date
    entities:
      - name: subscription
        type: primary
        expr: id
      - name: user_id
        type: foreign
    dimensions:
      - name: subscription_date
        type: time
        expr: date_transaction
    measures:
      - name: mrr
        description: Sum of active subscription values at the end of the period.
        expr: subscription_value
        agg: sum
        create_metric: true
        non_additive_dimension:
          name: subscription_date
          window_choice: max
      - name: user_mrr
        expr: subscription_value
        agg: sum
        create_metric: true
        non_additive_dimension:
          name: subscription_date
          window_choice: max
          window_groupings:
            - user_id
      - name: subscription_events
        expr: id
        agg: count
        create_metric: true
metrics:
  - name: mrr_metric
    type: simple
    type_params:
      measure: mrr
`;

  it("never imports a non-additive measure as a plain aggregate", () => {
    const contribution = mapMetricFlowGraph(parseDbtYamlFiles(projectWith(subscriptionsYaml)));
    expect(contribution.metrics.mrr).toBeUndefined();
    expect(contribution.metrics.user_mrr).toBeUndefined();
    expect(contribution.metrics.mrr_metric).toBeUndefined();
    expect(contribution.metrics.subscription_events?.type).toBe("count");
    const mrrWarning = contribution.warnings.find((w) => w.startsWith('Skipping metric "mrr"'));
    expect(mrrWarning).toContain("non_additive_dimension");
    expect(mrrWarning).toContain("subscription_date");
    expect(mrrWarning).toContain("window_choice: max");
    expect(mrrWarning).toContain("additive: semi");
    expect(contribution.warnings.find((w) => w.startsWith('Skipping metric "user_mrr"'))).toContain(
      "window_groupings: user_id",
    );
    expect(contribution.warnings.some((w) => w.startsWith('Skipping metric "mrr_metric"'))).toBe(true);
  });

  it("applies the same rule to semantic_manifest.json measures", () => {
    const manifest = {
      semantic_models: [
        {
          name: "balances",
          node_relation: { alias: "account_balances" },
          defaults: { agg_time_dimension: "snapshot_date" },
          entities: [{ name: "account", type: "primary", expr: "account_id" }],
          dimensions: [{ name: "snapshot_date", type: "time", expr: "snapshot_date" }],
          measures: [
            {
              name: "balance",
              agg: "sum",
              expr: "balance",
              non_additive_dimension: { name: "snapshot_date", window_choice: "max", window_groupings: ["account"] },
            },
            { name: "accounts", agg: "count_distinct", expr: "account_id" },
          ],
        },
      ],
      metrics: [
        { name: "total_balance", type: "simple", type_params: { measure: "balance" } },
        { name: "account_count", type: "simple", type_params: { measure: "accounts" } },
      ],
    };
    const contribution = mapMetricFlowGraph(parseSemanticManifest("manifest.json", JSON.stringify(manifest)));
    expect(contribution.metrics.total_balance).toBeUndefined();
    expect(contribution.metrics.account_count?.type).toBe("count_distinct");
    expect(contribution.warnings.some((w) => w.startsWith('Skipping metric "total_balance"'))).toBe(true);
  });

  it("does not sum snapshots through the kernel for a skipped non-additive metric", () => {
    const contribution = mapMetricFlowGraph(parseDbtYamlFiles(projectWith(subscriptionsYaml)));
    const kernel = new GraneKernel(
      graneConfigSchema.parse({
        connection: { type: "postgres", schema: "public" },
        entities: contribution.entities,
        metrics: contribution.metrics,
        dimensions: contribution.dimensions,
        relationships: contribution.relationships,
      }),
    );
    expect(() => kernel.compile({ metrics: ["mrr"] })).toThrow(GraneError);
    try {
      kernel.compile({ metrics: ["mrr"] });
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("undefined_metric");
    }
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

  it("separates provider warnings from auth config lint", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-warn-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres, schema: public }
providers:
  - type: dbt
    project: ${JSON.stringify(fixtureShop)}
auth:
  agents:
    - id: finance
      token: finance-secret-token
      metrics: [revenue, not_a_metric]
`,
    );
    const loaded = loadConfig(dir);
    expect(loaded.warnings.some((w) => w.includes("trailing_revenue"))).toBe(true);
    expect(loaded.warnings.some((w) => w.includes('auth agent "finance"'))).toBe(true);
    expect(loaded.providerWarnings.some((w) => w.includes("trailing_revenue"))).toBe(true);
    expect(loaded.providerWarnings.some((w) => w.includes("auth agent"))).toBe(false);
  });

  it("surfaces skipped upstream definitions to agents through catalog warnings", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-catalog-warn-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres, schema: public }
providers:
  - type: dbt
    project: ${JSON.stringify(fixtureShop)}
auth:
  agents:
    - id: finance
      token: finance-secret-token
      metrics: [revenue]
    - id: analyst
      token: analyst-secret-token
`,
    );
    const loaded = loadConfig(dir);
    const kernel = new GraneKernel(loaded.config, {
      projectDir: loaded.projectDir,
      providerWarnings: loaded.providerWarnings,
    });

    const full = kernel.governedCatalog();
    expect(full.metrics.map((m) => m.name)).not.toContain("trailing_revenue");
    expect(full.warnings.some((w) => w.includes("trailing_revenue") && w.includes("cumulative"))).toBe(true);
    expect(full.warnings.some((w) => w.includes("auth agent"))).toBe(false);

    expect(kernel.governedCatalog("trailing").warnings).toHaveLength(1);
    expect(kernel.governedCatalog("country").warnings).toEqual([]);

    const analyst = kernel.bindAgent(loaded.config.auth.agents.find((a) => a.id === "analyst")!);
    expect(analyst.governedCatalog().warnings.length).toBeGreaterThan(0);

    const finance = kernel.bindAgent(loaded.config.auth.agents.find((a) => a.id === "finance")!);
    expect(finance.governedCatalog().warnings).toEqual([]);
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
      loadProvider({ type: "powerbi" }, { projectDir: fixtureShop }),
    ).toThrow(/Unknown semantic connector "powerbi"/);
  });

  it("mergeContributions is used by the registry path", () => {
    const a = mapMetricFlowGraph(parseDbtYamlFiles(fixtureShop));
    const merged = mergeContributions([a]);
    expect(Object.keys(merged.metrics).length).toBeGreaterThan(3);
  });
});
