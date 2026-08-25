-- Seed data. setseed() makes random() reproducible for a given Postgres
-- version; dates are relative to CURRENT_DATE so "last month" always has data.

SELECT setseed(0.42);

INSERT INTO customers (name, email, country, customer_type, created_at)
SELECT
  'Customer ' || i,
  'customer' || i || '@example.com',
  (ARRAY['United Kingdom', 'United States', 'Germany', 'France', 'Spain', 'Netherlands'])[1 + floor(random() * 6)::int],
  CASE WHEN random() < 0.7 THEN 'consumer' ELSE 'business' END,
  now() - (random() * interval '540 days')
FROM generate_series(1, 200) AS i;

INSERT INTO products (name, category, price)
SELECT
  'Product ' || i,
  (ARRAY['electronics', 'home', 'outdoors', 'toys', 'office'])[1 + floor(random() * 5)::int],
  round((5 + random() * 195)::numeric, 2)
FROM generate_series(1, 40) AS i;

-- ~1200 orders over the last 12 months.
INSERT INTO orders (customer_id, status, channel, net_amount, created_at, completed_at)
SELECT
  1 + floor(random() * 200)::int,
  CASE
    WHEN r < 0.80 THEN 'completed'
    WHEN r < 0.92 THEN 'cancelled'
    ELSE 'pending'
  END,
  (ARRAY['web', 'mobile', 'partner'])[1 + floor(random() * 3)::int],
  round((10 + random() * 490)::numeric, 2),
  created,
  CASE WHEN r < 0.80 THEN created + interval '1 day' * random() * 3 ELSE NULL END
FROM (
  SELECT
    random() AS r,
    now() - (random() * interval '365 days') AS created
  FROM generate_series(1, 1200)
) AS g;

-- 1-3 order items per order.
INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT
  o.id,
  1 + floor(random() * 40)::int,
  1 + floor(random() * 3)::int,
  round((5 + random() * 195)::numeric, 2)
FROM orders o, generate_series(1, 3) AS n
WHERE random() < 0.6;

-- Payments: completed orders get 1-2 succeeded payments summing to the order
-- amount (a deliberate one_to_many fan-out), plus occasional failed attempts.
WITH split AS (
  SELECT
    o.id AS order_id,
    o.net_amount,
    o.completed_at,
    CASE WHEN random() < 0.35 THEN 2 ELSE 1 END AS parts
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
  s.completed_at - interval '1 hour' * p.n
FROM split s
JOIN LATERAL generate_series(1, s.parts) AS p(n) ON true;

INSERT INTO payments (order_id, amount, status, paid_at)
SELECT o.id, round((o.net_amount * 0.5)::numeric, 2), 'failed', o.created_at
FROM orders o
WHERE random() < 0.08;

-- Refunds on ~15% of completed orders (a second one_to_many from orders).
INSERT INTO refunds (order_id, amount, created_at)
SELECT
  o.id,
  round((o.net_amount * (0.2 + random() * 0.6))::numeric, 2),
  o.completed_at + interval '1 day' * (1 + random() * 20)
FROM orders o
WHERE o.status = 'completed' AND random() < 0.15;
