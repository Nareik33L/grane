/**
 * Consistency question set (Release 1 item 5).
 *
 * Each case is one English metric question asked two ways against the same
 * demo shop:
 *
 *   grane   Grane Query Model v1 — the MCP `query` tool's kernel path
 *   rawSql  independently written warehouse SQL (not Grane-compiled SQL,
 *           and not Grane's time.ts). Relative periods are computed in SQL
 *           from max(orders timestamps).
 *
 * `rawSql` is the metric definition, handwritten from demo/analytics YAML
 * and demo/questions.md.
 */
import type { SemanticQueryInput } from "../../src/query/model.js";

export type Expectation =
  /** Grane and independent SQL should return the same cells. */
  | "match"
  /** Grane should refuse with unsafe_query; raw SQL still produces a number. */
  | "grane_refuses"
  /**
   * Both answer. Grane must equal `governedSql` (the metric's actual meaning).
   * Independent SQL answers the English question. They must differ.
   */
  | "mismatch";

export interface ConsistencyQuestion {
  id: string;
  question: string;
  category: string;
  expect: Expectation;
  /** True when the question has no relative period (stable across calendar drift). */
  allTime: boolean;
  note?: string;
  grane: SemanticQueryInput;
  rawSql: string;
  /**
   * Independent SQL for what the Grane query *means* on mismatch questions
   * (e.g. customers created last month). Not used for match / refuse.
   */
  governedSql?: string;
}

/**
 * Warehouse "today": newest order timestamp as a DATE.
 * Used only inside handwritten SQL — not imported from src/query/time.ts.
 */
const ANCHOR = `WITH anchor AS (
  SELECT CAST(max(greatest(created_at, coalesce(completed_at, created_at))) AS DATE) AS today
  FROM orders
)`;

const LAST_MONTH = (col: string) =>
  `${col} >= (SELECT date_trunc('month', today) - INTERVAL '1 month' FROM anchor)
           AND ${col} < (SELECT date_trunc('month', today) FROM anchor)`;

/** Grane 30d is today-29d through today inclusive; exclusive end is tomorrow. */
const LAST_30D = (col: string) =>
  `${col} >= (SELECT CAST(today - INTERVAL '29 days' AS TIMESTAMP) FROM anchor)
           AND ${col} < (SELECT CAST(today + INTERVAL '1 day' AS TIMESTAMP) FROM anchor)`;

const LAST_QUARTER = (col: string) =>
  `${col} >= (SELECT date_trunc('quarter', today) - INTERVAL '3 months' FROM anchor)
           AND ${col} < (SELECT date_trunc('quarter', today) FROM anchor)`;

/** Q2 of this year if that quarter has started; otherwise Q2 of last year. */
const Q2_CTE = `,
q2 AS (
  SELECT CASE
    WHEN EXTRACT(MONTH FROM today) >= 4
    THEN make_date(CAST(EXTRACT(YEAR FROM today) AS INTEGER), 4, 1)
    ELSE make_date(CAST(EXTRACT(YEAR FROM today) AS INTEGER) - 1, 4, 1)
  END AS q2_start
  FROM anchor
)`;

const Q2 = (col: string) =>
  `${col} >= (SELECT CAST(q2_start AS TIMESTAMP) FROM q2)
           AND ${col} < (SELECT CAST(q2_start + INTERVAL '3 months' AS TIMESTAMP) FROM q2)`;

