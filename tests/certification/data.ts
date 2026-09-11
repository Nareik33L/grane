/**
 * Certification corpus seed. Gold numbers are TypeScript reductions over
 * these arrays. DDL is generated per dialect from the column-type map.
 */
import type { CertTable } from "./types.js";

export const AUG = { from: "2026-08-01", to: "2026-08-31" } as const;
export const AUG_PARTIAL = { from: "2026-08-02", to: "2026-08-31" } as const;
export const JUL_AUG_SPAN = { from: "2026-07-15", to: "2026-08-15" } as const;

export const CERT_TABLES: CertTable[] = [
  {
    name: "regions",
    columns: [
      { name: "region_id", type: "integer" },
      { name: "name", type: "text" },
    ],
  },
  {
    name: "customers",
    columns: [
      { name: "id", type: "integer" },
      { name: "customer_key", type: "text" },
      { name: "region_id", type: "integer" },
      { name: "name", type: "text" },
      { name: "status", type: "text" },
      { name: "segment", type: "text" },
    ],
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer" },
      { name: "account_ref", type: "text" },
      { name: "amount", type: "numeric" },
      { name: "qty", type: "integer" },
      { name: "ordered_on", type: "date" },
      { name: "naive_at", type: "timestamp_naive" },
      { name: "instant_at", type: "timestamptz" },
      { name: "status", type: "text" },
      { name: "sku", type: "text" },
    ],
  },
  {
    name: "snapshots",
    columns: [
      { name: "id", type: "integer" },
      { name: "customer_key", type: "text" },
      { name: "month_start", type: "date" },
      { name: "ending_mrr", type: "numeric" },
      { name: "new_mrr", type: "numeric" },
    ],
  },
  {
    name: "snapshots_unsafe",
    columns: [
      { name: "id", type: "integer" },
      { name: "customer_key", type: "text" },
      { name: "month_start", type: "date" },
      { name: "ending_mrr", type: "numeric" },
    ],
  },
  {
    name: "items",
    columns: [
      { name: "id", type: "integer" },
      { name: "order_id", type: "integer" },
      { name: "product_id", type: "integer" },
    ],
  },
  {
    name: "products_safe",
    columns: [
      { name: "product_id", type: "integer" },
      { name: "weight", type: "numeric" },
    ],
  },
  {
    name: "products_dup",
    columns: [
      { name: "product_id", type: "integer" },
      { name: "weight", type: "numeric" },
    ],
  },
  {
    name: "days",
    columns: [
      { name: "id", type: "integer" },
      { name: "d", type: "date" },
      { name: "x", type: "numeric" },
    ],
  },
  {
    name: "weeks",
    columns: [
      { name: "id", type: "integer" },
      { name: "d", type: "date" },
      { name: "x", type: "numeric" },
    ],
  },
  {
    name: "types",
    columns: [
      { name: "id", type: "integer" },
      { name: "big_n", type: "bigint" },
      { name: "dec_n", type: "numeric" },
      { name: "d", type: "date" },
      { name: "ts_naive", type: "timestamp_naive" },
      { name: "ts_tz", type: "timestamptz" },
      { name: "maybe", type: "integer" },
    ],
  },
  {
    name: "ghost",
    columns: [{ name: "flag", type: "boolean" }],
  },
];

export const REGIONS = [
  { region_id: 1, name: "East" },
  { region_id: 2, name: "West" },
  { region_id: 7, name: "EastDupA" },
  { region_id: 7, name: "EastDupB" },
  { region_id: 99, name: "UnusedA" },
  { region_id: 99, name: "UnusedB" },
];

