# V2 existing-YAML compile evidence

Pre-V2 baseline: `7a7ffc6` (last main before V2-01).

Pre-V2 baseline is 7a7ffc6. YAML hashes must match that commit. Metric meaning and compiled SQL are produced by the current compiler on that identical YAML (no silent semantic change).

This report is the committed before/after evidence that supported configs
keep the **same metrics**, **same meaning**, and **same compiled SQL**.
The machine-readable fixture is `tests/fixtures/v2-compat/pre-v2-compile-evidence.json`.
CI recompiles the same projects and diffs this file.

## `example/analytics`

- YAML bytes match `7a7ffc6`.
- Validate: ok.
- Metrics (6): average_order_value, customers, orders, payments_received, refunded_amount, revenue.

| Metric | Type | Entity | Meaning (description) |
| --- | --- | --- | --- |
| `average_order_value` | ratio | order | Average net revenue per completed order. |
| `customers` | count | customer | Number of registered customers (a row in customers, whether or not they have ordered). |
| `orders` | count | order | Number of completed orders. |
| `payments_received` | sum | order | Total successfully collected payments. Payments are one_to_many from orders, so Grane pre-aggregates them at the order grain before joining. |
| `refunded_amount` | sum | order | Total refunded amount, at the order grain. |
| `revenue` | sum | order | Net revenue from completed orders, booked on completed_at (not created_at, paid_at or settled_at). |

Compiled SQL (normalized whitespace) for August 2026:

### average_order_value

```sql
SELECT (SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1))::numeric / NULLIF((COUNT("orders"."id") FILTER (WHERE "orders"."status" = $2))::numeric, 0) AS "average_order_value", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."orders" WHERE "orders"."completed_at" >= $3::timestamp AND "orders"."completed_at" < $4::timestamp LIMIT 1000
```

### customers

```sql
SELECT COUNT("customers"."id") AS "customers", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."customers" WHERE "customers"."created_at" >= $1::timestamp AND "customers"."created_at" < $2::timestamp LIMIT 1000
```

### orders

```sql
SELECT COUNT("orders"."id") FILTER (WHERE "orders"."status" = $1) AS "orders", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### payments_received

```sql
WITH "m_payments_received" AS ( SELECT "payments"."order_id" AS "_key", SUM("payments"."amount") AS "value" FROM "public"."payments" WHERE "payments"."status" = $1 GROUP BY "payments"."order_id" ) SELECT SUM("m_payments_received"."value") AS "payments_received", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."orders" LEFT JOIN "m_payments_received" ON "m_payments_received"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### refunded_amount

```sql
WITH "m_refunded_amount" AS ( SELECT "refunds"."order_id" AS "_key", SUM("refunds"."amount") AS "value" FROM "public"."refunds" GROUP BY "refunds"."order_id" ) SELECT SUM("m_refunded_amount"."value") AS "refunded_amount", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."orders" LEFT JOIN "m_refunded_amount" ON "m_refunded_amount"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp LIMIT 1000
```

### revenue

