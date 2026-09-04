/**
 * Shared fixtures for the post-gauntlet path-ambiguity and JSON-null filter
 * correctness classes. Not a warehouse certification of its own — callers
 * execute through Grane against DuckDB / live PostgreSQL.
 */
import { graneConfigSchema, type GraneConfig } from "../../src/config/schema.js";

export const PATH_DDL = [
  `CREATE TABLE orders (id INTEGER PRIMARY KEY)`,
  `INSERT INTO orders VALUES (1)`,
  `CREATE TABLE items (order_id INTEGER, product_id INTEGER)`,
  `INSERT INTO items VALUES (1, 10)`,
  `CREATE TABLE shipments (order_id INTEGER, product_id INTEGER)`,
  `INSERT INTO shipments VALUES (1, 20)`,
  `CREATE TABLE products (id INTEGER PRIMARY KEY, weight DOUBLE PRECISION)`,
  `INSERT INTO products VALUES (10, 2.5), (20, 99)`,
  `CREATE TABLE shipping_costs (shipment_order_id INTEGER, cost DOUBLE PRECISION)`,
  `INSERT INTO shipping_costs VALUES (1, 7.5)`,
];

export const NULL_DDL = [
  `CREATE TABLE facts (id INTEGER PRIMARY KEY, status VARCHAR, amount DOUBLE PRECISION, flag BOOLEAN, label VARCHAR)`,
  `INSERT INTO facts VALUES
     (1, 'ok', 10, true, 'abc'),
     (2, NULL, 11, false, NULL),
     (3, 'bad', 100, true, 'x%y'),
     (4, 'ok', NULL, true, 'z')`,
  `CREATE TABLE dim_region (id INTEGER PRIMARY KEY, name VARCHAR)`,
  `INSERT INTO dim_region VALUES (1, 'US'), (2, NULL)`,
  `CREATE TABLE facts_region (id INTEGER PRIMARY KEY, region_id INTEGER, amount DOUBLE PRECISION)`,
  `INSERT INTO facts_region VALUES (1, 1, 10), (2, 2, 20), (3, NULL, 5)`,
];

const itemsRels = {
  items_to_orders: { from: "items.order_id", to: "orders.id", type: "many_to_one" as const },
  items_to_products: { from: "items.product_id", to: "products.id", type: "many_to_one" as const },
};
const shipmentRels = {
  shipments_to_orders: { from: "shipments.order_id", to: "orders.id", type: "many_to_one" as const },
  shipments_to_products: { from: "shipments.product_id", to: "products.id", type: "many_to_one" as const },
  shipments_to_costs: {
    from: "shipping_costs.shipment_order_id",
    to: "shipments.order_id",
    type: "many_to_one" as const,
  },
};

export function dualFanoutConfig(
  order: "items-first" | "shipments-first",
  connection: Record<string, unknown>,
  extras: Record<string, unknown> = {},
): GraneConfig {
  const relationships =
    order === "items-first" ? { ...itemsRels, ...shipmentRels } : { ...shipmentRels, ...itemsRels };
  return graneConfigSchema.parse({
    project: { name: "path-null", timezone: "UTC" },
    connection,
    entities: {
      order: { table: "orders", primary_key: "id" },
      item: { table: "items", primary_key: "order_id" },
      shipment: { table: "shipments", primary_key: "order_id" },
      product: { table: "products", primary_key: "id" },
    },
    metrics: {
      product_weight: { entity: "order", type: "sum", sql: "${products.weight}" },
      shipping_cost: { entity: "order", type: "sum", sql: "${shipping_costs.cost}" },
      order_count: { entity: "order", type: "count", sql: "${orders.id}" },
      weight_per_order: {
        entity: "order",
        type: "ratio",
        numerator: "product_weight",
        denominator: "order_count",
      },
      filtered_weight: {
        entity: "order",
        type: "sum",
        sql: "${products.weight}",
        filters: { "orders.id": 1 },
      },
    },
    dimensions: {
      order_id: { entity: "order", sql: "${orders.id}" },
    },
    relationships,
    ...extras,
  });
}

