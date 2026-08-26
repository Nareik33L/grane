/**
 * Independent ground truth for the Gauntlet.
 *
 * Two sources, neither of which is Grane:
 *   1. TypeScript reductions over tests/gauntlet/data.ts
 *   2. Reviewed SQL executed against the seeded warehouse
 *
 * Cardinality facts are read off the schema by hand. They are not taken
 * from Grane's relationship graph — that is the thing under test.
 */

import {
  completedOrders,
  CUSTOMERS,
  distinctCompletedCustomerIds,
  ORDER_ITEMS,
  PRODUCT_CATEGORY_MAP,
  refundsTotal,
  revenueByCustomerCountry,
  revenueTotal,
  successfulPaymentsTotal,
} from "./data.js";
import { GAUNTLET_TZ } from "./types.js";

export const GOLD = {
  revenueTotal: revenueTotal(),
  revenueOrphan: completedOrders()
    .filter((o) => o.customer_id == null)
    .reduce((s, o) => s + o.net_amount, 0),
  successfulPayments: successfulPaymentsTotal(),
  refunds: refundsTotal(),
  completedOrderCount: completedOrders().length,
  distinctCustomersWithCompletedOrders: distinctCompletedCustomerIds(),
  customerCount: CUSTOMERS.length,
  revenueGb: revenueByCustomerCountry().get("GB") ?? 0,
  revenueUs: revenueByCustomerCountry().get("US") ?? 0,
  revenueDe: revenueByCustomerCountry().get("DE") ?? 0,
  revenueNullCountry: revenueByCustomerCountry().get(null) ?? 0,
  snapshotBalanceIfSummed: 1000 + 1100 + 900 + 400,
  snapshotLatestTotal: 900 + 400,
  chainFValue: 42,
} as const;

