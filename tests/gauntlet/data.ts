/**
 * Mathematically constructed Gauntlet warehouse rows.
 *
 * Gold numbers are derived from these arrays in TypeScript, then checked
 * again by independent SQL against the loaded DuckDB. Grane is scored
 * against those two sources, never against itself.
 */

export interface CustomerRow {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  password_hash: string | null;
  ip_address: string | null;
  date_of_birth: string | null;
  country: string | null;
  country_id: number | null;
  customer_type: string;
  created_at: string;
  deleted_at: string | null;
}

export interface OrderRow {
  id: number;
  customer_id: number | null;
  status: string;
  channel: string;
  net_amount: number;
  currency: string;
  discount_code: string | null;
  device_type: string;
  created_at: string;
  updated_at: string;
  paid_at: string | null;
  settled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  refunded_at: string | null;
}

export const COUNTRIES = [
  { id: 1, code: "GB", name: "United Kingdom" },
  { id: 2, code: "US", name: "United States" },
  { id: 3, code: "DE", name: "Germany" },
  { id: 4, code: "FR", name: "France" },
  { id: 5, code: "IE", name: "Ireland" },
] as const;

export const CUSTOMERS: CustomerRow[] = [
  {
    id: 1,
    name: "Alice",
    email: "alice@secret.example",
    phone: "+441111",
    password_hash: "hash_alice",
    ip_address: "1.1.1.1",
    date_of_birth: "1990-01-01",
    country: "GB",
    country_id: 1,
    customer_type: "consumer",
    created_at: "2023-01-01T00:00:00Z",
    deleted_at: null,
  },
  {
    id: 2,
    name: "Bob",
    email: "bob@secret.example",
    phone: "+442222",
    password_hash: "hash_bob",
    ip_address: "2.2.2.2",
    date_of_birth: "1985-06-15",
    country: "US",
    country_id: 2,
    customer_type: "business",
    created_at: "2023-02-01T00:00:00Z",
    deleted_at: null,
  },
  {
    id: 3,
    name: "Cara",
    email: "cara@secret.example",
    phone: "+443333",
    password_hash: "hash_cara",
    ip_address: "3.3.3.3",
    date_of_birth: "1992-12-25",
    country: "GB",
    country_id: 1,
    customer_type: "consumer",
    created_at: "2023-03-01T00:00:00Z",
    deleted_at: null,
  },
  {
    id: 4,
    name: "Dana",
    email: "dana@secret.example",
    phone: "+444444",
    password_hash: "hash_dana",
    ip_address: "4.4.4.4",
    date_of_birth: "1988-07-07",
    country: "DE",
    country_id: 3,
    customer_type: "consumer",
    created_at: "2023-04-01T00:00:00Z",
    deleted_at: "2024-02-01T00:00:00Z",
  },
  {
    id: 5,
    name: "Eve",
    email: null,
    phone: null,
    password_hash: "hash_eve",
    ip_address: null,
    date_of_birth: null,
    country: null,
    country_id: null,
    customer_type: "consumer",
    created_at: "2023-05-01T00:00:00Z",
    deleted_at: null,
  },
];

/** Completed-order amounts are the Revenue contract: status = completed. */
export const ORDERS: OrderRow[] = [
  order(1, 1, "completed", "web", 100, "GBP", "SPRING", "chrome", "2024-01-15T12:00:00Z"),
  order(2, 1, "completed", "web", 50, "GBP", null, "chrome", "2024-02-15T12:00:00Z"),
  order(3, 2, "completed", "mobile", 200, "USD", "SAVE", "safari", "2024-01-20T12:00:00Z"),
  order(4, 2, "pending", "web", 999, "USD", null, "chrome", "2024-01-21T12:00:00Z"),
  order(5, 3, "completed", "web", 75, "GBP", "SPRING", "firefox", "2024-03-10T12:00:00Z"),
  order(6, 4, "completed", "web", 30, "EUR", null, "chrome", "2024-01-10T12:00:00Z"),
  order(7, 1, "completed", "web", 25, "GBP", null, "chrome", "2024-02-29T12:00:00Z"),
  {
    ...order(8, 1, "cancelled", "web", 40, "GBP", null, "chrome", null),
    created_at: "2024-01-31T23:00:00Z",
    cancelled_at: "2024-01-31T23:59:59Z",
  },
  order(9, 1, "completed", "web", 10, "GBP", null, "chrome", "2023-12-31T23:59:59Z"),
  order(10, 2, "completed", "web", 0, "USD", null, "chrome", "2024-02-01T12:00:00Z"),
  order(11, 2, "completed", "web", -15, "USD", null, "chrome", "2024-02-02T12:00:00Z"),
  order(12, null, "completed", "web", 8, "GBP", null, "chrome", "2024-02-03T12:00:00Z"),
  order(14, 5, "completed", "web", 12.5, "GBP", null, "chrome", "2024-02-05T12:00:00Z"),
  // 23:30 UTC on 30 June is 00:30 BST 1 July in Europe/London.
  order(15, 1, "completed", "web", 7, "GBP", null, "chrome", "2024-06-30T23:30:00Z"),
  // UK clocks forward 31 March 2024 01:00 GMT → 02:00 BST (23-hour day).
  order(16, 1, "completed", "web", 3, "GBP", null, "chrome", "2024-03-31T00:45:00Z"),
  // UK clocks back 27 October 2024 02:00 BST → 01:00 GMT (25-hour day).
  order(17, 1, "completed", "web", 4, "GBP", null, "chrome", "2024-10-27T01:30:00Z"),
];

