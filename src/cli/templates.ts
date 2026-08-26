/** File templates written by `grane init`. */

export const GRANE_YML = `# Grane project configuration.
# Docs: https://github.com/grane-analytics/grane

project:
  name: my-analytics
  timezone: UTC
  # week:
  #   starts: monday
  # fiscal_year:
  #   starts_month: april

connection:
  type: postgres
  # postgres | mysql | snowflake | bigquery | duckdb | clickhouse | redshift | databricks
  # Environment variables are interpolated with \${VAR_NAME}.
  url: \${DATABASE_URL}
  schema: public
  # Snowflake:  account, warehouse, database, schema, user, password, role
  # BigQuery:   project, dataset, location, credentials (keyfile path)
  # DuckDB:     path (file or :memory:)
  # ClickHouse: url (http://user:pass@host:8123) or host + database
  # Databricks: host, http_path, token, catalog, schema

limits:
  max_rows: 10000
  default_rows: 1000
  timeout_ms: 30000

# Controlled exploration: agents may query warehouse columns that are not
# governed metrics or dimensions. Results are marked trust: mixed or exploratory.
# exploration:
#   enabled: false
#   schemas:
#     - public
#   exclude:
#     - users.password_hash
#     - customers.ssn

# Extra governed definitions you already maintain elsewhere (dbt/MetricFlow today).
# Native YAML in this directory is always loaded; providers add to it.
# providers:
#   - type: dbt
#     project: ../jaffle_shop
#     # semantic_manifest: ../jaffle_shop/target/semantic_manifest.json

entities: {}
# Example:
# entities:
#   order:
#     table: orders
#     primary_key: id
#   customer:
#     table: customers
#     primary_key: id
`;

export const METRICS_YML = `# Governed metric definitions. Run "grane validate" after editing.

metrics: {}
# Example:
# metrics:
#   revenue:
#     description: Completed order revenue
#     entity: order
#     type: sum
#     sql: \${orders.net_amount}
#     time_dimension: \${orders.completed_at}
#     unit: GBP
#     status: approved
#     synonyms:
#       - sales
#     filters:
#       orders.status: completed
`;

export const DIMENSIONS_YML = `# Approved dimensions for breaking down and filtering metrics.

dimensions: {}
# Example:
# dimensions:
#   country:
#     entity: customer
#     sql: \${customers.country}
#   channel:
#     entity: order
#     sql: \${orders.channel}
`;

export const RELATIONSHIPS_YML = `# How tables relate. Cardinality is required for join-safety checks.
# Tip: "grane discover" prints relationships inferred from foreign keys.

relationships: {}
# Example:
# relationships:
#   orders_to_customers:
#     from: orders.customer_id
#     to: customers.id
#     type: many_to_one
`;
