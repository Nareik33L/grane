/**
 * AI-consistency protocol metadata (Release 1 item 5b).
 *
 * Temperature is not a parameter of this Cursor agent runtime, so it is
 * recorded as "not controllable" rather than a guessed number.
 */
export const AI_CONSISTENCY = {
  protocol: "r1-5b",
  model: "Cursor Grok 4.6",
  temperature: "not controllable",
  attempts_per_question_per_path: 5,
  paths: ["a_no_grane", "b_grane"] as const,
  /** Same model as the parent run; each attempt is a fresh subagent context. */
  independence:
    "Single model. Five path-A and five path-B isolated subagent contexts. Each context received every question in one prompt, so questions inside a round can leak. Rounds did not see each other's SQL, tool calls, or answers. Temperature is not controllable, so identical prompts may still yield identical answers. Not a live MCP HTTP session: path B is GraneKernel.query, which is what the MCP query tool calls. No API keys or tokens.",
} as const;

export const QUESTION_STEMS = [
  { id: "revenue_last_month", question: "What was Revenue last month?" },
  { id: "orders_completed", question: "How many orders did we complete?" },
  { id: "average_order_value", question: "What is our average order value?" },
  { id: "revenue_q2", question: "What was Revenue in Q2?" },
  { id: "revenue_last_quarter", question: "What was Revenue last quarter?" },
  { id: "revenue_last_30d", question: "What was Revenue in the last 30 days?" },
  { id: "revenue_by_country", question: "Revenue by country." },
  { id: "revenue_by_plan", question: "Revenue by customer plan." },
  { id: "revenue_by_channel_last_month", question: "Revenue by sales channel last month." },
  { id: "payments_received_by_country", question: "How much did we collect in succeeded payments, by country?" },
  { id: "revenue_and_payments", question: "Show revenue and payments received side by side." },
  { id: "customers_total", question: "How many customers do we have?" },
  { id: "customers_ordered_last_month", question: "How many customers ordered last month?" },
  { id: "revenue_by_product_category", question: "Revenue by product category." },
  { id: "revenue_by_ticket_category", question: "Revenue by support ticket category." },
  { id: "revenue_by_checkout_event_type", question: "Revenue by checkout event type." },
] as const;

export type PathId = (typeof AI_CONSISTENCY.paths)[number];