function order(
  id: number,
  customer_id: number | null,
  status: string,
  channel: string,
  net_amount: number,
  currency: string,
  discount_code: string | null,
  device_type: string,
  completed_at: string | null,
): OrderRow {
  const created = completed_at ?? "2024-01-01T00:00:00Z";
  return {
    id,
    customer_id,
    status,
    channel,
    net_amount,
    currency,
    discount_code,
    device_type,
    created_at: created,
    updated_at: created,
    paid_at: status === "completed" ? completed_at : null,
    settled_at: status === "completed" ? completed_at : null,
    completed_at,
    cancelled_at: null,
    refunded_at: null,
  };
}

export const BILLING_ADDRESSES = [
  { id: 1, order_id: 1, country: "US", country_id: 2 },
  { id: 2, order_id: 2, country: "GB", country_id: 1 },
  { id: 3, order_id: 3, country: "US", country_id: 2 },
  { id: 4, order_id: 5, country: "IE", country_id: 5 },
  { id: 5, order_id: 6, country: "DE", country_id: 3 },
  { id: 6, order_id: 7, country: "GB", country_id: 1 },
  { id: 7, order_id: 9, country: "GB", country_id: 1 },
  { id: 8, order_id: 10, country: "US", country_id: 2 },
  { id: 9, order_id: 11, country: "US", country_id: 2 },
  { id: 10, order_id: 12, country: "GB", country_id: 1 },
  { id: 11, order_id: 14, country: "GB", country_id: 1 },
  { id: 12, order_id: 15, country: "GB", country_id: 1 },
  { id: 13, order_id: 16, country: "GB", country_id: 1 },
  { id: 14, order_id: 17, country: "GB", country_id: 1 },
];

export const SHIPPING_ADDRESSES = [
  { id: 1, order_id: 1, country: "FR", country_id: 4 },
  { id: 2, order_id: 2, country: "GB", country_id: 1 },
  { id: 3, order_id: 3, country: "US", country_id: 2 },
  { id: 4, order_id: 5, country: "FR", country_id: 4 },
  { id: 5, order_id: 6, country: "DE", country_id: 3 },
  { id: 6, order_id: 7, country: "GB", country_id: 1 },
];

export const PRODUCTS = [
  { id: 1, name: "Gadget", category: "Electronics", inventory_level: 50 },
  { id: 2, name: "Shirt", category: "Clothing", inventory_level: 10 },
  { id: 3, name: "Cable", category: "Electronics", inventory_level: 200 },
];

export const PRODUCT_CATEGORIES = [
  { id: 1, name: "Electronics" },
  { id: 2, name: "Gadgets" },
  { id: 3, name: "Clothing" },
];

/** Product 1 is in TWO categories — the many-to-many fan-out trap. */
export const PRODUCT_CATEGORY_MAP = [
  { product_id: 1, category_id: 1 },
  { product_id: 1, category_id: 2 },
  { product_id: 2, category_id: 3 },
  { product_id: 3, category_id: 1 },
];