/** Inclusive London-local calendar month of completed revenue. */
export const GOLD_SQL = {
  revenueTotal: `SELECT SUM(net_amount)::DOUBLE AS v FROM orders WHERE status = 'completed'`,
  completedOrderCount: `SELECT COUNT(id)::DOUBLE AS v FROM orders WHERE status = 'completed'`,
  successfulPayments: `SELECT SUM(amount)::DOUBLE AS v FROM payments WHERE status = 'succeeded'`,
  refunds: `SELECT SUM(amount)::DOUBLE AS v FROM refunds`,
  revenueByCustomerCountry: `
    SELECT customers.country AS country, SUM(orders.net_amount)::DOUBLE AS revenue
    FROM orders
    JOIN customers ON orders.customer_id = customers.id
    WHERE orders.status = 'completed'
    GROUP BY 1
  `,
  revenueFebruaryLondon: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
  `,
  revenueJuneLondon: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-06-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-07-01'
  `,
  revenueJulyLondon: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-07-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-08-01'
  `,
  latestSnapshotBalance: `
    SELECT SUM(balance)::DOUBLE AS v FROM daily_account_snapshots s
    WHERE snapshot_date = (SELECT MAX(snapshot_date) FROM daily_account_snapshots s2 WHERE s2.account_id = s.account_id)
  `,
  naiveSnapshotSum: `SELECT SUM(balance)::DOUBLE AS v FROM daily_account_snapshots`,
};

/**
 * Parent → child one-to-many edges of the Gauntlet warehouse, recorded by
 * hand from the seed, not from Grane's graph.
 */
export const ONE_TO_MANY: { parent: string; child: string }[] = [
  { parent: "customers", child: "orders" },
  { parent: "customers", child: "support_tickets" },
  { parent: "customers", child: "sessions" },
  { parent: "customers", child: "experiment_assignments" },
  { parent: "customers", child: "account_members" },
  { parent: "customers", child: "subscriptions" },
  { parent: "accounts", child: "account_members" },
  { parent: "accounts", child: "daily_account_snapshots" },
  { parent: "accounts", child: "invoices" },
  { parent: "orders", child: "order_items" },
  { parent: "orders", child: "payments" },
  { parent: "orders", child: "refunds" },
  { parent: "orders", child: "attribution_events" },
  { parent: "products", child: "order_items" },
  { parent: "products", child: "product_category_map" },
  { parent: "product_categories", child: "product_category_map" },
  { parent: "support_tickets", child: "ticket_tags" },
  { parent: "sessions", child: "checkout_events" },
  { parent: "invoices", child: "invoice_lines" },
  { parent: "payments", child: "payment_attempts" },
  { parent: "subscriptions", child: "subscription_events" },
  { parent: "chain_a", child: "chain_b" },
  { parent: "chain_b", child: "chain_c" },
  { parent: "chain_c", child: "chain_d" },
  { parent: "chain_d", child: "chain_e" },
  { parent: "chain_e", child: "chain_f" },
];

/**
 * Tables that can be reached from `base` without descending a one-to-many
 * edge (walk only child → parent). Independent of Grane's planner.
 */
export function safeTablesFrom(base: string): Set<string> {
  const all = new Set<string>([
    base,
    ...ONE_TO_MANY.flatMap((e) => [e.parent, e.child]),
    "countries",
    "billing_addresses",
    "shipping_addresses",
    "employees",
    "plans",
    "campaigns",
    "experiments",
    "sales_regions",
    "exchange_rates",
  ]);
  const safe = new Set<string>([base]);
  const queue = [base];
  while (queue.length > 0) {
    const table = queue.shift()!;
    for (const edge of ONE_TO_MANY) {
      if (edge.child === table && !safe.has(edge.parent)) {
        safe.add(edge.parent);
        queue.push(edge.parent);
      }
    }
  }
  // Declared one-to-one satellites of orders.
  if (base === "orders") {
    safe.add("billing_addresses");
    safe.add("shipping_addresses");
  }
  if (base === "customers" || base === "billing_addresses" || base === "shipping_addresses") {
    safe.add("countries");
  }
  if (safe.has("customers")) safe.add("countries");
  if (safe.has("billing_addresses")) safe.add("countries");
  if (safe.has("shipping_addresses")) safe.add("countries");
  return new Set([...all].filter((t) => safe.has(t)));
}

/**
 * Hand-reviewed: which governed dimensions are valid slices of each metric.
 * Anything else at that grain must be refused (or proven via pre-aggregation,
 * which V0.1 does not do for dimensions).
 */
export const SAFE_SLICES: Record<string, readonly string[]> = {
  revenue: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  orders: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  ordering_customers: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  average_order_value: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  revenue_per_customer: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  successful_revenue: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  refunded_amount: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  conversion_rate: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  all_orders: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  avg_order_amount: [
    "customer_country",
    "customer_type",
    "channel",
    "order_status",
    "billing_country",
    "shipping_country",
    "completed_at",
    "created_at",
  ],
  customers: ["customer_country", "customer_type"],
  account_balance: ["account_name"],
  inventory: ["product_name", "product_category"],
  chain_value: ["chain_a_label"],
};

export const UNSAFE_SLICES = [
  "product_category",
  "ticket_category",
  "session_browser",
  "experiment_variant",
  "account_name",
  "campaign_name",
  "checkout_error",
  "plan_name",
] as const;

/**
 * Naive many-to-many revenue by mapped product category — the number you get
 * if you join order_items and product_category_map without grain protection.
 * Used only to detect silent double-counting (it must NOT match a Grane result
 * that claimed to answer "revenue by category").
 */
export function naiveM2mCategoryRevenue(): Map<number, number> {
  const byProduct = new Map<number, number>();
  for (const item of ORDER_ITEMS) {
    byProduct.set(item.product_id, (byProduct.get(item.product_id) ?? 0) + item.amount);
  }
  const byCategory = new Map<number, number>();
  for (const link of PRODUCT_CATEGORY_MAP) {
    byCategory.set(link.category_id, (byCategory.get(link.category_id) ?? 0) + (byProduct.get(link.product_id) ?? 0));
  }
  return byCategory;
}

export function tablesMatchScalar(actual: unknown, expected: number, tolerance = 0.005): boolean {
  const n = typeof actual === "number" ? actual : Number(actual);
  if (!Number.isFinite(n)) return false;
  const scale = Math.max(1, Math.abs(expected));
  return Math.abs(n - expected) <= Math.max(tolerance, scale * 1e-9);
}

export { revenueByCustomerCountry, revenueTotal };
