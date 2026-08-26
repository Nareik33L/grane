# SKILL: Demo shop analytics

Metric definitions for the canonical Grane demo shop (`demo/`). Read this
before writing analytics SQL against that database.

This file is path B of the A/B/C benchmark: it represents the "good agent +
database MCP + well-written SKILL.md" configuration. The definitions below are
correct. Whether a model *applies* them correctly when it writes the joins is
what the benchmark measures.

## Tables

| table | grain | notes |
| --- | --- | --- |
| `customers` | one registered account | `country`, `customer_type`, `plan`, `email` (PII — never query) |
| `orders` | one order | `status`, `channel`, `net_amount`, `created_at`, `paid_at`, `settled_at`, `completed_at`, `refunded_at`, `payment_failure_code`, `discount_code` |
| `order_items` | one line item | 1–3 rows per order |
| `payments` | one payment attempt | succeeded rows fan out; failed rows have `failure_code` |
| `refunds` | one refund | one-to-many from orders |
| `products` | one product | `category` |
| `subscriptions` | one subscription | not the definition of "customer" |
| `checkout_events` | one event | several per order |
| `support_tickets` | one ticket | 1–4 per customer |

Relationships: `orders.customer_id -> customers.id`,
`payments.order_id -> orders.id`, `refunds.order_id -> orders.id`,
`order_items.order_id -> orders.id`, `order_items.product_id -> products.id`,
`checkout_events.order_id -> orders.id`,
`support_tickets.customer_id -> customers.id`,
`subscriptions.customer_id -> customers.id`.

## Metric definitions

**Revenue** — net amount of successfully completed orders.

- `SUM(orders.net_amount)` where `orders.status = 'completed'`
- Time dimension: `orders.completed_at`. Never `created_at`, `paid_at`, `settled_at`, or `refunded_at`.
- Unit: GBP. Synonyms: sales, net sales.

**Orders** — count of completed orders: `COUNT(*)` where `orders.status = 'completed'`,
timed on `completed_at`.

**AOV** — revenue / orders. Both parts use the completed filter. Not `AVG(net_amount)` over all rows.

**Payments received** — `SUM(payments.amount)` where `payments.status = 'succeeded'`.
Payments fan out. Pre-aggregate per `order_id` before joining at order grain.

**Refunded amount** — `SUM(refunds.amount)`. Also one-to-many from orders.

**Customer** — a registered row in `customers`. Not "a customer who has ordered" and not "an active subscriber".

**Country** — `customers.country`. **Plan** — `customers.plan`. **Channel** — `orders.channel`.

There is **no** governed MRR, CAC, or churn metric. Do not invent them, even if `subscriptions.mrr` exists.

## Rules

1. Cancelled and pending orders are not revenue.
2. Measure revenue periods on `completed_at`.
3. Product category, line-item quantity, payment status, payment `failure_code`, checkout event type, ticket category, and subscription status all sit **below order grain**. Do not group revenue or AOV by them. Report a measure at that table's own grain, or refuse.
4. Pre-aggregate each one-to-many child separately. Joining payments and refunds at once multiplies rows.
5. `customers.email` is blocked PII. Never SELECT it, never filter on it, never join it into a result.
6. If a metric is not defined here, say so. Do not invent a formula.
