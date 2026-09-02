import { graneConfigSchema, type GraneConfig } from "../src/config/schema.js";
import { SemanticModel } from "../src/model/model.js";
import { GraneKernel } from "../src/kernel.js";
import type { DatabaseSchema } from "../src/connectors/types.js";

/** The example e-commerce model, inlined so unit tests need no database. */
export function exampleConfig(overrides: Record<string, unknown> = {}): GraneConfig {
  return graneConfigSchema.parse({
    project: { name: "test", timezone: "UTC" },
    connection: { type: "postgres", schema: "public" },
    limits: { max_rows: 10000, default_rows: 1000, timeout_ms: 30000 },
    entities: {
      customer: { table: "customers", primary_key: "id" },
      order: { table: "orders", primary_key: "id" },
      product: { table: "products", primary_key: "id" },
    },
    metrics: {
      revenue: {
        description: "Net revenue from completed orders.",
        entity: "order",
        type: "sum",
        sql: "${orders.net_amount}",
        time_dimension: "${orders.completed_at}",
        unit: "GBP",
        synonyms: ["sales", "net sales"],
        filters: { "orders.status": "completed" },
      },
      orders: {
        entity: "order",
        type: "count",
        sql: "${orders.id}",
        time_dimension: "${orders.completed_at}",
        filters: { "orders.status": "completed" },
      },
      average_order_value: {
        entity: "order",
        type: "ratio",
        numerator: "revenue",
        denominator: "orders",
        synonyms: ["aov"],
      },
      payments_received: {
        entity: "order",
        type: "sum",
        sql: "${payments.amount}",
        time_dimension: "${orders.completed_at}",
        filters: { "payments.status": "succeeded" },
      },
      refunded_amount: {
        entity: "order",
        type: "sum",
        sql: "${refunds.amount}",
        time_dimension: "${orders.completed_at}",
      },
      customers: {
        entity: "customer",
        type: "count",
        sql: "${customers.id}",
        time_dimension: "${customers.created_at}",
      },
    },
    dimensions: {
      country: { entity: "customer", sql: "${customers.country}" },
      customer_type: { entity: "customer", sql: "${customers.customer_type}" },
      plan: { entity: "customer", sql: "${customers.plan}" },
      channel: { entity: "order", sql: "${orders.channel}" },
      order_status: { entity: "order", sql: "${orders.status}" },
      completed_at: { entity: "order", sql: "${orders.completed_at}", type: "timestamp" },
      product_category: { entity: "product", sql: "${products.category}" },
    },
    relationships: {
      orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      payments_to_orders: { from: "payments.order_id", to: "orders.id", type: "many_to_one" },
      refunds_to_orders: { from: "refunds.order_id", to: "orders.id", type: "many_to_one" },
      order_items_to_orders: { from: "order_items.order_id", to: "orders.id", type: "many_to_one" },
      order_items_to_products: {
        from: "order_items.product_id",
        to: "products.id",
        type: "many_to_one",
      },
      tickets_to_customers: {
        from: "support_tickets.customer_id",
        to: "customers.id",
        type: "many_to_one",
      },
      checkout_events_to_orders: {
        from: "checkout_events.order_id",
        to: "orders.id",
        type: "many_to_one",
      },
      subscriptions_to_customers: {
        from: "subscriptions.customer_id",
        to: "customers.id",
        type: "many_to_one",
      },
    },
    ...overrides,
  });
}

export function exampleModel(): SemanticModel {
  return new SemanticModel(exampleConfig());
}

export function exampleKernel(): GraneKernel {
  return new GraneKernel(exampleConfig());
}

export function exploringConfig(overrides: Record<string, unknown> = {}): GraneConfig {
  return exampleConfig({
    exploration: {
      enabled: true,
      schemas: ["public"],
      exclude: ["customers.email"],
    },
    ...overrides,
  });
}

export function exploringKernel(overrides: Record<string, unknown> = {}): GraneKernel {
  const kernel = new GraneKernel(exploringConfig(overrides));
  kernel.setSchema(exampleSchema());
  return kernel;
}

/** Live-schema-shaped snapshot used by unit tests (no database required). */
export function exampleSchema(): DatabaseSchema {
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
        ["name", "text"],
        ["email", "text"],
        ["country", "text"],
        ["customer_type", "text"],
        ["plan", "text"],
        ["created_at", "timestamp with time zone"],
      ]),
      table("orders", [
        ["id", "integer"],
        ["customer_id", "integer"],
        ["status", "text"],
        ["channel", "text"],
        ["net_amount", "numeric"],
        ["completed_at", "timestamp with time zone"],
        ["created_at", "timestamp with time zone"],
        ["paid_at", "timestamp with time zone"],
        ["settled_at", "timestamp with time zone"],
        ["refunded_at", "timestamp with time zone"],
        ["discount_code", "text"],
        ["device_type", "text"],
        ["referrer", "text"],
        ["payment_failure_code", "text"],
      ]),
      table("payments", [
        ["id", "integer"],
        ["order_id", "integer"],
        ["amount", "numeric"],
        ["status", "text"],
        ["failure_code", "text"],
        ["paid_at", "timestamp with time zone"],
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
      table("support_tickets", [
        ["id", "integer"],
        ["customer_id", "integer"],
        ["category", "text"],
        ["status", "text"],
      ]),
      table("checkout_events", [
        ["id", "integer"],
        ["order_id", "integer"],
        ["event_type", "text"],
      ]),
      table("subscriptions", [
        ["id", "integer"],
        ["customer_id", "integer"],
        ["plan", "text"],
        ["status", "text"],
        ["mrr", "numeric"],
      ]),
    ],
    foreignKeys: [],
  };
}

