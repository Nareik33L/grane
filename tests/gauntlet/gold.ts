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
  DAILY_ACCOUNT_SNAPSHOTS,
  distinctCompletedCustomerIds,
  lastAsOfTotal,
  ORDER_ITEMS,
  PRODUCT_CATEGORY_MAP,
  refundsTotal,
  revenueByCustomerCountry,
  revenueTotal,
  successfulPaymentsTotal,
} from "./data.js";
import { GAUNTLET_TZ } from "./types.js";

/** Independent last-as-of SQL: last civil date on or before `asOf`, optionally inside `[from, asOf]`. */
export function lastAsOfSql(asOf: string, windowFrom?: string): string {
  const upper = asOf === "9999-12-31" ? "" : ` AND s2.snapshot_date <= DATE '${asOf}'`;
  const window = windowFrom ? ` AND s2.snapshot_date >= DATE '${windowFrom}'` : "";
  const outerUpper = asOf === "9999-12-31" ? "" : ` AND s.snapshot_date <= DATE '${asOf}'`;
  const outerWindow = windowFrom ? ` AND s.snapshot_date >= DATE '${windowFrom}'` : "";
  return `
    SELECT SUM(s.balance)::DOUBLE AS v
    FROM daily_account_snapshots s
    WHERE s.snapshot_date = (
      SELECT MAX(s2.snapshot_date) FROM daily_account_snapshots s2
      WHERE s2.account_id = s.account_id${upper}${window}
    )${outerUpper}${outerWindow}
  `;
}