```sql
SELECT SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "public"."orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### revenue_by_country

```sql
WITH "__grane_pop" AS ( SELECT * FROM "public"."orders" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp ), "__grane_contrib" AS ( SELECT * FROM "__grane_pop" AS "orders" WHERE ("orders"."status" = $3) ), "__grane_reach_customers" AS ( SELECT * FROM "public"."customers" WHERE "customers"."id" IN ( SELECT "orders"."customer_id" FROM "__grane_contrib" AS "orders" WHERE "orders"."customer_id" IS NOT NULL) ), "__grane_card" AS ( SELECT (SELECT MAX("_n") FROM (SELECT COUNT(*) AS "_n" FROM "__grane_reach_customers" GROUP BY "id") AS "_keys") AS "__grane_card_customers" FROM (SELECT 1 AS "_x") AS "_grane_one" ), "__grane_result" AS ( SELECT "customers"."country" AS "country", SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $4) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "__grane_pop" AS "orders" LEFT JOIN "public"."customers" ON "orders"."customer_id" = "customers"."id" GROUP BY 1 ORDER BY "revenue" DESC LIMIT 1000 ) SELECT "__grane_result"."country", "__grane_result"."revenue", "__grane_result"."__grane_n", "__grane_result"."__grane_row", "__grane_card"."__grane_card_customers" FROM "__grane_card" LEFT JOIN "__grane_result" ON TRUE ORDER BY "__grane_result"."revenue" DESC
```

## `example/analytics-duckdb`

- YAML bytes match `7a7ffc6`.
- Validate: ok.
- Metrics (6): average_order_value, customers, orders, payments_received, refunded_amount, revenue.

| Metric | Type | Entity | Meaning (description) |
| --- | --- | --- | --- |
| `average_order_value` | ratio | order | Average net revenue per completed order. |
| `customers` | count | customer | Number of registered customers (a row in customers, whether or not they have ordered). |
| `orders` | count | order | Number of completed orders. |
| `payments_received` | sum | order | Total successfully collected payments. Payments are one_to_many from orders, so Grane pre-aggregates them at the order grain before joining. |
| `refunded_amount` | sum | order | Total refunded amount, at the order grain. |
| `revenue` | sum | order | Net revenue from completed orders, booked on completed_at (not created_at, paid_at or settled_at). |

Compiled SQL (normalized whitespace) for August 2026:

### average_order_value

```sql
SELECT (SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1))::numeric / NULLIF((COUNT("orders"."id") FILTER (WHERE "orders"."status" = $2))::numeric, 0) AS "average_order_value", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $3::timestamp AND "orders"."completed_at" < $4::timestamp LIMIT 1000
```

### customers

```sql
SELECT COUNT("customers"."id") AS "customers", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "customers" WHERE "customers"."created_at" >= $1::timestamp AND "customers"."created_at" < $2::timestamp LIMIT 1000
```

### orders

```sql
SELECT COUNT("orders"."id") FILTER (WHERE "orders"."status" = $1) AS "orders", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### payments_received

```sql
WITH "m_payments_received" AS ( SELECT "payments"."order_id" AS "_key", SUM("payments"."amount") AS "value" FROM "payments" WHERE "payments"."status" = $1 GROUP BY "payments"."order_id" ) SELECT SUM("m_payments_received"."value") AS "payments_received", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" LEFT JOIN "m_payments_received" ON "m_payments_received"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### refunded_amount

```sql
WITH "m_refunded_amount" AS ( SELECT "refunds"."order_id" AS "_key", SUM("refunds"."amount") AS "value" FROM "refunds" GROUP BY "refunds"."order_id" ) SELECT SUM("m_refunded_amount"."value") AS "refunded_amount", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" LEFT JOIN "m_refunded_amount" ON "m_refunded_amount"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp LIMIT 1000
```

### revenue

```sql
SELECT SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### revenue_by_country

```sql
WITH "__grane_pop" AS ( SELECT * FROM "orders" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp ), "__grane_contrib" AS ( SELECT * FROM "__grane_pop" AS "orders" WHERE ("orders"."status" = $3) ), "__grane_reach_customers" AS ( SELECT * FROM "customers" WHERE "customers"."id" IN ( SELECT "orders"."customer_id" FROM "__grane_contrib" AS "orders" WHERE "orders"."customer_id" IS NOT NULL) ), "__grane_card" AS ( SELECT (SELECT MAX("_n") FROM (SELECT COUNT(*) AS "_n" FROM "__grane_reach_customers" GROUP BY "id") AS "_keys") AS "__grane_card_customers" FROM (SELECT 1 AS "_x") AS "_grane_one" ), "__grane_result" AS ( SELECT "customers"."country" AS "country", SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $4) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "__grane_pop" AS "orders" LEFT JOIN "customers" ON "orders"."customer_id" = "customers"."id" GROUP BY 1 ORDER BY "revenue" DESC LIMIT 1000 ) SELECT "__grane_result"."country", "__grane_result"."revenue", "__grane_result"."__grane_n", "__grane_result"."__grane_row", "__grane_card"."__grane_card_customers" FROM "__grane_card" LEFT JOIN "__grane_result" ON TRUE ORDER BY "__grane_result"."revenue" DESC
```

## `demo/analytics`

