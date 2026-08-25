import { describe, expect, it } from "vitest";
import { exampleConfig, exampleModel } from "../fixtures.js";
import { SemanticModel } from "../../src/model/model.js";
import { validateModel } from "../../src/validate/validate.js";
import type { DatabaseSchema } from "../../src/connectors/postgres/introspect.js";

function schemaFixture(): DatabaseSchema {
  const table = (name: string, columns: [string, string][]) => ({
    schema: "public",
    name,
    columns: columns.map(([n, t]) => ({ name: n, dataType: t, nullable: true })),
  });
  return {
    schemaName: "public",
    tables: [
      table("customers", [
        ["id", "integer"],
        ["country", "text"],
        ["customer_type", "text"],
        ["created_at", "timestamp with time zone"],
      ]),
      table("orders", [
        ["id", "integer"],
        ["customer_id", "integer"],
        ["status", "text"],
        ["channel", "text"],
        ["net_amount", "numeric"],
        ["completed_at", "timestamp with time zone"],
      ]),
      table("payments", [
        ["id", "integer"],
        ["order_id", "integer"],
        ["amount", "numeric"],
        ["status", "text"],
      ]),
      table("refunds", [
        ["id", "integer"],
        ["order_id", "integer"],
        ["amount", "numeric"],
      ]),
      table("order_items", [
        ["id", "integer"],
        ["order_id", "integer"],
        ["product_id", "integer"],
      ]),
      table("products", [
        ["id", "integer"],
        ["category", "text"],
      ]),
    ],
    foreignKeys: [],
  };
}

describe("structural validation", () => {
  it("passes the example model against a matching schema", () => {
    const report = validateModel(exampleModel(), schemaFixture());
    expect(report.ok).toBe(true);
    expect(report.metrics.every((m) => m.ok)).toBe(true);
    const revenue = report.metrics.find((m) => m.metric === "revenue")!;
    expect(revenue.availableDimensions).toContain("country");
    expect(revenue.timeDimension).toBe("orders.completed_at");
  });

  it("detects missing tables and columns (schema drift)", () => {
    const schema = schemaFixture();
    const orders = schema.tables.find((t) => t.name === "orders")!;
    orders.columns = orders.columns.filter((c) => c.name !== "net_amount");
    const report = validateModel(exampleModel(), schema);
    expect(report.ok).toBe(false);
    const revenue = report.metrics.find((m) => m.metric === "revenue")!;
    expect(revenue.ok).toBe(false);
    expect(revenue.issues.some((i) => i.code === "missing_column")).toBe(true);
  });

  it("rejects sum metrics over non-numeric columns", () => {
    const config = exampleConfig();
    config.metrics["revenue"]!.sql = "${orders.status}";
    const report = validateModel(new SemanticModel(config), schemaFixture());
    const revenue = report.metrics.find((m) => m.metric === "revenue")!;
    expect(revenue.issues.some((i) => i.code === "type_mismatch")).toBe(true);
  });

  it("rejects metrics on undefined entities", () => {
    const config = exampleConfig();
    config.metrics["revenue"]!.entity = "invoice";
    const report = validateModel(new SemanticModel(config));
    const revenue = report.metrics.find((m) => m.metric === "revenue")!;
    expect(revenue.issues.some((i) => i.code === "unknown_entity")).toBe(true);
  });

  it("rejects unreachable measures", () => {
    const config = exampleConfig();
    delete config.relationships["payments_to_orders"];
    const report = validateModel(new SemanticModel(config));
    const metric = report.metrics.find((m) => m.metric === "payments_received")!;
    expect(metric.issues.some((i) => i.code === "unreachable_measure")).toBe(true);
  });

  it("rejects count_distinct across a fan-out (not safely pre-aggregatable)", () => {
    const config = exampleConfig();
    config.metrics["paying_customers"] = {
      entity: "order",
      type: "count_distinct",
      sql: "${payments.id}",
      status: "approved",
      synonyms: [],
    };
    const report = validateModel(new SemanticModel(config));
    const metric = report.metrics.find((m) => m.metric === "paying_customers")!;
    expect(metric.issues.some((i) => i.code === "unsafe_fanout")).toBe(true);
  });

  it("rejects ratio components with mismatched grains", () => {
    const config = exampleConfig();
    config.metrics["broken_ratio"] = {
      entity: "order",
      type: "ratio",
      numerator: "revenue",
      denominator: "customers",
      status: "approved",
      synonyms: [],
    };
    const report = validateModel(new SemanticModel(config));
    const metric = report.metrics.find((m) => m.metric === "broken_ratio")!;
    expect(metric.issues.some((i) => i.code === "grain_mismatch")).toBe(true);
  });

  it("rejects metric filters outside the metric's grain", () => {
    const config = exampleConfig();
    config.metrics["revenue"]!.filters = { "customers.country": "UK" };
    const report = validateModel(new SemanticModel(config));
    const revenue = report.metrics.find((m) => m.metric === "revenue")!;
    expect(revenue.issues.some((i) => i.code === "filter_out_of_scope")).toBe(true);
  });
});
