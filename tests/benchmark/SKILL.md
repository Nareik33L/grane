# SKILL: Example shop analytics

Metric definitions for the `example/analytics-duckdb` shop warehouse. Read this
before writing analytics SQL against that database.

This file is path B of the A/B/C benchmark: it represents the "good agent +
database MCP + well-written SKILL.md" configuration. The definitions below are
correct. Whether a model *applies* them correctly when it writes the joins is
what the benchmark measures.

## Tables

| table         | grain                | notes                                            |
| ------------- | -------------------- | ------------------------------------------------ |
| `customers`   | one registered customer | `country`, `customer_type` (consumer/business) |
| `orders`      | one order            | `status`, `channel`, `net_amount`, `created_at`, `completed_at` |
| `order_items` | one line item        | 0-3 rows per order; `quantity`, `unit_price`     |
| `payments`    | one payment attempt  | 1-2 succeeded rows per completed order, plus failed attempts |
| `refunds`     | one refund           | at most one per order today, but modelled as one-to-many |
| `products`    | one product          | `category`                                       |

Relationships: `orders.customer_id -> customers.id`,
`payments.order_id -> orders.id`, `refunds.order_id -> orders.id`,
`order_items.order_id -> orders.id`, `order_items.product_id -> products.id`.

## Metric definitions

**Revenue** — net amount of successfully completed orders.

- `SUM(orders.net_amount)` where `orders.status = 'completed'`
- Time dimension: `orders.completed_at`. Never `created_at`.
- Unit: GBP. Synonyms: sales, net sales.

**Orders** — count of completed orders: `COUNT(*)` where `orders.status = 'completed'`,
timed on `completed_at`.

**AOV (average order value)** — revenue / orders. Both parts use the completed
filter. Not `AVG(orders.net_amount)` over all rows.

**Payments received** — successfully collected money:
`SUM(payments.amount)` where `payments.status = 'succeeded'`.
Reported at order grain and timed on `orders.completed_at`.
**Payments fan out.** 35% of completed orders have two succeeded payment rows.
Aggregate payments per `order_id` *before* joining them to anything at the order
grain, or the order's own columns get double-counted.

**Refunded amount** — `SUM(refunds.amount)`. Also a one-to-many child of orders:
pre-aggregate per `order_id` before joining.

**Customer** — a registered customer: a row in `customers`. Not "a customer who
has ordered".

**Country** — `customers.country` (billing country), reached through
`orders.customer_id`.

**Channel** — `orders.channel`.

## Rules

1. Cancelled and pending orders are not revenue. Always filter
   `orders.status = 'completed'` for revenue, orders and AOV.
2. Measure revenue periods on `completed_at`. An order created in June and
   completed in July is July revenue.
3. Product category is **below order grain**. `orders -> order_items` is
   one-to-many, so grouping an order-grain metric by `products.category`
   multiplies each order by its line count. Do not report revenue or AOV by
   category; report a line-item-grain measure instead.
4. Same for any other `order_items` or `payments` column used as a breakdown of
   an order-grain metric: the breakdown multiplies the metric.
5. When combining two one-to-many children in one query (payments and refunds),
   pre-aggregate each child separately. Joining both at once multiplies one by
   the other.
6. Query a table at its own grain when the question is about that table (failed
   payment amounts, units shipped). Do not hang it off `orders`.
7. If a metric is not defined in this file, say so and ask. Do not invent a
   formula for it. In particular this database has no marketing spend, no
   subscription and no customer-lifecycle data, so acquisition cost, churn and
   retention cannot be computed at all.