export const ORDER_ITEMS = [
  { id: 1, order_id: 1, product_id: 1, quantity: 1, amount: 60 },
  { id: 2, order_id: 1, product_id: 2, quantity: 2, amount: 40 },
  { id: 3, order_id: 2, product_id: 1, quantity: 1, amount: 50 },
  { id: 4, order_id: 3, product_id: 1, quantity: 1, amount: 100 },
  { id: 5, order_id: 3, product_id: 3, quantity: 2, amount: 50 },
  { id: 6, order_id: 3, product_id: 2, quantity: 1, amount: 50 },
  { id: 7, order_id: 5, product_id: 2, quantity: 1, amount: 75 },
  { id: 8, order_id: 7, product_id: 3, quantity: 1, amount: 25 },
];

export const PAYMENTS = [
  { id: 1, order_id: 1, amount: 60, status: "succeeded", card_fingerprint: "fp_alice", country: "IE" },
  { id: 2, order_id: 1, amount: 40, status: "succeeded", card_fingerprint: "fp_alice", country: "IE" },
  { id: 3, order_id: 3, amount: 200, status: "succeeded", card_fingerprint: "fp_bob", country: "US" },
  { id: 4, order_id: 3, amount: 200, status: "failed", card_fingerprint: "fp_bob", country: "US" },
  { id: 5, order_id: 5, amount: 75, status: "succeeded", card_fingerprint: "fp_cara", country: "GB" },
  { id: 6, order_id: 6, amount: 30, status: "succeeded", card_fingerprint: "fp_dana", country: "DE" },
];

export const PAYMENT_ATTEMPTS = [
  { id: 1, payment_id: 1, attempt: 1, status: "succeeded" },
  { id: 2, payment_id: 3, attempt: 1, status: "failed" },
  { id: 3, payment_id: 3, attempt: 2, status: "succeeded" },
];

export const REFUNDS = [
  { id: 1, order_id: 3, amount: 20, refunded_at: "2024-01-25T12:00:00Z" },
];

export const ACCOUNTS = [
  { id: 1, name: "Acme", country: "US" },
  { id: 2, name: "Globex", country: "GB" },
  { id: 3, name: "Initech", country: "DE" },
  { id: 4, name: "ClosedCo", country: "JP" },
  { id: 5, name: "NullCo", country: "US" },
  { id: 6, name: "TwinCo", country: "GB" },
  { id: 7, name: "DstCo", country: "IE" },
];

/** Alice sits in two accounts — metrics across the bridge must not double-count. */
export const ACCOUNT_MEMBERS = [
  { account_id: 1, customer_id: 1, role: "member" },
  { account_id: 1, customer_id: 2, role: "admin" },
  { account_id: 2, customer_id: 1, role: "member" },
  { account_id: 2, customer_id: 3, role: "admin" },
];

export const SUPPORT_TICKETS = [
  { id: 1, customer_id: 1, category: "billing", created_at: "2024-01-16T12:00:00Z" },
  { id: 2, customer_id: 1, category: "shipping", created_at: "2024-02-16T12:00:00Z" },
  { id: 3, customer_id: 2, category: "bug", created_at: "2024-01-22T12:00:00Z" },
  { id: 4, customer_id: 3, category: "billing", created_at: "2024-03-11T12:00:00Z" },
];

export const TICKET_TAGS = [
  { ticket_id: 1, tag: "urgent" },
  { ticket_id: 1, tag: "refunds" },
  { ticket_id: 3, tag: "urgent" },
];

export const SESSIONS = [
  { id: 1, customer_id: 1, browser: "chrome", started_at: "2024-01-15T11:00:00Z" },
  { id: 2, customer_id: 1, browser: "firefox", started_at: "2024-01-15T11:30:00Z" },
  { id: 3, customer_id: 1, browser: "chrome", started_at: "2024-02-15T11:00:00Z" },
  { id: 4, customer_id: 2, browser: "safari", started_at: "2024-01-20T11:00:00Z" },
];

export const CHECKOUT_EVENTS = [
  { id: 1, session_id: 1, order_id: 1, error: null, event_at: "2024-01-15T11:50:00Z" },
  { id: 2, session_id: 1, order_id: null, error: "card_declined", event_at: "2024-01-15T11:40:00Z" },
  { id: 3, session_id: 4, order_id: 3, error: null, event_at: "2024-01-20T11:50:00Z" },
];

export const EXPERIMENTS = [{ id: 1, name: "checkout_v2" }];

export const EXPERIMENT_ASSIGNMENTS = [
  { experiment_id: 1, customer_id: 1, variant: "control" },
  { experiment_id: 1, customer_id: 2, variant: "treatment" },
  { experiment_id: 1, customer_id: 3, variant: "control" },
  // Duplicate assignment — dirty data.
  { experiment_id: 1, customer_id: 1, variant: "treatment" },
];

