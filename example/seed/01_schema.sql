-- Example e-commerce schema for Grane.
--
-- Deliberately includes the classic fan-out shape from the Grane concept:
--
--         orders
--         /    \
--   payments   refunds     (both one_to_many from orders)

CREATE TABLE customers (
  id            serial PRIMARY KEY,
  name          text NOT NULL,
  email         text NOT NULL,
  country       text NOT NULL,
  customer_type text NOT NULL,           -- 'consumer' | 'business'
  created_at    timestamptz NOT NULL
);

CREATE TABLE products (
  id       serial PRIMARY KEY,
  name     text NOT NULL,
  category text NOT NULL,
  price    numeric(10, 2) NOT NULL
);

CREATE TABLE orders (
  id           serial PRIMARY KEY,
  customer_id  integer NOT NULL REFERENCES customers (id),
  status       text NOT NULL,            -- 'completed' | 'cancelled' | 'pending'
  channel      text NOT NULL,            -- 'web' | 'mobile' | 'partner'
  net_amount   numeric(10, 2) NOT NULL,
  created_at   timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  product_id integer NOT NULL REFERENCES products (id),
  quantity   integer NOT NULL,
  unit_price numeric(10, 2) NOT NULL
);

CREATE TABLE payments (
  id       serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES orders (id),
  amount   numeric(10, 2) NOT NULL,
  status   text NOT NULL,                -- 'succeeded' | 'failed'
  paid_at  timestamptz NOT NULL
);

CREATE TABLE refunds (
  id         serial PRIMARY KEY,
  order_id   integer NOT NULL REFERENCES orders (id),
  amount     numeric(10, 2) NOT NULL,
  created_at timestamptz NOT NULL
);

-- A read-only role for Grane. The database remains the final security boundary.
CREATE ROLE grane_readonly LOGIN PASSWORD 'grane_readonly';
GRANT CONNECT ON DATABASE grane_demo TO grane_readonly;
GRANT USAGE ON SCHEMA public TO grane_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grane_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grane_readonly;
