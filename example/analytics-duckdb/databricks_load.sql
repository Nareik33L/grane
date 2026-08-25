-- After uploading example/analytics-duckdb/parquet/ to a Unity Catalog volume,
-- replace the volume path below and run in a Databricks SQL warehouse.
--
-- Then point Grane at:
--   connection:
--     type: databricks
--     host: ${DATABRICKS_SERVER_HOSTNAME}
--     http_path: ${DATABRICKS_HTTP_PATH}
--     token: ${DATABRICKS_TOKEN}
--     catalog: main
--     schema: analytics

CREATE SCHEMA IF NOT EXISTS analytics;

CREATE OR REPLACE TABLE analytics.customers AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/customers.parquet`;

CREATE OR REPLACE TABLE analytics.products AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/products.parquet`;

CREATE OR REPLACE TABLE analytics.orders AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/orders.parquet`;

CREATE OR REPLACE TABLE analytics.order_items AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/order_items.parquet`;

CREATE OR REPLACE TABLE analytics.payments AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/payments.parquet`;

CREATE OR REPLACE TABLE analytics.refunds AS
SELECT * FROM parquet.`/Volumes/main/default/grane_example/refunds.parquet`;
