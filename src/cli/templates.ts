/** File templates written by `grane init`. */

/**
 * `grane.yml` for a new project. With `provider`, the `providers:` block is
 * written live (not commented) so an existing dbt/MetricFlow, Cube, LookML, …
 * project is imported without recreating its metrics in Grane YAML.
 */
export function graneYml(provider?: string): string {
  if (!provider) return GRANE_YML;
  const live =
    `# Governed definitions imported from the analytics project you already have.\n` +
    `# Grane reads them at load time and compiles the SQL itself; the tool is not\n` +
    `# called at query time. Omit type to auto-detect (dbt, Cube, LookML, Ossie, …).\n` +
    `providers:\n` +
    `  - path: ${yamlString(provider)}\n` +
    `\n` +
    `# Native definitions are a peer provider: add here only what the upstream\n` +
    `# project does not govern. The same name from two sources is an error.\n`;
  return GRANE_YML.replace(PROVIDERS_COMMENT, live);
}

function yamlString(value: string): string {
  return /^[A-Za-z0-9_./-]+$/.test(value) ? value : JSON.stringify(value);
}

const PROVIDERS_COMMENT = `# Extra governed definitions you already maintain. Omit type to auto-detect.
# providers:
#   - path: ../jaffle_shop          # dbt, Cube, LookML, Ossie, …
#   - type: dbt
#     project: ../jaffle_shop

`;

export const GRANE_YML = `# Grane project configuration.
# First week: https://github.com/Nareik33L/grane/blob/main/docs/first-week.md
# Production: https://github.com/Nareik33L/grane/blob/main/docs/production.md

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

# Append-only query audit (JSONL). Queries, refusals, HTTP auth denials.
# No row payloads, no agent tokens.
# Relative path is resolved from this project directory. Override in Docker
# with GRANE_AUDIT_PATH=/var/log/grane/audit.jsonl
audit:
  enabled: true
  path: \${GRANE_AUDIT_PATH:-.grane/audit.jsonl}
  # stdout: true   # also emit JSON lines on stderr (container logs; MCP-safe)

# Controlled exploration: agents may query warehouse columns that are not
# governed metrics or dimensions. Results are marked trust: mixed or exploratory.
# exploration:
#   enabled: false
#   schemas:
#     - public
#   exclude:
#     - users.password_hash
#     - customers.ssn

# HTTP MCP per-agent tokens. When set, /mcp requires Authorization: Bearer.
# Required for production HTTP. stdio (local Cursor/Claude) stays trusted.
# auth:
#   agents:
#     - id: finance
#       token: \${FINANCE_AGENT_TOKEN}
#       metrics: [revenue, orders]
#       exploration: false

# Extra governed definitions you already maintain. Omit type to auto-detect.
# providers:
#   - path: ../jaffle_shop          # dbt, Cube, LookML, Ossie, …
#   - type: dbt
#     project: ../jaffle_shop

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

export const METRICS_YML = `# Governed metric definitions. First week: pick about five, then "grane validate".
# Rename tables/columns to match "grane discover".

metrics: {}
# Example starter set:
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
#   orders:
#     description: Completed order count
#     entity: order
#     type: count
#     sql: \${orders.id}
#     time_dimension: \${orders.completed_at}
#     filters:
#       orders.status: completed
#   customers:
#     description: Registered customers
#     entity: customer
#     type: count
#     sql: \${customers.id}
#     time_dimension: \${customers.created_at}
#   average_order_value:
#     description: Revenue per completed order
#     entity: order
#     type: ratio
#     numerator: revenue
#     denominator: orders
#     synonyms:
#       - aov
#   refunded_amount:
#     description: Refunded order value
#     entity: order
#     type: sum
#     sql: \${refunds.amount}
#     time_dimension: \${orders.completed_at}
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
# Tip: "grane discover --write-relationships" merges inferred FKs without clobbering keys.

relationships: {}
# Example:
# relationships:
#   orders_to_customers:
#     from: orders.customer_id
#     to: customers.id
#     type: many_to_one
`;