export const CAMPAIGNS = [
  { id: 1, name: "spring" },
  { id: 2, name: "brand" },
];

export const ATTRIBUTION_EVENTS = [
  { id: 1, order_id: 1, campaign_id: 1, position: 1 },
  { id: 2, order_id: 1, campaign_id: 2, position: 2 },
  { id: 3, order_id: 5, campaign_id: 1, position: 1 },
];

export const EMPLOYEES = [
  { id: 1, name: "Finance Fran", department: "finance", salary: 85000 },
  { id: 2, name: "Ops Omar", department: "ops", salary: 42000 },
];

export const PLANS = [
  { id: 1, name: "pro", monthly_amount: 49 },
  { id: 2, name: "basic", monthly_amount: 9 },
];

export const SUBSCRIPTIONS = [
  { id: 1, customer_id: 2, plan_id: 1, status: "active", started_at: "2023-06-01T00:00:00Z" },
  { id: 2, customer_id: 3, plan_id: 2, status: "cancelled", started_at: "2023-07-01T00:00:00Z" },
];

export const SUBSCRIPTION_EVENTS = [
  { id: 1, subscription_id: 1, kind: "created", event_at: "2023-06-01T00:00:00Z" },
  { id: 2, subscription_id: 2, kind: "cancelled", event_at: "2024-01-01T00:00:00Z" },
];

export const INVOICES = [
  { id: 1, account_id: 1, total: 200, issued_at: "2024-01-21T00:00:00Z" },
];

export const INVOICE_LINES = [
  { id: 1, invoice_id: 1, amount: 150 },
  { id: 2, invoice_id: 1, amount: 50 },
];

export const EXCHANGE_RATES = [
  { date: "2024-01-15", from_currency: "GBP", to_currency: "GBP", rate: 1 },
  { date: "2024-01-15", from_currency: "USD", to_currency: "GBP", rate: 0.79 },
  { date: "2024-01-15", from_currency: "EUR", to_currency: "GBP", rate: 0.85 },
  { date: "2024-01-20", from_currency: "USD", to_currency: "GBP", rate: 0.8 },
  { date: "2024-01-20", from_currency: "USD", to_currency: "GBP", rate: 0.81 }, // duplicate date — dirty
];

export interface SnapshotRow {
  account_id: number;
  snapshot_date: string;
  balance: number | null;
}

/**
 * Pathological last-as-of fixture.
 *
 * 1 Acme: history through 15 Mar 2024 (last 900). Leap-day row on 29 Feb.
 * 2 Globex: gap from 31 Jan to 15 Mar (missing February).
 * 3 Initech: created mid-March; first snapshot 10 Mar.
 * 4 ClosedCo: last snapshot 28 Feb; no March row (entity gone).
 * 5 NullCo: last snapshot balance is NULL.
 * 6 TwinCo: two rows on the same civil date (dirty intra-day).
 * 7 DstCo: UK DST spring (31 Mar) and autumn (27 Oct) civil dates.
 */
export const DAILY_ACCOUNT_SNAPSHOTS: SnapshotRow[] = [
  { account_id: 1, snapshot_date: "2024-02-01", balance: 800 },
  { account_id: 1, snapshot_date: "2024-02-29", balance: 850 },
  { account_id: 1, snapshot_date: "2024-03-01", balance: 1000 },
  { account_id: 1, snapshot_date: "2024-03-02", balance: 1100 },
  { account_id: 1, snapshot_date: "2024-03-15", balance: 900 },
  { account_id: 2, snapshot_date: "2024-01-31", balance: 350 },
  { account_id: 2, snapshot_date: "2024-03-15", balance: 400 },
  { account_id: 3, snapshot_date: "2024-03-10", balance: 50 },
  { account_id: 3, snapshot_date: "2024-03-15", balance: 75 },
  { account_id: 4, snapshot_date: "2024-02-28", balance: 200 },
  { account_id: 5, snapshot_date: "2024-03-01", balance: 10 },
  { account_id: 5, snapshot_date: "2024-03-15", balance: null },
  { account_id: 6, snapshot_date: "2024-03-15", balance: 30 },
  { account_id: 6, snapshot_date: "2024-03-15", balance: 70 },
  { account_id: 7, snapshot_date: "2024-03-30", balance: 100 },
  { account_id: 7, snapshot_date: "2024-03-31", balance: 110 },
  { account_id: 7, snapshot_date: "2024-10-26", balance: 120 },
  { account_id: 7, snapshot_date: "2024-10-27", balance: 130 },
];

