import type { SemanticQueryInput, TrustLevel } from "../../src/query/model.js";
import { exclusiveEnd, type BenchTime } from "./harness.js";

/**
 * The question set. Every case carries, for the same business question:
 *
 *   gold   independently reviewed DuckDB SQL producing the correct answer
 *          (null when no correct single answer exists and the right move is
 *          to refuse)
 *   pathA  the SQL an unconstrained agent with a database MCP tends to emit
 *   pathB  the SQL a model writes after reading tests/benchmark/SKILL.md
 *   pathC  a Grane Query Model v1 request
 *
 * Path A and path B are fixtures, not model output: the benchmark must be
 * deterministic and must not call an LLM.
 */

export type Category =
  | "simple metric"
  | "time period"
  | "dimension"
  | "join"
  | "fan-out"
  | "grain trap"
  | "ambiguous definition"
  | "undefined metric"
  | "unsafe join"
  | "raw exploration"
  | "mixed trust";

/** A handwritten path: either SQL, or a documented refusal to answer. */
export type Attempt = { sql: string; refuse?: undefined } | { refuse: string; sql?: undefined };

export interface BenchCase {
  id: string;
  question: string;
  category: Category;
  /** Correct SQL, or null when the correct behaviour is to refuse. */
  gold: string | null;
  shouldRefuse: boolean;
  /**
   * Definition requirements, graded identically on all three paths' SQL.
   * Only set for cases that have a correct answer.
   */
  requires?: {
    /**
     * Status literals that must appear in a status predicate. Any order status
     * not listed here (`cancelled`, `pending`) must not appear, so widening
     * the filter counts as a definition miss rather than a free pass.
     */
    statusValues?: string[];
    /** The timestamp column the period must be measured on. */
    timeColumn?: "completed_at" | "created_at" | "paid_at";
  };
  pathA: Attempt;
  pathB: Attempt;
  pathC: SemanticQueryInput;
  expectTrust?: TrustLevel;
  note?: string;
}