export const CUSTOMERS = [
  { id: 10, customer_key: "A", region_id: 1, name: "Acme", status: "active", segment: "Enterprise" },
  { id: 20, customer_key: "B", region_id: 7, name: "Beta", status: "active", segment: "Mid-Market" },
  { id: 30, customer_key: "C", region_id: 2, name: "Cedar", status: "churned", segment: "SMB" },
  { id: 40, customer_key: "D", region_id: 1, name: "Delta", status: "active", segment: "Enterprise" },
  { id: 50, customer_key: "GHOST", region_id: 2, name: "Ghost", status: "active", segment: "SMB" },
  { id: 60, customer_key: null, region_id: 1, name: "NullKey", status: "active", segment: "Enterprise" },
  { id: 70, customer_key: "DUP", region_id: 1, name: "DupA", status: "active", segment: "Enterprise" },
  { id: 80, customer_key: "DUP", region_id: 1, name: "DupB", status: "active", segment: "Enterprise" },
];

export interface CertOrderRow {
  id: number;
  account_ref: string | null;
  amount: number | null;
  qty: number;
  ordered_on: string;
  naive_at: string;
  instant_at: string;
  status: string;
  sku: string;
}

function order(
  id: number,
  account_ref: string | null,
  amount: number | null,
  qty: number,
  day: string,
  status: string,
  sku: string,
  naiveAt?: string,
  instantAt?: string,
): CertOrderRow {
  const noon = `${day}T12:00:00`;
  return {
    id,
    account_ref,
    amount,
    qty,
    ordered_on: day,
    naive_at: naiveAt ?? noon,
    instant_at: instantAt ?? `${noon}Z`,
    status,
    sku,
  };
}

export const ORDERS: CertOrderRow[] = [
  order(1, "A", 10.0, 1, "2026-08-15", "open", "A_B"),
  order(2, "C", 50.0, 2, "2026-08-16", "open", "A%B"),
  order(3, "D", 75.0, 3, "2026-08-17", "closed", "plain"),
  order(4, "B", 100.0, 4, "2026-08-18", "open", "ABC"),
  order(5, "A", null, 1, "2026-08-19", "open", "nullamt"),
  order(6, "MISSING", 7.0, 1, "2026-08-20", "open", "miss"),
  order(7, null, 3.0, 1, "2026-08-21", "open", "nullfk"),
  order(8, "A", 1.0, 1, "2026-07-15", "pending", "jul"),
  order(9, "A", 80.0, 1, "2026-08-01", "open", "date_tz", "2026-08-01T00:00:00", "2026-08-01T03:00:00Z"),
  order(10, "A", 120.0, 1, "2026-08-01", "open", "date_tz2", "2026-08-01T04:00:00", "2026-08-01T04:00:00Z"),
  order(11, "DUP", 5.0, 1, "2026-08-22", "open", "dupsku"),
  order(12, "A", 0.0, 0, "2026-08-23", "open", "zero"),
  order(13, "A", 2.0, 1, "2026-08-24", "open", "A\\B"),
  order(14, "A", 4.0, 1, "2026-08-25", "open", "A!B"),
  order(15, "A", 8.0, 1, "2026-08-26", "open", "A'B"),
  order(16, "A", 16.0, 1, "2026-08-27", "open", "café"),
  order(17, "A", 32.0, 1, "2026-08-28", "open", ""),
  order(18, "A", 64.0, 1, "2026-08-29", "open", "x'; DROP TABLE orders;--"),
];

export const SNAPSHOTS = [
  { id: 1, customer_key: "A", month_start: "2026-07-01", ending_mrr: 1000.0, new_mrr: 100.0 },
  { id: 2, customer_key: "A", month_start: "2026-08-01", ending_mrr: 1100.0, new_mrr: 100.0 },
  { id: 3, customer_key: "B", month_start: "2026-07-01", ending_mrr: 200.0, new_mrr: 50.0 },
  { id: 4, customer_key: "B", month_start: "2026-08-01", ending_mrr: 250.0, new_mrr: 50.0 },
  { id: 5, customer_key: "C", month_start: "2026-07-01", ending_mrr: 30.0, new_mrr: 10.0 },
  { id: 6, customer_key: "C", month_start: "2026-08-01", ending_mrr: 40.0, new_mrr: 10.0 },
  { id: 7, customer_key: "HIST", month_start: "2026-06-01", ending_mrr: 9.0, new_mrr: 1.0 },
  { id: 8, customer_key: "HIST", month_start: "2026-06-01", ending_mrr: 9.0, new_mrr: 1.0 },
  { id: 9, customer_key: "HIST", month_start: "2026-08-01", ending_mrr: 10.0, new_mrr: 1.0 },
];

