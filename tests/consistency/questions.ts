/**
 * Consistency question set (Release 1 item 5).
 *
 * Each case is one English metric question asked two ways against the same
 * demo shop:
 *
 *   grane   Grane Query Model v1 — the MCP `query` tool's kernel path
 *   rawSql  independently written warehouse SQL (not Grane-compiled SQL)
 *
 * `rawSql` is the metric definition, handwritten from demo/analytics YAML
 * and demo/questions.md. It is never copied from compiler output.
 */
import type { SemanticQueryInput } from "../../src/query/model.js";
import { exclusiveEnd, type DateRange } from "../../src/query/time.js";

export type Expectation =
  /** Grane and independent SQL should return the same cells. */
  | "match"
  /** Grane should refuse; raw SQL still produces a (often grain-wrong) number. */
  | "grane_refuses"
  /** Both answer, but they are different questions wearing the same English. */
  | "mismatch";

export interface TimeWindows {
  lastMonth: DateRange;
  last30d: DateRange;
  lastQuarter: DateRange;
  q2: DateRange;
}

export interface ConsistencyQuestion {
  id: string;
  question: string;
  category: string;
  expect: Expectation;
  note?: string;
  grane: SemanticQueryInput;
  rawSql: (time: TimeWindows) => string;
}

function completed(range: DateRange): { from: string; to: string } {
  return { from: range.from, to: exclusiveEnd(range.to) };
}

export function buildQuestions(time: TimeWindows): ConsistencyQuestion[] {
  const lm = completed(time.lastMonth);
  const d30 = completed(time.last30d);
  const lq = completed(time.lastQuarter);
  const q2 = completed(time.q2);

  return [
    {
      id: "revenue_last_month",
      question: "What was Revenue last month?",
      category: "simple",
      expect: "match",
      note: "Booked on completed_at, status = completed. Relative period is last_month.",
      grane: { metrics: ["revenue"], time: { period: "last_month" } },
      rawSql: () =>
        `SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
    },
    {
      id: "orders_completed",
      question: "How many orders did we complete?",
      category: "simple",
      expect: "match",
      grane: { metrics: ["orders"] },
      rawSql: () => `SELECT COUNT(*) AS orders FROM orders WHERE status = 'completed'`,
    },
    {
      id: "average_order_value",
      question: "What is our average order value?",
      category: "simple",
      expect: "match",
      note: "Ratio of SUM(net_amount) / COUNT(*) on completed orders, not AVG(net_amount) over every row.",
      grane: { metrics: ["average_order_value"] },
      rawSql: () =>
        `SELECT CAST(SUM(net_amount) AS DOUBLE PRECISION) / NULLIF(COUNT(*), 0) AS average_order_value
         FROM orders WHERE status = 'completed'`,
    },
    {
      id: "revenue_q2",
      question: "What was Revenue in Q2?",
      category: "time",
      expect: "match",
      grane: { metrics: ["revenue"], time: { period: "q2" } },
      rawSql: () =>
        `SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${q2.from}'::timestamp AND completed_at < '${q2.to}'::timestamp`,
    },
    {
      id: "revenue_last_quarter",
      question: "What was Revenue last quarter?",
      category: "time",
      expect: "match",
      grane: { metrics: ["revenue"], time: { period: "last_quarter" } },
      rawSql: () =>
        `SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${lq.from}'::timestamp AND completed_at < '${lq.to}'::timestamp`,
    },
    {
      id: "revenue_last_30d",
      question: "What was Revenue in the last 30 days?",
      category: "time",
      expect: "match",
      grane: { metrics: ["revenue"], time: { period: "30d" } },
      rawSql: () =>
        `SELECT SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${d30.from}'::timestamp AND completed_at < '${d30.to}'::timestamp`,
    },
    {
      id: "revenue_by_country",
      question: "Revenue by country.",
      category: "dimension",
      expect: "match",
      grane: { metrics: ["revenue"], dimensions: ["country"] },
      rawSql: () =>
        `SELECT c.country, SUM(o.net_amount) AS revenue
         FROM orders o JOIN customers c ON o.customer_id = c.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_plan",
      question: "Revenue by customer plan.",
      category: "dimension",
      expect: "match",
      grane: { metrics: ["revenue"], dimensions: ["plan"] },
      rawSql: () =>
        `SELECT c.plan, SUM(o.net_amount) AS revenue
         FROM orders o JOIN customers c ON o.customer_id = c.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "revenue_by_channel_last_month",
      question: "Revenue by sales channel last month.",
      category: "dimension",
      expect: "match",
      grane: {
        metrics: ["revenue"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      rawSql: () =>
        `SELECT channel, SUM(net_amount) AS revenue FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp
         GROUP BY 1 ORDER BY 2 DESC`,
    },
    {
      id: "payments_received_by_country",
      question: "How much did we collect in succeeded payments, by country?",
      category: "join",
      expect: "match",
      note: "Payments are one-to-many from orders; independent SQL pre-aggregates at order grain before joining customers.",
      grane: { metrics: ["payments_received"], dimensions: ["country"] },
      rawSql: () =>
        `SELECT c.country, SUM(p.value) AS payments_received
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
      note: "Independent SQL uses two scalar subqueries so the payment fan-out cannot multiply revenue.",
      grane: { metrics: ["revenue", "payments_received"] },
      rawSql: () =>
        `SELECT
           (SELECT SUM(net_amount) FROM orders WHERE status = 'completed') AS revenue,
           (SELECT SUM(amount) FROM payments WHERE status = 'succeeded') AS payments_received`,
    },
    {
      id: "customers_total",
      question: "How many customers do we have?",
      category: "definition",
      expect: "match",
      note: "A row in customers, whether or not they have ordered.",
      grane: { metrics: ["customers"] },
      rawSql: () => `SELECT COUNT(*) AS customers FROM customers`,
    },
    {
      id: "customers_ordered_last_month",
      question: "How many customers ordered last month?",
      category: "definition",
      expect: "mismatch",
      note:
        "demo/questions.md: not the same question as 'how many customers do we have'. " +
        "Grane's customers metric + last_month filters customers.created_at. " +
        "Independent SQL counts distinct customers with a completed order in last_month.",
      grane: { metrics: ["customers"], time: { period: "last_month" } },
      rawSql: () =>
        `SELECT COUNT(DISTINCT customer_id) AS customers FROM orders
         WHERE status = 'completed'
           AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
    },
    {
      id: "revenue_by_product_category",
      question: "Revenue by product category.",
      category: "grain trap",
      expect: "grane_refuses",
      note: "Order-grain revenue joined through order_items fans out. Grane should refuse; raw SQL still returns a number.",
      grane: { metrics: ["revenue"], dimensions: ["product_category"] },
      rawSql: () =>
        `SELECT p.category, SUM(o.net_amount) AS revenue
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
      grane: { metrics: ["revenue"], raw_dimensions: ["support_tickets.category"] },
      rawSql: () =>
        `SELECT t.category, SUM(o.net_amount) AS revenue
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
      grane: { metrics: ["revenue"], raw_dimensions: ["checkout_events.event_type"] },
      rawSql: () =>
        `SELECT e.event_type, SUM(o.net_amount) AS revenue
         FROM orders o JOIN checkout_events e ON e.order_id = o.id
         WHERE o.status = 'completed'
         GROUP BY 1 ORDER BY 2 DESC`,
    },
  ];
}
