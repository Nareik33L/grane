-- Example e-commerce schema for DuckDB (same shape as the Postgres seed).
-- Dates are relative to now(), so last_month / 30d always have rows.
-- Foreign keys are omitted so MotherDuck can upload the file without
-- checking constraints while tables are still being copied. Grane reads
-- relationships from relationships.yml instead.

SELECT setseed(0.42);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  country VARCHAR NOT NULL,
  customer_type VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  category VARCHAR NOT NULL,
  price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  status VARCHAR NOT NULL,
  channel VARCHAR NOT NULL,
  net_amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ
);

CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  unit_price DECIMAL(10, 2) NOT NULL
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  status VARCHAR NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

INSERT INTO customers (id, name, email, country, customer_type, created_at)
SELECT
  i,
  'Customer ' || i,
  'customer' || i || '@example.com',
  ['United Kingdom', 'United States', 'Germany', 'France', 'Spain', 'Netherlands']
    [1 + CAST(floor(random() * 6) AS INTEGER)],
  CASE WHEN random() < 0.7 THEN 'consumer' ELSE 'business' END,
  now() - (random() * INTERVAL '540 days')
FROM generate_series(1, 200) AS t(i);

INSERT INTO products (id, name, category, price)
SELECT
  i,
  'Product ' || i,
  ['electronics', 'home', 'outdoors', 'toys', 'office'][1 + CAST(floor(random() * 5) AS INTEGER)],
  round((5 + random() * 195)::DECIMAL, 2)
FROM generate_series(1, 40) AS t(i);

INSERT INTO orders (id, customer_id, status, channel, net_amount, created_at, completed_at)
SELECT
  row_number() OVER () AS id,
  1 + CAST(floor(random() * 200) AS INTEGER),
  CASE
    WHEN r < 0.80 THEN 'completed'
    WHEN r < 0.92 THEN 'cancelled'
    ELSE 'pending'
  END,
  ['web', 'mobile', 'partner'][1 + CAST(floor(random() * 3) AS INTEGER)],
  round((10 + random() * 490)::DECIMAL, 2),
  created,
  CASE WHEN r < 0.80 THEN created + (random() * INTERVAL '3 days') ELSE NULL END
FROM (
  SELECT
    random() AS r,
    now() - (random() * INTERVAL '365 days') AS created
  FROM generate_series(1, 1200)
) AS g;

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price)
SELECT
  row_number() OVER () AS id,
  o.id,
  1 + CAST(floor(random() * 40) AS INTEGER),
  1 + CAST(floor(random() * 3) AS INTEGER),
  round((5 + random() * 195)::DECIMAL, 2)
FROM orders o, generate_series(1, 3)
WHERE random() < 0.6;

INSERT INTO payments (id, order_id, amount, status, paid_at)
WITH split AS (
  SELECT
    o.id AS order_id,
    o.net_amount,
    o.completed_at,
    CASE WHEN random() < 0.35 THEN 2 ELSE 1 END AS parts
  FROM orders o
  WHERE o.status = 'completed'
),
parts AS (
  SELECT s.order_id, s.net_amount, s.completed_at, s.parts, t.n
  FROM split s, generate_series(1, 2) AS t(n)
  WHERE t.n <= s.parts
)
SELECT
  row_number() OVER () AS id,
  order_id,
  CASE
    WHEN parts = 1 THEN net_amount
    WHEN n = 1 THEN round((net_amount * 0.6)::DECIMAL, 2)
    ELSE net_amount - round((net_amount * 0.6)::DECIMAL, 2)
  END,
  'succeeded',
  completed_at - (n * INTERVAL '1 hour')
FROM parts;

INSERT INTO payments (id, order_id, amount, status, paid_at)
SELECT
  (SELECT coalesce(max(id), 0) FROM payments) + row_number() OVER () AS id,
  o.id,
  round((o.net_amount * 0.5)::DECIMAL, 2),
  'failed',
  o.created_at
FROM orders o
WHERE random() < 0.08;

INSERT INTO refunds (id, order_id, amount, created_at)
SELECT
  row_number() OVER () AS id,
  o.id,
  round((o.net_amount * (0.2 + random() * 0.6))::DECIMAL, 2),
  o.completed_at + ((1 + random() * 20) * INTERVAL '1 day')
FROM orders o
WHERE o.status = 'completed' AND random() < 0.15;
