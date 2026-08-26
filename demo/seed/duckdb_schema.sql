-- Canonical Grane demo shop (DuckDB). Same shape as the Postgres seed.
-- Foreign keys omitted so the file can be loaded without constraint order issues.
-- Dates are relative to current_date so last_month always has the demo story.

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name VARCHAR NOT NULL,
  email VARCHAR NOT NULL,
  country VARCHAR NOT NULL,
  customer_type VARCHAR NOT NULL,
  plan VARCHAR NOT NULL,
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
  paid_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  refunded_at TIMESTAMPTZ,
  payment_failure_code VARCHAR,
  discount_code VARCHAR
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
  failure_code VARCHAR,
  paid_at TIMESTAMPTZ NOT NULL,
  settled_at TIMESTAMPTZ
);

CREATE TABLE refunds (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE subscriptions (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  plan VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  cancelled_at TIMESTAMPTZ,
  mrr DECIMAL(10, 2) NOT NULL
);

CREATE TABLE checkout_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL,
  event_type VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE support_tickets (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  category VARCHAR NOT NULL,
  status VARCHAR NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);
