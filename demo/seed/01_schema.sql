-- Canonical Grane demo shop (Postgres).
--
-- Deliberate analytical traps:
--   orders 1--N payments / refunds / order_items / checkout_events
--   customers 1--N support_tickets / subscriptions
--   multiple time columns on orders (created_at, paid_at, settled_at, completed_at)
--   customers.email is PII (excluded in grane.yml)
--   orders.payment_failure_code and payments.failure_code are exploratory
--
-- Last month is seeded with a Germany revenue drop caused by CARD_AUTH_FAILED.

CREATE TABLE customers (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  country       text NOT NULL,
  customer_type text NOT NULL,
  plan          text NOT NULL,
  created_at    timestamptz NOT NULL
);

CREATE TABLE products (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  category text NOT NULL,
  price    numeric(10, 2) NOT NULL
);

CREATE TABLE orders (
  id                    serial PRIMARY KEY,
  customer_id           integer NOT NULL REFERENCES customers (id),
  status                text NOT NULL,
  channel               text NOT NULL,
  net_amount            numeric(10, 2) NOT NULL,
  created_at            timestamptz NOT NULL,
  paid_at               timestamptz,
  settled_at            timestamptz,
  completed_at          timestamptz,
  refunded_at           timestamptz,
  payment_failure_code  text,
  discount_code         text
);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

CREATE TABLE payments (
  id           serial PRIMARY KEY,
  order_id     integer NOT NULL REFERENCES orders (id),
  amount       numeric(10, 2) NOT NULL,
  status       text NOT NULL,
  failure_code text,
  paid_at      timestamptz NOT NULL,
  settled_at   timestamptz
);

CREATE TABLE refunds (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  amount     numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE subscriptions (
  id           serial PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES customers (id),
  plan         text NOT NULL,
  status       text NOT NULL,
  started_at   timestamptz NOT NULL,
  cancelled_at timestamptz,
  mrr          numeric(10, 2) NOT NULL
);

CREATE TABLE checkout_events (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  event_type text NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE TABLE support_tickets (
  id          serial PRIMARY KEY,
  customer_id integer NOT NULL REFERENCES customers (id),
  category    text NOT NULL,
  status      text NOT NULL,
  created_at  timestamptz NOT NULL
);

CREATE ROLE grane_readonly LOGIN PASSWORD 'grane_readonly';
GRANT CONNECT ON DATABASE grane_demo TO grane_readonly;
GRANT USAGE ON SCHEMA public TO grane_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grane_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grane_readonly;
