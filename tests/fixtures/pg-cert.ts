/**
 * Purpose-built PostgreSQL certification fixture (#36).
 *
 * Irregular values so a wrong join, time shift, duplicate multiplication,
 * or civil-date overflow is obvious. Independent oracles are hand-written
 * SQL against these physical tables — never Grane-generated SQL.
 *
 * Relationship fidelity (#17): orders.account_ref → customers.customer_key.
 * customers.id is a colliding surrogate that must not be the join target.
 */
import { graneConfigSchema, type GraneConfig, type ConnectionConfig } from "../../src/config/schema.js";

export const AUG = { from: "2026-08-01", to: "2026-08-31" } as const;
export const AUG_PARTIAL = { from: "2026-08-02", to: "2026-08-31" } as const;
export const JUL_AUG_SPAN = { from: "2026-07-15", to: "2026-08-15" } as const;

function marchDays(year: number, idStart: number, value: number): string {
  return Array.from({ length: 31 }, (_, i) => {
    const day = String(i + 1).padStart(2, "0");
    return `(${idStart + i}, DATE '${year}-03-${day}', ${value})`;
  }).join(", ");
}

/** DDL statements accepted by both PostgreSQL 16 and DuckDB. */
export const PG_CERT_DDL: string[] = [
  `CREATE TABLE regions (
     region_id INTEGER,
     name TEXT
   )`,
  `INSERT INTO regions VALUES
     (1, 'East'),
     (2, 'West'),
     (7, 'EastDupA'),
     (7, 'EastDupB'),
     (99, 'UnusedA'),
     (99, 'UnusedB')`,

  `CREATE TABLE customers (
     id INTEGER,
     customer_key TEXT,
     region_id INTEGER,
     name TEXT,
     status TEXT,
     segment TEXT
   )`,
  // id is the declared entity PK (surrogate). customer_key is the join target.
  // DUP shares customer_key; Ghost has no orders; NullKey has a NULL key.
  `INSERT INTO customers VALUES
     (10, 'A', 1, 'Acme', 'active', 'Enterprise'),
     (20, 'B', 7, 'Beta', 'active', 'Mid-Market'),
     (30, 'C', 2, 'Cedar', 'churned', 'SMB'),
     (40, 'D', 1, 'Delta', 'active', 'Enterprise'),
     (50, 'GHOST', 2, 'Ghost', 'active', 'SMB'),
     (60, NULL, 1, 'NullKey', 'active', 'Enterprise'),
     (70, 'DUP', 1, 'DupA', 'active', 'Enterprise'),
     (80, 'DUP', 1, 'DupB', 'active', 'Enterprise')`,

  `CREATE TABLE orders (
     id INTEGER,
     account_ref TEXT,
     amount NUMERIC(18,2),
     qty INTEGER,
     ordered_on DATE,
     naive_at TIMESTAMP,
     instant_at TIMESTAMPTZ,
     status TEXT,
     sku TEXT
   )`,
  // Inserted A, C, D, B so physical order is not revenue DESC.
  // Aug 1 DATE rows (80+120) prove civil DATE does not shift with timezone.
  // instant_at 03:00 UTC = 2026-07-31 23:00 America/New_York; 04:00 UTC = Aug 1 00:00 NY.
  `INSERT INTO orders VALUES
     (1, 'A', 10.00, 1, DATE '2026-08-15', TIMESTAMP '2026-08-15 12:00:00', TIMESTAMPTZ '2026-08-15 12:00:00+00', 'open', 'A_B'),
     (2, 'C', 50.00, 2, DATE '2026-08-16', TIMESTAMP '2026-08-16 12:00:00', TIMESTAMPTZ '2026-08-16 12:00:00+00', 'open', 'A%B'),
     (3, 'D', 75.00, 3, DATE '2026-08-17', TIMESTAMP '2026-08-17 12:00:00', TIMESTAMPTZ '2026-08-17 12:00:00+00', 'closed', 'plain'),
     (4, 'B', 100.00, 4, DATE '2026-08-18', TIMESTAMP '2026-08-18 12:00:00', TIMESTAMPTZ '2026-08-18 12:00:00+00', 'open', 'ABC'),
     (5, 'A', NULL, 1, DATE '2026-08-19', TIMESTAMP '2026-08-19 12:00:00', TIMESTAMPTZ '2026-08-19 12:00:00+00', 'open', 'nullamt'),
     (6, 'MISSING', 7.00, 1, DATE '2026-08-20', TIMESTAMP '2026-08-20 12:00:00', TIMESTAMPTZ '2026-08-20 12:00:00+00', 'open', 'miss'),
     (7, NULL, 3.00, 1, DATE '2026-08-21', TIMESTAMP '2026-08-21 12:00:00', TIMESTAMPTZ '2026-08-21 12:00:00+00', 'open', 'nullfk'),
     (8, 'A', 1.00, 1, DATE '2026-07-15', TIMESTAMP '2026-07-15 12:00:00', TIMESTAMPTZ '2026-07-15 12:00:00+00', 'pending', 'jul'),
     (9, 'A', 80.00, 1, DATE '2026-08-01', TIMESTAMP '2026-08-01 00:00:00', TIMESTAMPTZ '2026-08-01 03:00:00+00', 'open', 'date_tz'),
     (10, 'A', 120.00, 1, DATE '2026-08-01', TIMESTAMP '2026-08-01 04:00:00', TIMESTAMPTZ '2026-08-01 04:00:00+00', 'open', 'date_tz2'),
     (11, 'DUP', 5.00, 1, DATE '2026-08-22', TIMESTAMP '2026-08-22 12:00:00', TIMESTAMPTZ '2026-08-22 12:00:00+00', 'open', 'dupsku'),
     (12, 'A', 0.00, 0, DATE '2026-08-23', TIMESTAMP '2026-08-23 12:00:00', TIMESTAMPTZ '2026-08-23 12:00:00+00', 'open', 'zero'),
     (13, 'A', 2.00, 1, DATE '2026-08-24', TIMESTAMP '2026-08-24 12:00:00', TIMESTAMPTZ '2026-08-24 12:00:00+00', 'open', 'A\\B'),
     (14, 'A', 4.00, 1, DATE '2026-08-25', TIMESTAMP '2026-08-25 12:00:00', TIMESTAMPTZ '2026-08-25 12:00:00+00', 'open', 'A!B'),
     (15, 'A', 8.00, 1, DATE '2026-08-26', TIMESTAMP '2026-08-26 12:00:00', TIMESTAMPTZ '2026-08-26 12:00:00+00', 'open', 'A''B'),
     (16, 'A', 16.00, 1, DATE '2026-08-27', TIMESTAMP '2026-08-27 12:00:00', TIMESTAMPTZ '2026-08-27 12:00:00+00', 'open', 'café'),
     (17, 'A', 32.00, 1, DATE '2026-08-28', TIMESTAMP '2026-08-28 12:00:00', TIMESTAMPTZ '2026-08-28 12:00:00+00', 'open', ''),
     (18, 'A', 64.00, 1, DATE '2026-08-29', TIMESTAMP '2026-08-29 12:00:00', TIMESTAMPTZ '2026-08-29 12:00:00+00', 'open', 'x''; DROP TABLE orders;--')`,

  `CREATE TABLE snapshots (
     id INTEGER,
     customer_key TEXT,
     month_start DATE,
     ending_mrr NUMERIC(18,2),
     new_mrr NUMERIC(18,2)
   )`,
  `INSERT INTO snapshots VALUES
     (1, 'A', DATE '2026-07-01', 1000.00, 100.00),
     (2, 'A', DATE '2026-08-01', 1100.00, 100.00),
     (3, 'B', DATE '2026-07-01', 200.00, 50.00),
     (4, 'B', DATE '2026-08-01', 250.00, 50.00),
     (5, 'C', DATE '2026-07-01', 30.00, 10.00),
     (6, 'C', DATE '2026-08-01', 40.00, 10.00),
     (7, 'HIST', DATE '2026-06-01', 9.00, 1.00),
     (8, 'HIST', DATE '2026-06-01', 9.00, 1.00),
     (9, 'HIST', DATE '2026-08-01', 10.00, 1.00)`,

  `CREATE TABLE snapshots_unsafe (
     id INTEGER,
     customer_key TEXT,
     month_start DATE,
     ending_mrr NUMERIC(18,2)
   )`,
  `INSERT INTO snapshots_unsafe VALUES
     (1, 'A', DATE '2026-07-01', 1000.00),
     (2, 'A', DATE '2026-08-01', 1100.00),
     (3, 'BAD', DATE '2026-08-01', 1.00),
     (4, 'BAD', DATE '2026-08-01', 2.00)`,

  `CREATE TABLE items (
     id INTEGER,
     order_id INTEGER,
     product_id INTEGER
   )`,
  `INSERT INTO items VALUES
     (1, 1, 10),
     (2, 1, 20),
     (3, 4, 20)`,

  `CREATE TABLE products_safe (
     product_id INTEGER,
     weight NUMERIC(18,2)
   )`,
  `INSERT INTO products_safe VALUES
     (10, 10.00),
     (20, 21.00),
     (99, 8.00),
     (99, 8.00)`,

  `CREATE TABLE products_dup (
     product_id INTEGER,
     weight NUMERIC(18,2)
   )`,
  `INSERT INTO products_dup VALUES
     (10, 10.00),
     (10, 10.00),
     (20, 21.00)`,

  `CREATE TABLE days (
     id INTEGER,
     d DATE,
     x NUMERIC(18,2)
   )`,
  `INSERT INTO days VALUES ${marchDays(2026, 1, 100)}, (32, DATE '2026-02-28', 999), (33, DATE '2026-04-01', 999), (34, DATE '2024-02-29', 888), ${marchDays(2024, 101, 1)}`,

  `CREATE TABLE weeks (
     id INTEGER,
     d DATE,
     x NUMERIC(18,2)
   )`,
  `INSERT INTO weeks VALUES
     (1, DATE '2026-08-29', 1),
     (2, DATE '2026-08-30', 2),
     (3, DATE '2026-08-31', 4),
     (4, DATE '2026-09-01', 8),
     (5, DATE '2026-09-05', 16),
     (6, DATE '2026-09-06', 32),
     (7, DATE '2026-09-07', 64)`,

  `CREATE TABLE types (
     id INTEGER,
     big_n BIGINT,
     dec_n NUMERIC(18,2),
     d DATE,
     ts_naive TIMESTAMP,
     ts_tz TIMESTAMPTZ,
     maybe INTEGER
   )`,
  // 9007199254740993 is above Number.MAX_SAFE_INTEGER — must stay exact.
  `INSERT INTO types VALUES
     (1, 9007199254740993, 12.50, DATE '2026-08-01', TIMESTAMP '2026-08-01 15:30:00', TIMESTAMPTZ '2026-08-01 15:30:00+00', NULL)`,

  `CREATE TABLE ghost (flag BOOLEAN)`,
  `INSERT INTO ghost VALUES (true)`,
];

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
