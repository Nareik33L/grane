-- Deterministic demo shop. Dates are relative to CURRENT_DATE so "last month"
-- always has data. Revenue last month is lower than the prior month, and the
-- drop is concentrated in channel = partner under discount_code PARTNER20.
--
-- Completed order plan per calendar month (months_ago 1 = last month):
--   web     100 orders × 80  = 8000
--   mobile   60 orders × 90  = 5400
--   partner  80 orders × 100 = 8000  (60 last month, code PARTNER20)

INSERT INTO customers (name, email, country, customer_type, created_at)
SELECT
  'Customer ' || i,
  'customer' || i || '@example.com',
  (ARRAY['United Kingdom', 'United States', 'Germany', 'France', 'Spain', 'Netherlands'])[1 + ((i - 1) % 6)],
  CASE WHEN i % 5 = 0 THEN 'business' ELSE 'consumer' END,
  date_trunc('month', CURRENT_DATE) - ((12 + (i % 18)) || ' months')::interval
FROM generate_series(1, 60) AS i;

INSERT INTO products (name, category, price)
SELECT
  'Product ' || i,
  (ARRAY['electronics', 'home', 'outdoors', 'toys', 'office'])[1 + ((i - 1) % 5)],
  round((20 + (i * 7) % 180)::numeric, 2)
FROM generate_series(1, 20) AS i;

WITH months AS (
  SELECT
    gs AS months_ago,
    date_trunc('month', CURRENT_DATE) - (gs || ' months')::interval AS month_start
  FROM generate_series(1, 12) AS gs
),
plan AS (
  SELECT months_ago, month_start, 'web'::text AS channel, 100 AS n, 80.00::numeric AS amount, NULL::text AS code
  FROM months
  UNION ALL
  SELECT months_ago, month_start, 'mobile', 60, 90.00, NULL
  FROM months
  UNION ALL
  SELECT
    months_ago,
    month_start,
    'partner',
    80,
    CASE WHEN months_ago = 1 THEN 60.00 ELSE 100.00 END,
    CASE WHEN months_ago = 1 THEN 'PARTNER20' ELSE NULL END
  FROM months
)
INSERT INTO orders (customer_id, status, channel, discount_code, net_amount, created_at, completed_at)
SELECT
  1 + ((row_number() OVER (ORDER BY p.months_ago, p.channel, n_i) - 1) % 60),
  'completed',
  p.channel,
  p.code,
  p.amount,
  p.month_start + (((n_i * 3) % 27) || ' days')::interval + interval '8 hours',
  p.month_start + (((n_i * 3) % 27) || ' days')::interval + interval '12 hours'
FROM plan p
JOIN LATERAL generate_series(1, p.n) AS n_i ON true;

-- Cancelled and pending orders so a naive SUM(net_amount) disagrees with revenue.
INSERT INTO orders (customer_id, status, channel, discount_code, net_amount, created_at, completed_at)
SELECT
  1 + ((i - 1) % 60),
  CASE WHEN i % 3 = 0 THEN 'pending' ELSE 'cancelled' END,
  (ARRAY['web', 'mobile', 'partner'])[1 + ((i - 1) % 3)],
  NULL,
  50.00,
  date_trunc('month', CURRENT_DATE) - ((1 + (i % 12)) || ' months')::interval + ((i % 20) || ' days')::interval,
  NULL
FROM generate_series(1, 120) AS i;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  o.id,
  1 + ((o.id + n) % 20),
  1 + (n % 2),
  o.net_amount
FROM orders o
JOIN LATERAL generate_series(0, CASE WHEN o.id % 4 = 0 THEN 1 ELSE 0 END) AS n ON true
WHERE o.status = 'completed';

WITH split AS (
  SELECT
    o.id AS order_id,
    o.net_amount,
    o.completed_at,
    CASE WHEN o.id % 5 = 0 THEN 2 ELSE 1 END AS parts
  FROM orders o
  WHERE o.status = 'completed'
)
INSERT INTO payments (order_id, amount, status, paid_at)
SELECT
  s.order_id,
  CASE
    WHEN s.parts = 1 THEN s.net_amount
    WHEN p.n = 1 THEN round((s.net_amount * 0.6)::numeric, 2)
    ELSE s.net_amount - round((s.net_amount * 0.6)::numeric, 2)
  END,
  'succeeded',
  s.completed_at - (p.n || ' hours')::interval
FROM split s
JOIN LATERAL generate_series(1, s.parts) AS p(n) ON true;

INSERT INTO payments (order_id, amount, status, paid_at)
SELECT o.id, round((o.net_amount * 0.5)::numeric, 2), 'failed', o.created_at
FROM orders o
WHERE o.status = 'completed' AND o.id % 11 = 0;

-- Refunds on older completed orders only, so last month's drop is not refunds.
INSERT INTO refunds (order_id, amount, created_at)
SELECT
  o.id,
  round((o.net_amount * 0.25)::numeric, 2),
  o.completed_at + interval '5 days'
FROM orders o
WHERE o.status = 'completed'
  AND o.completed_at < date_trunc('month', CURRENT_DATE) - interval '2 months'
  AND o.id % 8 = 0;