/** Last snapshot date on or before `asOf` (inclusive YYYY-MM-DD). */
export function lastAsOfPerAccount(
  asOf: string,
  windowFrom?: string,
): Map<number, { date: string; balance: number | null }> {
  const byAccount = new Map<number, SnapshotRow[]>();
  for (const row of DAILY_ACCOUNT_SNAPSHOTS) {
    if (row.snapshot_date > asOf) continue;
    if (windowFrom && row.snapshot_date < windowFrom) continue;
    const list = byAccount.get(row.account_id) ?? [];
    list.push(row);
    byAccount.set(row.account_id, list);
  }
  const out = new Map<number, { date: string; balance: number | null }>();
  for (const [id, rows] of byAccount) {
    const maxDate = rows.reduce((latest, row) => (row.snapshot_date > latest ? row.snapshot_date : latest), "");
    const atMax = rows.filter((row) => row.snapshot_date === maxDate);
    const numeric = atMax.filter((row) => row.balance != null).map((row) => row.balance as number);
    out.set(id, { date: maxDate, balance: numeric.length === 0 ? null : sum(numeric) });
  }
  return out;
}

/** SUM of last-as-of balances; NULL last snapshots do not contribute. */
export function lastAsOfTotal(asOf: string, windowFrom?: string): number {
  let total = 0;
  for (const row of lastAsOfPerAccount(asOf, windowFrom).values()) {
    if (row.balance != null) total += row.balance;
  }
  return total;
}

export function lastAsOfByAccountName(asOf: string, windowFrom?: string): Map<string, number | null> {
  const names = new Map(ACCOUNTS.map((a) => [a.id, a.name]));
  const out = new Map<string, number | null>();
  for (const [id, row] of lastAsOfPerAccount(asOf, windowFrom)) {
    const name = names.get(id);
    if (!name) continue;
    out.set(name, row.balance);
  }
  return out;
}

export const SALES_REGIONS = [
  { country: "GB", region: "EMEA" },
  { country: "US", region: "AMER" },
  { country: "DE", region: "EMEA" },
  { country: "FR", region: "EMEA" },
  { country: "IE", region: "EMEA" },
];

/** Deep many-to-one chain A←B←C←D←E←F. One row each; F.value = 42. */
export const CHAIN_A = [{ id: 1, label: "a" }];
export const CHAIN_B = [{ id: 1, a_id: 1, label: "b" }];
export const CHAIN_C = [{ id: 1, b_id: 1, label: "c" }];
export const CHAIN_D = [{ id: 1, c_id: 1, label: "d" }];
export const CHAIN_E = [{ id: 1, d_id: 1, label: "e" }];
export const CHAIN_F = [{ id: 1, e_id: 1, value: 42 }];

/** Circular A→B→C→A. */
export const CYCLE_A = [{ id: 1, b_id: 1 }];
export const CYCLE_B = [{ id: 1, c_id: 1 }];
export const CYCLE_C = [{ id: 1, a_id: 1 }];

export const BLOCKED_COLUMNS = [
  "customers.email",
  "customers.phone",
  "customers.password_hash",
  "customers.ip_address",
  "customers.date_of_birth",
  "payments.card_fingerprint",
  "employees.salary",
] as const;

export function completedOrders(): OrderRow[] {
  return ORDERS.filter((o) => o.status === "completed");
}

export function sum(values: number[]): number {
  return values.reduce((acc, n) => acc + n, 0);
}

export function revenueTotal(): number {
  return sum(completedOrders().map((o) => o.net_amount));
}

export function customerById(id: number): CustomerRow | undefined {
  return CUSTOMERS.find((c) => c.id === id);
}

export function revenueByCustomerCountry(): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const o of completedOrders()) {
    if (o.customer_id == null) continue;
    const country = customerById(o.customer_id)?.country ?? null;
    out.set(country, (out.get(country) ?? 0) + o.net_amount);
  }
  return out;
}

export function successfulPaymentsTotal(): number {
  return sum(PAYMENTS.filter((p) => p.status === "succeeded").map((p) => p.amount));
}

export function refundsTotal(): number {
  return sum(REFUNDS.map((r) => r.amount));
}

export function distinctCompletedCustomerIds(): number {
  return new Set(completedOrders().map((o) => o.customer_id).filter((id): id is number => id != null))
    .size;
}