export function uniqueFanoutConfig(connection: Record<string, unknown>): GraneConfig {
  return graneConfigSchema.parse({
    project: { name: "unique-fanout", timezone: "UTC" },
    connection,
    entities: {
      order: { table: "orders", primary_key: "id" },
      shipment: { table: "shipments", primary_key: "order_id" },
    },
    metrics: {
      shipping_cost: { entity: "order", type: "sum", sql: "${shipping_costs.cost}" },
    },
    relationships: {
      shipments_to_orders: { from: "shipments.order_id", to: "orders.id", type: "many_to_one" },
      shipments_to_costs: {
        from: "shipping_costs.shipment_order_id",
        to: "shipments.order_id",
        type: "many_to_one",
      },
    },
  });
}

export function disconnectedMeasureConfig(connection: Record<string, unknown>): GraneConfig {
  return graneConfigSchema.parse({
    project: { name: "disconnected", timezone: "UTC" },
    connection,
    entities: { order: { table: "orders", primary_key: "id" } },
    metrics: { ghost_weight: { entity: "order", type: "sum", sql: "${ghosts.weight}" } },
    relationships: {},
  });
}

export function oneSafePlusInvalidConfig(connection: Record<string, unknown>): GraneConfig {
  return graneConfigSchema.parse({
    project: { name: "one-safe", timezone: "UTC" },
    connection,
    entities: {
      order: { table: "orders", primary_key: "id" },
      product: { table: "products", primary_key: "id" },
    },
    metrics: {
      product_weight: { entity: "order", type: "sum", sql: "${products.weight}" },
    },
    relationships: {
      items_to_orders: { from: "items.order_id", to: "orders.id", type: "many_to_one" },
      items_to_products: { from: "items.product_id", to: "products.id", type: "many_to_one" },
    },
  });
}

export function nullFilterConfig(
  connection: Record<string, unknown>,
  extraMetrics: Record<string, unknown> = {},
): GraneConfig {
  return graneConfigSchema.parse({
    project: { name: "null-filter", timezone: "UTC" },
    connection,
    entities: {
      fact: { table: "facts", primary_key: "id" },
      region_fact: { table: "facts_region", primary_key: "id" },
    },
    metrics: {
      total: { entity: "fact", type: "sum", sql: "${facts.amount}" },
      counted: { entity: "fact", type: "count", sql: "${facts.id}" },
      null_eq_total: {
        entity: "fact",
        type: "sum",
        sql: "${facts.amount}",
        filters: { "facts.status": null },
      },
      null_in_total: {
        entity: "fact",
        type: "sum",
        sql: "${facts.amount}",
        filters: [{ field: "facts.status", operator: "in", value: ["ok", null] }],
      },
      region_amount: { entity: "region_fact", type: "sum", sql: "${facts_region.amount}" },
      ...extraMetrics,
    },
    dimensions: {
      status: { entity: "fact", sql: "${facts.status}" },
      flag: { entity: "fact", sql: "${facts.flag}" },
      label: { entity: "fact", sql: "${facts.label}" },
      region: { entity: "region_fact", sql: "${dim_region.name}" },
    },
    relationships: {
      facts_region_to_region: {
        from: "facts_region.region_id",
        to: "dim_region.id",
        type: "many_to_one",
      },
    },
  });
}

export function combinedBugConfig(connection: Record<string, unknown>): GraneConfig {
  return dualFanoutConfig("items-first", connection, {
    metrics: {
      product_weight: { entity: "order", type: "sum", sql: "${products.weight}" },
      order_count: { entity: "order", type: "count", sql: "${orders.id}" },
    },
    dimensions: {
      order_id: { entity: "order", sql: "${orders.id}" },
    },
  });
}