export function buildQuestions(): ConsistencyQuestion[] {
  return [
    {
      id: "revenue_last_month",
      question: "What was Revenue last month?",
      category: "simple",
      expect: "match",
      allTime: false,
      note: "Booked on completed_at, status = completed. Last calendar month in SQL from warehouse max timestamp.",
      grane: { metrics: ["revenue"], time: { period: "last_month" } },
      rawSql: `${ANCHOR}
         SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed' AND ${LAST_MONTH("completed_at")}`,
    },
    {
      id: "orders_completed",
      question: "How many orders did we complete?",
      category: "simple",
      expect: "match",
      allTime: true,
      grane: { metrics: ["orders"] },
      rawSql: `SELECT COUNT(*) AS orders FROM orders WHERE status = 'completed'`,
    },
    {
      id: "average_order_value",
      question: "What is our average order value?",
      category: "simple",
      expect: "match",
      allTime: true,
      note: "Ratio of SUM(net_amount) / COUNT(*) on completed orders, not AVG(net_amount) over every row.",
      grane: { metrics: ["average_order_value"] },
      rawSql: `SELECT CAST(SUM(net_amount) AS DOUBLE PRECISION) / NULLIF(COUNT(*), 0) AS average_order_value
         FROM orders WHERE status = 'completed'`,
    },
    {
      id: "revenue_q2",
      question: "What was Revenue in Q2?",
      category: "time",
      expect: "match",
      allTime: false,
      grane: { metrics: ["revenue"], time: { period: "q2" } },
      rawSql: `${ANCHOR}${Q2_CTE}
         SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed' AND ${Q2("completed_at")}`,
    },
    {
      id: "revenue_last_quarter",
      question: "What was Revenue last quarter?",
      category: "time",
      expect: "match",
      allTime: false,
      grane: { metrics: ["revenue"], time: { period: "last_quarter" } },
      rawSql: `${ANCHOR}
         SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed' AND ${LAST_QUARTER("completed_at")}`,
    },
    {
      id: "revenue_last_30d",
      question: "What was Revenue in the last 30 days?",
      category: "time",
      expect: "match",
      allTime: false,
      grane: { metrics: ["revenue"], time: { period: "30d" } },
      rawSql: `${ANCHOR}
         SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed' AND ${LAST_30D("completed_at")}`,
    },
    {
      id: "revenue_by_country",
      question: "Revenue by country.",
      category: "dimension",
      expect: "match",
      allTime: true,
      grane: { metrics: ["revenue"], dimensions: ["country"] },
      rawSql: `SELECT c.country, SUM(o.net_amount) AS revenue
         FROM orders o JOIN customers c ON o.customer_id = c.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_plan",
      question: "Revenue by customer plan.",
      category: "dimension",
      expect: "match",
      allTime: true,
      grane: { metrics: ["revenue"], dimensions: ["plan"] },
      rawSql: `SELECT c.plan, SUM(o.net_amount) AS revenue
         FROM orders o JOIN customers c ON o.customer_id = c.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_channel_last_month",
      question: "Revenue by sales channel last month.",
      category: "dimension",
      expect: "match",
      allTime: false,
      grane: {
        metrics: ["revenue"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      rawSql: `${ANCHOR}
         SELECT channel, SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed' AND ${LAST_MONTH("completed_at")}
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "payments_received_by_country",
      question: "How much did we collect in succeeded payments, by country?",
      category: "join",
      expect: "match",
      allTime: true,
      note: "Payments are one-to-many from orders; independent SQL pre-aggregates at order grain before joining customers.",
      grane: { metrics: ["payments_received"], dimensions: ["country"] },
      rawSql: `SELECT c.country, SUM(p.value) AS payments_received
         FROM orders o
         JOIN customers c ON o.customer_id = c.id
         LEFT JOIN (
           SELECT order_id, SUM(amount) AS value FROM payments
           WHERE status = 'succeeded' GROUP BY 1
         ) p ON p.order_id = o.id
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_and_payments",
      question: "Show revenue and payments received side by side.",
      category: "join",
      expect: "match",
      allTime: true,
      note: "Independent SQL uses two scalar subqueries so the payment fan-out cannot multiply revenue.",
      grane: { metrics: ["revenue", "payments_received"] },
      rawSql: `SELECT
           (SELECT SUM(net_amount) FROM orders WHERE status = 'completed') AS revenue,
           (SELECT SUM(amount) FROM payments WHERE status = 'succeeded') AS payments_received`,
    },
    {
      id: "customers_total",
      question: "How many customers do we have?",
      category: "definition",
      expect: "match",
      allTime: true,
      note: "A row in customers, whether or not they have ordered.",
      grane: { metrics: ["customers"] },
      rawSql: `SELECT COUNT(*) AS customers FROM customers`,
    },
    {
      id: "customers_ordered_last_month",
      question: "How many customers ordered last month?",
      category: "definition",
      expect: "mismatch",
      allTime: false,
      note:
        "demo/questions.md: not the same question as 'how many customers do we have'. " +
        "Grane's customers metric + last_month filters customers.created_at (governedSql). " +
        "Independent SQL counts distinct customers with a completed order in last_month.",
      grane: { metrics: ["customers"], time: { period: "last_month" } },
      rawSql: `${ANCHOR}
         SELECT COUNT(DISTINCT customer_id) AS customers FROM orders
         WHERE status = 'completed' AND ${LAST_MONTH("completed_at")}`,
      governedSql: `${ANCHOR}
         SELECT COUNT(*) AS customers FROM customers
         WHERE ${LAST_MONTH("created_at")}`,
    },
    {
      id: "revenue_by_product_category",
      question: "Revenue by product category.",
      category: "grain trap",
      expect: "grane_refuses",
      allTime: true,
      note: "Order-grain revenue joined through order_items fans out. Grane must refuse unsafe_query; raw SQL still returns a number.",
      grane: { metrics: ["revenue"], dimensions: ["product_category"] },
      rawSql: `SELECT p.category, SUM(o.net_amount) AS revenue
         FROM orders o
         JOIN order_items oi ON oi.order_id = o.id
         JOIN products p ON p.id = oi.product_id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_ticket_category",
      question: "Revenue by support ticket category.",
      category: "grain trap",
      expect: "grane_refuses",
      allTime: true,
      grane: { metrics: ["revenue"], raw_dimensions: ["support_tickets.category"] },
      rawSql: `SELECT t.category, SUM(o.net_amount) AS revenue
         FROM orders o
         JOIN customers c ON o.customer_id = c.id
         JOIN support_tickets t ON t.customer_id = c.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_checkout_event_type",
      question: "Revenue by checkout event type.",
      category: "grain trap",
      expect: "grane_refuses",
      allTime: true,
      grane: { metrics: ["revenue"], raw_dimensions: ["checkout_events.event_type"] },
      rawSql: `SELECT e.event_type, SUM(o.net_amount) AS revenue
         FROM orders o JOIN checkout_events e ON e.order_id = o.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
  ];
}

export const REFUSE_STATUS = "unsafe_query";

export function allTimeQuestionIds(): string[] {
  return buildQuestions()
    .filter((q) => q.allTime)
    .map((q) => q.id);
}
