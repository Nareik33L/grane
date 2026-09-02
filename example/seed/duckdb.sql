-- Deterministic DuckDB demo shop. Same story as 02_data.sql:
-- last-month revenue falls, concentrated in partner / PARTNER20.
-- Foreign keys are omitted so MotherDuck can upload the file without
-- checking constraints while tables are still being copied. Grane reads
-- relationships from relationships.yml instead.

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
  discount_code VARCHAR,
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
  ['United Kingdom', 'United States', 'Germany', 'France', 'Spain', 'Netherlands'][1 + ((i - 1) % 6)],
  CASE WHEN i % 5 = 0 THEN 'business' ELSE 'consumer' END,
  date_trunc('month', CURRENT_DATE) - ((12 + (i % 18)) * INTERVAL '1 month')
FROM generate_series(1, 60) AS t(i);

INSERT INTO products (id, name, category, price)
SELECT
  i,
  'Product ' || i,
  ['electronics', 'home', 'outdoors', 'toys', 'office'][1 + ((i - 1) % 5)],
  round((20 + (i * 7) % 180)::DECIMAL, 2)
FROM generate_series(1, 20) AS t(i);

INSERT INTO orders (id, customer_id, status, channel, discount_code, net_amount, created_at, completed_at)
WITH months AS (
  SELECT
    gs AS months_ago,
    date_trunc('month', CURRENT_DATE) - (gs * INTERVAL '1 month') AS month_start
  FROM generate_series(1, 12) AS t(gs)
),
plan AS (
  SELECT months_ago, month_start, 'web' AS channel, 100 AS n, 80.00::DECIMAL(10, 2) AS amount, NULL::VARCHAR AS code
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
),
numbered AS (
  SELECT
    row_number() OVER (ORDER BY p.months_ago, p.channel, n_i) AS id,
    p.*,
    n_i
  FROM plan p, generate_series(1, 200) AS g(n_i)
  WHERE n_i <= p.n
)
SELECT
  id,
  1 + ((id - 1) % 60),
  'completed',
  channel,
  code,
  amount,
  month_start + ((n_i * 3) % 27) * INTERVAL '1 day' + INTERVAL '8 hours',
  month_start + ((n_i * 3) % 27) * INTERVAL '1 day' + INTERVAL '12 hours'
FROM numbered;

INSERT INTO orders (id, customer_id, status, channel, discount_code, net_amount, created_at, completed_at)
SELECT
  (SELECT max(id) FROM orders) + i,
  1 + ((i - 1) % 60),
  CASE WHEN i % 3 = 0 THEN 'pending' ELSE 'cancelled' END,
  ['web', 'mobile', 'partner'][1 + ((i - 1) % 3)],
  NULL,
  50.00,
  date_trunc('month', CURRENT_DATE) - ((1 + (i % 12)) * INTERVAL '1 month') + ((i % 20) * INTERVAL '1 day'),
  NULL
FROM generate_series(1, 120) AS t(i);

INSERT INTO order_items (id, order_id, product_id, quantity, unit_price)
SELECT
  row_number() OVER () AS id,
  o.id,
  1 + ((o.id + n) % 20),
  1 + (n % 2),
  o.net_amount
FROM orders o, generate_series(0, 1) AS g(n)
WHERE o.status = 'completed'
  AND n <= CASE WHEN o.id % 4 = 0 THEN 1 ELSE 0 END;

INSERT INTO payments (id, order_id, amount, status, paid_at)
WITH split AS (
  SELECT
    o.id AS order_id,
    o.net_amount,
    o.completed_at,
    CASE WHEN o.id % 5 = 0 THEN 2 ELSE 1 END AS parts
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
  (SELECT max(id) FROM payments) + row_number() OVER () AS id,
  o.id,
  round((o.net_amount * 0.5)::DECIMAL, 2),
  'failed',
  o.created_at
FROM orders o
WHERE o.status = 'completed' AND o.id % 11 = 0;

INSERT INTO refunds (id, order_id, amount, created_at)
SELECT
  row_number() OVER () AS id,
  o.id,
  round((o.net_amount * 0.25)::DECIMAL, 2),
  o.completed_at + INTERVAL '5 days'
FROM orders o
WHERE o.status = 'completed'
  AND o.completed_at < date_trunc('month', CURRENT_DATE) - INTERVAL '2 months'
  AND o.id % 8 = 0;