export function lastAsOfByAccountSql(asOf: string, windowFrom?: string): string {
  const upper = asOf === "9999-12-31" ? "" : ` AND s2.snapshot_date <= DATE '${asOf}'`;
  const window = windowFrom ? ` AND s2.snapshot_date >= DATE '${windowFrom}'` : "";
  const outerUpper = asOf === "9999-12-31" ? "" : ` AND s.snapshot_date <= DATE '${asOf}'`;
  const outerWindow = windowFrom ? ` AND s.snapshot_date >= DATE '${windowFrom}'` : "";
  return `
    SELECT a.name AS account_name, SUM(s.balance)::DOUBLE AS account_balance
    FROM daily_account_snapshots s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.snapshot_date = (
      SELECT MAX(s2.snapshot_date) FROM daily_account_snapshots s2
      WHERE s2.account_id = s.account_id${upper}${window}
    )${outerUpper}${outerWindow}
    GROUP BY 1
  `;
}

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
  snapshotBalanceIfSummed: DAILY_ACCOUNT_SNAPSHOTS.reduce((s, r) => s + (r.balance ?? 0), 0),
  snapshotLatestTotal: lastAsOfTotal("9999-12-31"),
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
  latestSnapshotBalance: lastAsOfSql("9999-12-31"),
  naiveSnapshotSum: `SELECT SUM(balance)::DOUBLE AS v FROM daily_account_snapshots`,
  snapshotAsOfMar1: lastAsOfSql("2024-03-01"),
  snapshotAsOfMar14: lastAsOfSql("2024-03-14"),
  snapshotAsOfMar15: lastAsOfSql("2024-03-15"),
  snapshotLastMonthCarry: lastAsOfSql("2024-02-29"),
  snapshotLastMonthInWindow: lastAsOfSql("2024-02-29", "2024-02-01"),
  snapshotEmptyYear: lastAsOfSql("2020-12-31"),
  snapshotDstSpring: lastAsOfSql("2024-03-31"),
  snapshotDstAutumn: lastAsOfSql("2024-10-27"),
  snapshotByAccountLatest: lastAsOfByAccountSql("9999-12-31"),
  snapshotByAccountAsOfMar14: lastAsOfByAccountSql("2024-03-14"),
  snapshotAcmeLatest: `
    SELECT SUM(s.balance)::DOUBLE AS v
    FROM daily_account_snapshots s
    JOIN accounts a ON a.id = s.account_id
    WHERE a.name = 'Acme'
      AND s.snapshot_date = (
        SELECT MAX(s2.snapshot_date) FROM daily_account_snapshots s2 WHERE s2.account_id = s.account_id
      )
  `,
  snapshotTwinCoLatest: `
    SELECT SUM(s.balance)::DOUBLE AS v
    FROM daily_account_snapshots s
    JOIN accounts a ON a.id = s.account_id
    WHERE a.name = 'TwinCo'
      AND s.snapshot_date = (
        SELECT MAX(s2.snapshot_date) FROM daily_account_snapshots s2 WHERE s2.account_id = s.account_id
      )
  `,
  snapshotRawCountryLatest: `
    SELECT a.country AS country, SUM(s.balance)::DOUBLE AS account_balance
    FROM daily_account_snapshots s
    JOIN accounts a ON a.id = s.account_id
    WHERE s.snapshot_date = (
      SELECT MAX(s2.snapshot_date) FROM daily_account_snapshots s2 WHERE s2.account_id = s.account_id
    )
    GROUP BY 1
  `,
  revenueFebruaryWebGb: `
    SELECT SUM(o.net_amount)::DOUBLE AS v
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE o.status = 'completed'
      AND o.channel = 'web'
      AND c.country = 'GB'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
  `,
  aovFebruary: `
    SELECT (
      SUM(net_amount) FILTER (
        WHERE status = 'completed'
          AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
          AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
      )::DOUBLE
      / NULLIF(
        COUNT(id) FILTER (
          WHERE status = 'completed'
            AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
            AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
        ),
        0
      )
    ) AS v
    FROM orders
  `,
  conversionLastMonthByChannel: `
    SELECT channel,
      (
        COUNT(id) FILTER (
          WHERE status = 'completed'
            AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
            AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
        )::DOUBLE
        / NULLIF(
          COUNT(id) FILTER (
            WHERE (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
              AND (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
          ),
          0
        )
      ) AS conversion_rate
    FROM orders
    GROUP BY 1
  `,
  revenueFebruaryByCountry: `
    SELECT c.country AS customer_country, SUM(o.net_amount)::DOUBLE AS revenue
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE o.status = 'completed'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
    GROUP BY 1
  `,
  revenueFebruaryDiscount: `
    SELECT o.discount_code AS discount_code, SUM(o.net_amount)::DOUBLE AS revenue
    FROM orders o
    WHERE o.status = 'completed'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
    GROUP BY 1
  `,
  revenueThisFiscalYearByType: `
    SELECT c.customer_type AS customer_type, SUM(o.net_amount)::DOUBLE AS revenue
    FROM orders o
    JOIN customers c ON o.customer_id = c.id
    WHERE o.status = 'completed'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2023-04-01'
      AND (o.completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-16'
    GROUP BY 1
  `,
  revenueFebruaryCreatedAt: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
      AND (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
  `,
  conversionLastMonth: `
    SELECT (
      COUNT(id) FILTER (
        WHERE status = 'completed'
          AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
          AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
      )::DOUBLE
      / NULLIF(
        COUNT(id) FILTER (
          WHERE (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-02-01'
            AND (created_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-01'
        ),
        0
      )
    ) AS v
    FROM orders
  `,
  revenueThisFiscalYear: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2023-04-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-16'
  `,
  revenueThisWeekMonday: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-03-11'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-16'
  `,
  revenueThisWeekSunday: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-03-10'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-16'
  `,
  revenueLastWeekMonday: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-03-04'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-11'
  `,
  revenueLastWeekSunday: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-03-03'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-10'
  `,
  revenueThisQuarter: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2024-01-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-03-16'
  `,
  revenueLastQuarter: `
    SELECT SUM(net_amount)::DOUBLE AS v FROM orders
    WHERE status = 'completed'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') >= TIMESTAMP '2023-10-01'
      AND (completed_at::timestamptz AT TIME ZONE '${GAUNTLET_TZ}') < TIMESTAMP '2024-01-01'
  `,
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