- YAML bytes match `7a7ffc6`.
- Validate: ok.
- Metrics (6): average_order_value, customers, orders, payments_received, refunded_amount, revenue.

| Metric | Type | Entity | Meaning (description) |
| --- | --- | --- | --- |
| `average_order_value` | ratio | order | Average net revenue per completed order. |
| `customers` | count | customer | Number of registered customers (a row in customers, whether or not they have ordered). |
| `orders` | count | order | Number of completed orders. |
| `payments_received` | sum | order | Total successfully collected payments. Payments are one_to_many from orders, so Grane pre-aggregates them at the order grain before joining. |
| `refunded_amount` | sum | order | Total refunded amount, at the order grain. |
| `revenue` | sum | order | Net revenue from completed orders, booked on completed_at (not created_at, paid_at or settled_at). |

Compiled SQL (normalized whitespace) for August 2026:

### average_order_value

```sql
SELECT (SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1))::numeric / NULLIF((COUNT("orders"."id") FILTER (WHERE "orders"."status" = $2))::numeric, 0) AS "average_order_value", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $3::timestamp AND "orders"."completed_at" < $4::timestamp LIMIT 1000
```

### customers

```sql
SELECT COUNT("customers"."id") AS "customers", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "customers" WHERE "customers"."created_at" >= $1::timestamp AND "customers"."created_at" < $2::timestamp LIMIT 1000
```

### orders

```sql
SELECT COUNT("orders"."id") FILTER (WHERE "orders"."status" = $1) AS "orders", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### payments_received

```sql
WITH "m_payments_received" AS ( SELECT "payments"."order_id" AS "_key", SUM("payments"."amount") AS "value" FROM "payments" WHERE "payments"."status" = $1 GROUP BY "payments"."order_id" ) SELECT SUM("m_payments_received"."value") AS "payments_received", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" LEFT JOIN "m_payments_received" ON "m_payments_received"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### refunded_amount

```sql
WITH "m_refunded_amount" AS ( SELECT "refunds"."order_id" AS "_key", SUM("refunds"."amount") AS "value" FROM "refunds" GROUP BY "refunds"."order_id" ) SELECT SUM("m_refunded_amount"."value") AS "refunded_amount", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" LEFT JOIN "m_refunded_amount" ON "m_refunded_amount"."_key" = "orders"."id" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp LIMIT 1000
```

### revenue

```sql
SELECT SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "orders" WHERE "orders"."completed_at" >= $2::timestamp AND "orders"."completed_at" < $3::timestamp LIMIT 1000
```

### revenue_by_country

```sql
WITH "__grane_pop" AS ( SELECT * FROM "orders" WHERE "orders"."completed_at" >= $1::timestamp AND "orders"."completed_at" < $2::timestamp ), "__grane_contrib" AS ( SELECT * FROM "__grane_pop" AS "orders" WHERE ("orders"."status" = $3) ), "__grane_reach_customers" AS ( SELECT * FROM "customers" WHERE "customers"."id" IN ( SELECT "orders"."customer_id" FROM "__grane_contrib" AS "orders" WHERE "orders"."customer_id" IS NOT NULL) ), "__grane_card" AS ( SELECT (SELECT MAX("_n") FROM (SELECT COUNT(*) AS "_n" FROM "__grane_reach_customers" GROUP BY "id") AS "_keys") AS "__grane_card_customers" FROM (SELECT 1 AS "_x") AS "_grane_one" ), "__grane_result" AS ( SELECT "customers"."country" AS "country", SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $4) AS "revenue", COUNT(*) OVER() AS "__grane_n", 1 AS "__grane_row" FROM "__grane_pop" AS "orders" LEFT JOIN "customers" ON "orders"."customer_id" = "customers"."id" GROUP BY 1 ORDER BY "revenue" DESC LIMIT 1000 ) SELECT "__grane_result"."country", "__grane_result"."revenue", "__grane_result"."__grane_n", "__grane_result"."__grane_row", "__grane_card"."__grane_card_customers" FROM "__grane_card" LEFT JOIN "__grane_result" ON TRUE ORDER BY "__grane_result"."revenue" DESC
```

## Projects covered

- `example/analytics`
- `example/analytics-duckdb`
- `demo/analytics`