export function buildCases(time: BenchTime): BenchCase[] {
  const lm = { from: time.lastMonth.from, to: exclusiveEnd(time.lastMonth.to) };
  const d30 = { from: time.last30d.from, to: exclusiveEnd(time.last30d.to) };
  const m6 = { from: time.last6m.from, to: exclusiveEnd(time.last6m.to) };

  return [
    // ---------------------------------------------------------------- simple
    {
      id: "revenue_total",
      question: "What was our total revenue?",
      category: "simple metric",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders WHERE status = 'completed'`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: { sql: `SELECT SUM(net_amount) AS revenue FROM orders` },
      pathB: { sql: `SELECT SUM(net_amount) AS revenue FROM orders WHERE status = 'completed'` },
      pathC: { metrics: ["revenue"] },
      expectTrust: "governed",
      note: "Path A counts cancelled and pending orders as revenue.",
    },
    {
      id: "orders_total",
      question: "How many orders have we completed?",
      category: "simple metric",
      gold: `SELECT COUNT(*) AS orders FROM orders WHERE status = 'completed'`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: { sql: `SELECT COUNT(*) AS orders FROM orders` },
      pathB: { sql: `SELECT COUNT(*) AS orders FROM orders WHERE status = 'completed'` },
      pathC: { metrics: ["orders"] },
      expectTrust: "governed",
    },
    {
      id: "aov_total",
      question: "What is our average order value?",
      category: "simple metric",
      gold: `SELECT CAST(SUM(net_amount) AS DOUBLE) / NULLIF(COUNT(*), 0) AS aov
             FROM orders WHERE status = 'completed'`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: { sql: `SELECT AVG(net_amount) AS aov FROM orders` },
      pathB: {
        sql: `SELECT CAST(SUM(net_amount) AS DOUBLE) / NULLIF(COUNT(*), 0) AS aov
              FROM orders WHERE status = 'completed'`,
      },
      pathC: { metrics: ["average_order_value"] },
      expectTrust: "governed",
    },
    {
      id: "customers_total",
      question: "How many customers do we have?",
      category: "join",
      gold: `SELECT COUNT(*) AS customers FROM customers`,
      shouldRefuse: false,
      pathA: {
        sql: `SELECT COUNT(DISTINCT c.id) AS customers
              FROM customers c JOIN orders o ON o.customer_id = c.id
              WHERE o.status = 'completed'`,
      },
      pathB: { sql: `SELECT COUNT(*) AS customers FROM customers` },
      pathC: { metrics: ["customers"] },
      expectTrust: "governed",
      note: "Path A silently answers a different question: customers who have ordered.",
    },

    // ------------------------------------------------------------ time periods
    {
      id: "revenue_last_month",
      question: "What was revenue last month?",
      category: "time period",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders
             WHERE status = 'completed'
               AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "completed_at" },
      pathA: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      },
      pathB: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed'
                AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      },
      pathC: { metrics: ["revenue"], time: { from: time.lastMonth.from, to: time.lastMonth.to } },
      expectTrust: "governed",
      note: "Path A measures the period on created_at and drops the status filter.",
    },
    {
      id: "revenue_last_30d",
      question: "What was revenue in the last 30 days?",
      category: "time period",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders
             WHERE status = 'completed'
               AND completed_at >= '${d30.from}'::timestamp AND completed_at < '${d30.to}'::timestamp`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "completed_at" },
      pathA: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed'
                AND created_at >= '${d30.from}'::timestamp AND created_at < '${d30.to}'::timestamp`,
      },
      pathB: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed'
                AND completed_at >= '${d30.from}'::timestamp AND completed_at < '${d30.to}'::timestamp`,
      },
      pathC: { metrics: ["revenue"], time: { from: time.last30d.from, to: time.last30d.to } },
      expectTrust: "governed",
      note: "Path A gets the status filter right but still books revenue on created_at.",
    },
    {
      id: "revenue_by_month",
      question: "Show monthly revenue for the last six months.",
      category: "time period",
      gold: `SELECT date_trunc('month', completed_at) AS period_month, SUM(net_amount) AS revenue
             FROM orders
             WHERE status = 'completed'
               AND completed_at >= '${m6.from}'::timestamp AND completed_at < '${m6.to}'::timestamp
             GROUP BY 1 ORDER BY 1`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "completed_at" },
      pathA: {
        sql: `SELECT date_trunc('month', created_at) AS period_month, SUM(net_amount) AS revenue
              FROM orders
              WHERE created_at >= '${m6.from}'::timestamp AND created_at < '${m6.to}'::timestamp
              GROUP BY 1 ORDER BY 1`,
      },
      pathB: {
        sql: `SELECT date_trunc('month', completed_at) AS period_month, SUM(net_amount) AS revenue
              FROM orders
              WHERE status = 'completed'
                AND completed_at >= '${m6.from}'::timestamp AND completed_at < '${m6.to}'::timestamp
              GROUP BY 1 ORDER BY 1`,
      },
      pathC: {
        metrics: ["revenue"],
        time: { from: time.last6m.from, to: time.last6m.to, grain: "month" },
      },
      expectTrust: "governed",
    },
    {
      id: "orders_last_month",
      question: "How many orders did we get last month?",
      category: "time period",
      gold: `SELECT COUNT(*) AS orders FROM orders
             WHERE status = 'completed'
               AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "completed_at" },
      pathA: {
        sql: `SELECT COUNT(*) AS orders FROM orders
              WHERE created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      },
      pathB: {
        sql: `SELECT COUNT(*) AS orders FROM orders
              WHERE status = 'completed'
                AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      },
      pathC: { metrics: ["orders"], time: { from: time.lastMonth.from, to: time.lastMonth.to } },
      expectTrust: "governed",
      note: "Path A counts cancelled and pending orders.",
    },

    // -------------------------------------------------------------- dimensions
    {
      id: "revenue_by_country",
      question: "What was revenue by country?",
      category: "dimension",
      gold: `SELECT c.country, SUM(o.net_amount) AS revenue
             FROM orders o JOIN customers c ON o.customer_id = c.id
             WHERE o.status = 'completed'
             GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: {
        sql: `SELECT c.country, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT c.country, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: { metrics: ["revenue"], dimensions: ["country"] },
      expectTrust: "governed",
    },
    {
      id: "revenue_by_channel",
      question: "What was revenue by sales channel?",
      category: "dimension",
      gold: `SELECT channel, SUM(net_amount) AS revenue FROM orders
             WHERE status = 'completed' GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: {
        sql: `SELECT channel, SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed' GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT channel, SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed' GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: { metrics: ["revenue"], dimensions: ["channel"] },
      expectTrust: "governed",
      note: "An easy one-table slice: unconstrained SQL gets this right.",
    },
    {
      id: "revenue_by_country_business",
      question: "What was revenue by country for business customers?",
      category: "dimension",
      gold: `SELECT c.country, SUM(o.net_amount) AS revenue
             FROM orders o JOIN customers c ON o.customer_id = c.id
             WHERE o.status = 'completed' AND c.customer_type = 'business'
             GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: {
        sql: `SELECT c.country, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              WHERE c.customer_type = 'business'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT c.country, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              WHERE o.status = 'completed' AND c.customer_type = 'business'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: {
        metrics: ["revenue"],
        dimensions: ["country"],
        filters: [{ field: "customer_type", operator: "=", value: "business" }],
      },
      expectTrust: "governed",
    },
    {
      id: "revenue_web_last_month",
      question: "What was web-channel revenue last month?",
      category: "time period",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders
             WHERE status = 'completed' AND channel = 'web'
               AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "completed_at" },
      pathA: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE channel = 'web'
                AND created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      },
      pathB: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed' AND channel = 'web'
                AND completed_at >= '${lm.from}'::timestamp AND completed_at < '${lm.to}'::timestamp`,
      },
      pathC: {
        metrics: ["revenue"],
        filters: [{ field: "channel", operator: "=", value: "web" }],
        time: { from: time.lastMonth.from, to: time.lastMonth.to },
      },
      expectTrust: "governed",
    },

    // ----------------------------------------------------------------- fan-out
    {
      id: "payments_received_total",
      question: "How much money did we actually collect?",
      category: "fan-out",
      gold: `SELECT SUM(amount) AS payments_received FROM payments WHERE status = 'succeeded'`,
      shouldRefuse: false,
      requires: { statusValues: ["succeeded"] },
      pathA: {
        sql: `SELECT SUM(p.amount) AS payments_received
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE o.status = 'completed'`,
      },
      pathB: {
        sql: `SELECT SUM(p.amount) AS payments_received
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE p.status = 'succeeded'`,
      },
      pathC: { metrics: ["payments_received"] },
      expectTrust: "governed",
      note: "Path A includes failed payments. Path B is numerically right but joins a one-to-many child at the order grain.",
    },
    {
      id: "payments_received_by_country",
      question: "How much did we collect by country?",
      category: "fan-out",
      gold: `SELECT c.country, SUM(p.value) AS payments_received
             FROM orders o
             JOIN customers c ON o.customer_id = c.id
             LEFT JOIN (
               SELECT order_id, SUM(amount) AS value FROM payments
               WHERE status = 'succeeded' GROUP BY 1
             ) p ON p.order_id = o.id
             GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      requires: { statusValues: ["succeeded"] },
      pathA: {
        sql: `SELECT c.country, SUM(p.amount) AS payments_received
              FROM orders o
              JOIN payments p ON p.order_id = o.id
              JOIN customers c ON o.customer_id = c.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT c.country, SUM(p.amount) AS payments_received
              FROM orders o
              JOIN payments p ON p.order_id = o.id
              JOIN customers c ON o.customer_id = c.id
              WHERE p.status = 'succeeded'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: { metrics: ["payments_received"], dimensions: ["country"] },
      expectTrust: "governed",
    },
    {
      id: "revenue_and_payments",
      question: "Show revenue and payments received side by side.",
      category: "fan-out",
      gold: `SELECT
               (SELECT SUM(net_amount) FROM orders WHERE status = 'completed') AS revenue,
               (SELECT SUM(amount) FROM payments WHERE status = 'succeeded') AS payments_received`,
      shouldRefuse: false,
      requires: { statusValues: ["completed", "succeeded"] },
      pathA: {
        sql: `SELECT SUM(o.net_amount) AS revenue, SUM(p.amount) AS payments_received
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE o.status = 'completed'`,
      },
      pathB: {
        sql: `SELECT SUM(o.net_amount) AS revenue, SUM(p.amount) AS payments_received
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE o.status = 'completed' AND p.status = 'succeeded'`,
      },
      pathC: { metrics: ["revenue", "payments_received"] },
      expectTrust: "governed",
      note: "35% of completed orders have two succeeded payments, so the join double-counts net_amount in both A and B.",
    },
    {
      id: "revenue_payments_refunds",
      question: "Show revenue, payments received and refunds together.",
      category: "fan-out",
      gold: `SELECT
               (SELECT SUM(net_amount) FROM orders WHERE status = 'completed') AS revenue,
               (SELECT SUM(amount) FROM payments WHERE status = 'succeeded') AS payments_received,
               (SELECT SUM(amount) FROM refunds) AS refunded_amount`,
      shouldRefuse: false,
      requires: { statusValues: ["completed", "succeeded"] },
      pathA: {
        sql: `SELECT SUM(o.net_amount) AS revenue, SUM(p.amount) AS payments_received,
                     SUM(r.amount) AS refunded_amount
              FROM orders o
              JOIN payments p ON p.order_id = o.id
              LEFT JOIN refunds r ON r.order_id = o.id
              WHERE o.status = 'completed'`,
      },
      pathB: {
        sql: `SELECT SUM(o.net_amount) AS revenue, SUM(p.amount) AS payments_received,
                     SUM(r.amount) AS refunded_amount
              FROM orders o
              JOIN payments p ON p.order_id = o.id
              LEFT JOIN refunds r ON r.order_id = o.id
              WHERE o.status = 'completed' AND p.status = 'succeeded'`,
      },
      pathC: { metrics: ["revenue", "payments_received", "refunded_amount"] },
      expectTrust: "governed",
      note: "Two one-to-many children in one query: refunds get multiplied by the payment count.",
    },

    // ------------------------------------------------------------- grain traps
    {
      id: "revenue_by_product_category",
      question: "What was revenue by product category?",
      category: "grain trap",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT p.category, SUM(o.net_amount) AS revenue
              FROM orders o
              JOIN order_items oi ON oi.order_id = o.id
              JOIN products p ON p.id = oi.product_id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT p.category, SUM(o.net_amount) AS revenue
              FROM orders o
              JOIN order_items oi ON oi.order_id = o.id
              JOIN products p ON p.id = oi.product_id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: { metrics: ["revenue"], dimensions: ["product_category"] },
      note: "Revenue lives at order grain; splitting by category multiplies orders by their line count. Category totals sum to ~1.8x revenue.",
    },
    {
      id: "aov_by_product_category",
      question: "What is average order value by product category?",
      category: "grain trap",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT p.category, AVG(o.net_amount) AS aov
              FROM orders o
              JOIN order_items oi ON oi.order_id = o.id
              JOIN products p ON p.id = oi.product_id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: { refuse: "SKILL.md: product category is below order grain; AOV cannot be split by it." },
      pathC: { metrics: ["average_order_value"], dimensions: ["product_category"] },
    },

    // ------------------------------------------------------------ unsafe joins
    {
      id: "revenue_by_payment_status",
      question: "Break revenue down by payment status.",
      category: "unsafe join",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT p.status, SUM(o.net_amount) AS revenue
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT p.status, SUM(o.net_amount) AS revenue
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: { metrics: ["revenue"], raw_dimensions: ["payments.status"] },
      note: "An order with two payments is counted twice; an order can also span both statuses.",
    },
    {
      id: "revenue_by_item_quantity",
      question: "Break revenue down by line-item quantity.",
      category: "unsafe join",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT oi.quantity, SUM(o.net_amount) AS revenue
              FROM orders o JOIN order_items oi ON oi.order_id = o.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 1`,
      },
      pathB: { refuse: "SKILL.md: order_items is below order grain; revenue cannot be split by it." },
      pathC: { metrics: ["revenue"], raw_dimensions: ["order_items.quantity"] },
    },

    // -------------------------------------------------------- undefined metrics
    {
      id: "customer_acquisition_cost",
      question: "What is our customer acquisition cost?",
      category: "undefined metric",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT SUM(net_amount) / NULLIF(COUNT(DISTINCT customer_id), 0) AS customer_acquisition_cost
              FROM orders`,
      },
      pathB: { refuse: "SKILL.md defines no acquisition cost, and the shop database holds no spend data." },
      pathC: { metrics: ["customer_acquisition_cost"] },
      note: "There is no marketing-spend table at all; path A's number is revenue per customer wearing a CAC label.",
    },
    {
      id: "churn_rate",
      question: "What is our churn rate?",
      category: "undefined metric",
      gold: null,
      shouldRefuse: true,
      pathA: {
        sql: `SELECT CAST(COUNT(*) FILTER (WHERE status = 'cancelled') AS DOUBLE)
                     / NULLIF(COUNT(*), 0) AS churn_rate
              FROM orders`,
      },
      pathB: {
        sql: `SELECT CAST(COUNT(*) FILTER (WHERE status = 'cancelled') AS DOUBLE)
                     / NULLIF(COUNT(*) FILTER (WHERE status = 'completed'), 0) AS churn_rate
              FROM orders`,
      },
      pathC: { metrics: ["churn_rate"] },
      note: "Prose skills get overridden: both A and B invent a cancellation ratio and call it churn, and they do not even agree.",
    },

    // --------------------------------------------------- ambiguous definitions
    {
      id: "net_sales_total",
      question: "What were net sales?",
      category: "ambiguous definition",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders WHERE status = 'completed'`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status IN ('completed', 'pending')`,
      },
      pathB: { sql: `SELECT SUM(net_amount) AS revenue FROM orders WHERE status = 'completed'` },
      pathC: { metrics: ["sales"] },
      expectTrust: "governed",
      note: '"sales" is a governed synonym of revenue; path A guesses that pending orders count.',
    },

    // ----------------------------------------------------------- mixed trust
    {
      id: "revenue_by_order_created_at",
      question: "What was revenue for orders created last month (an explicitly ungoverned time basis)?",
      category: "mixed trust",
      gold: `SELECT SUM(net_amount) AS revenue FROM orders
             WHERE status = 'completed'
               AND created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"], timeColumn: "created_at" },
      pathA: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      },
      pathB: {
        sql: `SELECT SUM(net_amount) AS revenue FROM orders
              WHERE status = 'completed'
                AND created_at >= '${lm.from}'::timestamp AND created_at < '${lm.to}'::timestamp`,
      },
      pathC: {
        metrics: ["revenue"],
        time: { dimension: "orders.created_at", from: time.lastMonth.from, to: time.lastMonth.to },
      },
      expectTrust: "mixed",
      note: "Governed metric on an ungoverned time column: Grane answers but labels the result mixed.",
    },
    {
      id: "revenue_by_customer_name",
      question: "Who are our top five customers by revenue?",
      category: "mixed trust",
      gold: `SELECT c.name, SUM(o.net_amount) AS revenue
             FROM orders o JOIN customers c ON o.customer_id = c.id
             WHERE o.status = 'completed'
             GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      shouldRefuse: false,
      requires: { statusValues: ["completed"] },
      pathA: {
        sql: `SELECT c.name, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      },
      pathB: {
        sql: `SELECT c.name, SUM(o.net_amount) AS revenue
              FROM orders o JOIN customers c ON o.customer_id = c.id
              WHERE o.status = 'completed'
              GROUP BY 1 ORDER BY 2 DESC LIMIT 5`,
      },
      pathC: {
        metrics: ["revenue"],
        raw_dimensions: ["customers.name"],
        order: [{ field: "revenue", direction: "desc" }],
        limit: 5,
      },
      expectTrust: "mixed",
      note: "customers.name has no governed definition, so the result is labelled mixed.",
    },

    // -------------------------------------------------------- raw exploration
    {
      id: "failed_payments_total",
      question: "How much money is stuck in failed payments?",
      category: "raw exploration",
      gold: `SELECT SUM(amount) AS failed_amount FROM payments WHERE status = 'failed'`,
      shouldRefuse: false,
      requires: { statusValues: ["failed"] },
      pathA: {
        sql: `SELECT SUM(p.amount) AS failed_amount
              FROM orders o JOIN payments p ON p.order_id = o.id
              WHERE p.status = 'failed'`,
      },
      pathB: { sql: `SELECT SUM(amount) AS failed_amount FROM payments WHERE status = 'failed'` },
      pathC: {
        raw_metrics: [{ field: "payments.amount", type: "sum" }],
        filters: [{ field: "payments.status", operator: "=", value: "failed" }],
      },
      expectTrust: "exploratory",
      note: "No governed metric covers failed payments; Grane answers from raw columns and labels it exploratory.",
    },
    {
      id: "payments_count_by_status",
      question: "How many payments are there per status?",
      category: "raw exploration",
      gold: `SELECT status, COUNT(id) AS payments FROM payments GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      pathA: {
        sql: `SELECT p.status, COUNT(*) AS payments
              FROM orders o JOIN payments p ON p.order_id = o.id
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: { sql: `SELECT status, COUNT(id) AS payments FROM payments GROUP BY 1 ORDER BY 2 DESC` },
      pathC: {
        raw_metrics: [{ field: "payments.id", type: "count" }],
        raw_dimensions: ["payments.status"],
      },
      expectTrust: "exploratory",
    },
    {
      id: "units_sold_total",
      question: "How many units have we shipped in total?",
      category: "raw exploration",
      gold: `SELECT SUM(quantity) AS units FROM order_items`,
      shouldRefuse: false,
      pathA: {
        sql: `SELECT SUM(oi.quantity) AS units
              FROM orders o JOIN order_items oi ON oi.order_id = o.id`,
      },
      pathB: { sql: `SELECT SUM(quantity) AS units FROM order_items` },
      pathC: { raw_metrics: [{ field: "order_items.quantity", type: "sum" }] },
      expectTrust: "exploratory",
      note: "Units live at line-item grain. Grane runs the query at that grain instead of hanging it off orders.",
    },
    {
      id: "failed_payments_by_country",
      question: "Which countries have the most money stuck in failed payments?",
      category: "raw exploration",
      gold: `SELECT c.country, SUM(p.amount) AS failed_amount
             FROM payments p
             JOIN orders o ON p.order_id = o.id
             JOIN customers c ON o.customer_id = c.id
             WHERE p.status = 'failed'
             GROUP BY 1 ORDER BY 2 DESC`,
      shouldRefuse: false,
      requires: { statusValues: ["failed"] },
      pathA: {
        sql: `SELECT c.country, SUM(p.amount) AS failed_amount
              FROM orders o
              JOIN payments p ON p.order_id = o.id
              JOIN customers c ON o.customer_id = c.id
              WHERE p.status = 'failed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathB: {
        sql: `SELECT c.country, SUM(p.amount) AS failed_amount
              FROM payments p
              JOIN orders o ON p.order_id = o.id
              JOIN customers c ON o.customer_id = c.id
              WHERE p.status = 'failed'
              GROUP BY 1 ORDER BY 2 DESC`,
      },
      pathC: {
        raw_metrics: [{ field: "payments.amount", type: "sum" }],
        raw_dimensions: ["customers.country"],
        filters: [{ field: "payments.status", operator: "=", value: "failed" }],
      },
      expectTrust: "exploratory",
      note: "Path A answers from the order grain, which happens to be numerically right here but is the same join shape that corrupts revenue_and_payments.",
    },
  ];
}