export const SNAPSHOTS_UNSAFE = [
  { id: 1, customer_key: "A", month_start: "2026-07-01", ending_mrr: 1000.0 },
  { id: 2, customer_key: "A", month_start: "2026-08-01", ending_mrr: 1100.0 },
  { id: 3, customer_key: "BAD", month_start: "2026-08-01", ending_mrr: 1.0 },
  { id: 4, customer_key: "BAD", month_start: "2026-08-01", ending_mrr: 2.0 },
];

export const ITEMS = [
  { id: 1, order_id: 1, product_id: 10 },
  { id: 2, order_id: 1, product_id: 20 },
  { id: 3, order_id: 4, product_id: 20 },
];

export const PRODUCTS_SAFE = [
  { product_id: 10, weight: 10.0 },
  { product_id: 20, weight: 21.0 },
  { product_id: 99, weight: 8.0 },
  { product_id: 99, weight: 8.0 },
];

export const PRODUCTS_DUP = [
  { product_id: 10, weight: 10.0 },
  { product_id: 10, weight: 10.0 },
  { product_id: 20, weight: 21.0 },
];

function marchDays(year: number, idStart: number, value: number) {
  return Array.from({ length: 31 }, (_, i) => ({
    id: idStart + i,
    d: `${year}-03-${String(i + 1).padStart(2, "0")}`,
    x: value,
  }));
}

export const DAYS = [
  ...marchDays(2026, 1, 100),
  { id: 32, d: "2026-02-28", x: 999 },
  { id: 33, d: "2026-04-01", x: 999 },
  { id: 34, d: "2024-02-29", x: 888 },
  ...marchDays(2024, 101, 1),
];

export const WEEKS = [
  { id: 1, d: "2026-08-29", x: 1 },
  { id: 2, d: "2026-08-30", x: 2 },
  { id: 3, d: "2026-08-31", x: 4 },
  { id: 4, d: "2026-09-01", x: 8 },
  { id: 5, d: "2026-09-05", x: 16 },
  { id: 6, d: "2026-09-06", x: 32 },
  { id: 7, d: "2026-09-07", x: 64 },
];

export const TYPES = [
  {
    id: 1,
    big_n: 9007199254740993n,
    dec_n: 12.5,
    d: "2026-08-01",
    ts_naive: "2026-08-01T15:30:00",
    ts_tz: "2026-08-01T15:30:00Z",
    maybe: null,
  },
];

export const GHOST = [{ flag: true }];

export const SEED: Record<string, Array<Record<string, unknown>>> = {
  regions: REGIONS,
  customers: CUSTOMERS,
  orders: ORDERS,
  snapshots: SNAPSHOTS,
  snapshots_unsafe: SNAPSHOTS_UNSAFE,
  items: ITEMS,
  products_safe: PRODUCTS_SAFE,
  products_dup: PRODUCTS_DUP,
  days: DAYS,
  weeks: WEEKS,
  types: TYPES,
  ghost: GHOST,
};

export const SEED_COUNTS = {
  customers: CUSTOMERS.length,
  orders: ORDERS.length,
  snapshots: SNAPSHOTS.length,
  regions: REGIONS.length,
  items: ITEMS.length,
  products_safe: PRODUCTS_SAFE.length,
  days: DAYS.length,
  weeks: WEEKS.length,
  types: TYPES.length,
} as const;
