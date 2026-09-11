/**
 * Purpose-built certification fixture (#36).
 *
 * Seed arrays live in `tests/certification/data.ts`. DDL is generated per
 * dialect from the column-type map. Independent gold is TypeScript reductions
 * over those arrays — never Grane-generated SQL, and never SQL on the engine
 * under test (reviewed Postgres SQL remains a second oracle for Postgres only).
 *
 * Relationship fidelity (#17): orders.account_ref → customers.customer_key.
 * customers.id is a colliding surrogate that must not be the join target.
 */
import { graneConfigSchema, type GraneConfig, type ConnectionConfig } from "../../src/config/schema.js";

export { AUG, AUG_PARTIAL, JUL_AUG_SPAN, SEED, SEED_COUNTS } from "../certification/data.js";
export { PG_CERT_DDL, ddl } from "../certification/ddl.js";

export interface CertKernelOpts {
  connection: ConnectionConfig;
  timezone?: string;
  weekStarts?: "monday" | "sunday";
  products?: "products_safe" | "products_dup";
  snapshotsTable?: "snapshots" | "snapshots_unsafe";
  exploration?: boolean;
  defaultRows?: number;
  maxRows?: number;
}

export function certConfig(opts: CertKernelOpts): GraneConfig {
  const products = opts.products ?? "products_safe";
  const snaps = opts.snapshotsTable ?? "snapshots";
  const snapEntity = snaps === "snapshots" ? "snapshot" : "snap_unsafe";
  const snapTable = snaps;
  return graneConfigSchema.parse({
    project: {
      name: "pg-cert",
      timezone: opts.timezone ?? "UTC",
      week: { starts: opts.weekStarts ?? "monday" },
    },
    connection: opts.connection,
    limits: {
      max_rows: opts.maxRows ?? 10000,
      default_rows: opts.defaultRows ?? 1000,
      timeout_ms: 30000,
    },
    exploration: {
      enabled: opts.exploration ?? true,
      schemas: opts.connection.schema ? [opts.connection.schema] : [],
      exclude: [],
    },
    entities: {
      order: { table: "orders", primary_key: "id" },
      customer: { table: "customers", primary_key: "id" },
      snapshot: { table: "snapshots", primary_key: "id" },
      snap_unsafe: { table: "snapshots_unsafe", primary_key: "id" },
      day: { table: "days", primary_key: "id" },
      week: { table: "weeks", primary_key: "id" },
      item: { table: "items", primary_key: "id" },
      typ: { table: "types", primary_key: "id" },
    },
    metrics: {
      revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      avg_amount: {
        entity: "order",
        type: "avg",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      min_amount: {
        entity: "order",
        type: "min",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      max_amount: {
        entity: "order",
        type: "max",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      order_rows: {
        entity: "order",
        type: "count",
        time_dimension: "${orders.ordered_on}",
      },
      amount_count: {
        entity: "order",
        type: "count",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      distinct_accounts: {
        entity: "order",
        type: "count_distinct",
        sql: "${orders.account_ref}",
        time_dimension: "${orders.ordered_on}",
      },
      open_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        filters: { "orders.status": "open" },
      },
      open_rows: {
        entity: "order",
        type: "count",
        time_dimension: "${orders.ordered_on}",
        filters: { "orders.status": "open" },
      },
      open_amount_count: {
        entity: "order",
        type: "count",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        filters: { "orders.status": "open" },
      },
      aov: {
        entity: "order",
        type: "ratio",
        numerator: "revenue",
        denominator: "order_rows",
      },
      open_aov: {
        entity: "order",
        type: "ratio",
        numerator: "open_revenue",
        denominator: "open_rows",
      },
      date_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      naive_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.naive_at}",
      },
      instant_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.instant_at}",
      },
      uk_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        filters: { "customers.segment": "SMB" },
      },
      ghost_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        filters: { "ghost.flag": true },
      },
      fanout_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        filters: { "items.sku": "A_B" },
      },
      trial_revenue: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
        status: "experimental",
      },
      order_weight: {
        entity: "order",
        type: "sum",
        sql: `\${${products}.weight}`,
        time_dimension: "${orders.ordered_on}",
      },
      new_mrr: {
        entity: snapEntity,
        type: "sum",
        sql: snaps === "snapshots" ? "${snapshots.new_mrr}" : "${snapshots_unsafe.ending_mrr}",
        time_dimension: snaps === "snapshots" ? "${snapshots.month_start}" : "${snapshots_unsafe.month_start}",
        time_granularity: "month",
      },
      ending_mrr: {
        entity: snapEntity,
        type: "sum",
        sql: snaps === "snapshots" ? "${snapshots.ending_mrr}" : "${snapshots_unsafe.ending_mrr}",
        time_dimension: snaps === "snapshots" ? "${snapshots.month_start}" : "${snapshots_unsafe.month_start}",
        time_granularity: "month",
        additive: "semi",
        semi_additive: { window: "last", group_by: [] },
      },
      ending_mrr_series: {
        entity: snapEntity,
        type: "sum",
        sql: snaps === "snapshots" ? "${snapshots.ending_mrr}" : "${snapshots_unsafe.ending_mrr}",
        time_dimension: snaps === "snapshots" ? "${snapshots.month_start}" : "${snapshots_unsafe.month_start}",
        time_granularity: "month",
        additive: "semi",
        semi_additive: {
          window: "last",
          group_by: snaps === "snapshots" ? ["${snapshots.customer_key}"] : ["${snapshots_unsafe.customer_key}"],
        },
      },
      ending_mrr_entity: {
        entity: snapEntity,
        type: "sum",
        sql: snaps === "snapshots" ? "${snapshots.ending_mrr}" : "${snapshots_unsafe.ending_mrr}",
        time_dimension: snaps === "snapshots" ? "${snapshots.month_start}" : "${snapshots_unsafe.month_start}",
        time_granularity: "month",
        additive: "semi",
        semi_additive: { window: "last", group_by: "entity" },
      },
      march_x: {
        entity: "day",
        type: "sum",
        sql: "${days.x}",
        time_dimension: "${days.d}",
      },
      week_total: {
        entity: "week",
        type: "sum",
        sql: "${weeks.x}",
        time_dimension: "${weeks.d}",
      },
      type_int_sum: { entity: "typ", type: "sum", sql: "${types.id}" },
      type_bigint_sum: { entity: "typ", type: "sum", sql: "${types.big_n}" },
      type_numeric_sum: { entity: "typ", type: "sum", sql: "${types.dec_n}" },
      period_month: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
      code: {
        entity: "order",
        type: "sum",
        sql: "${orders.amount}",
        time_dimension: "${orders.ordered_on}",
      },
    },
    dimensions: {
      account: { entity: "customer", sql: "${customers.name}" },
      status: { entity: "customer", sql: "${customers.status}" },
      segment: { entity: "customer", sql: "${customers.segment}" },
      order_status: { entity: "order", sql: "${orders.status}" },
      sku: { entity: "order", sql: "${orders.sku}" },
      region: { entity: "customer", sql: "${regions.name}" },
      code: { entity: "order", sql: "${orders.sku}" },
      snap_key: {
        entity: snapEntity,
        sql: snaps === "snapshots" ? "${snapshots.customer_key}" : "${snapshots_unsafe.customer_key}",
      },
    },
    relationships: {
      orders_customers: { from: "orders.account_ref", to: "customers.customer_key", type: "many_to_one" },
      customers_regions: { from: "customers.region_id", to: "regions.region_id", type: "many_to_one" },
      items_orders: { from: "items.order_id", to: "orders.id", type: "many_to_one" },
      items_products: { from: "items.product_id", to: `${products}.product_id`, type: "many_to_one" },
      snapshots_customers: {
        from: `${snapTable}.customer_key`,
        to: "customers.customer_key",
        type: "many_to_one",
      },
    },
  });
}

export function n(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const num = Number(v);
  return Number.isFinite(num) ? num : null;
}

export function civil(v: unknown): string {
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}

export function publicColumns(columns: string[]): string[] {
  return columns.filter((c) => !c.startsWith("__grane_"));
}
