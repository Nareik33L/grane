# Connecting warehouses

Grane compiles the same semantic query into warehouse-specific SQL. Set
`connection.type` in `grane.yml`. Extra drivers are optional — install only
the one you need.

| Warehouse | `connection.type` | Driver (if not Postgres) |
| --- | --- | --- |
| Postgres | `postgres` | bundled (`pg`) |
| MySQL / MariaDB | `mysql` | `npm install mysql2` |
| Snowflake | `snowflake` | `npm install snowflake-sdk` |
| BigQuery | `bigquery` | `npm install @google-cloud/bigquery` |
| DuckDB | `duckdb` | `npm install duckdb` |
| ClickHouse | `clickhouse` | `npm install @clickhouse/client` |
| Amazon Redshift | `redshift` | bundled (`pg`) |

Use a **read-only** warehouse user. Grane still refuses write SQL in the kernel.

## Postgres / Redshift

```yaml
connection:
  type: postgres          # or redshift
  url: ${DATABASE_URL}
  schema: public
```

Redshift uses the Postgres driver. Aggregates use `CASE WHEN` instead of
`FILTER (WHERE ...)`.

## MySQL

```yaml
connection:
  type: mysql
  url: ${MYSQL_URL}       # mysql://readonly:pass@host:3306/shop
  schema: shop            # database name
```

```bash
npm install mysql2
```

## Snowflake

```yaml
connection:
  type: snowflake
  account: xy12345.us-east-1
  user: ${SNOWFLAKE_USER}
  password: ${SNOWFLAKE_PASSWORD}
  warehouse: COMPUTE_WH
  database: ANALYTICS
  schema: PUBLIC
  role: GRANE_READONLY
```

```bash
npm install snowflake-sdk
```

## BigQuery

```yaml
connection:
  type: bigquery
  project: my-gcp-project
  dataset: analytics
  location: US
  credentials: ${GOOGLE_APPLICATION_CREDENTIALS}   # optional keyfile path
```

```bash
npm install @google-cloud/bigquery
```

Application Default Credentials work if `credentials` is omitted.

## DuckDB

```yaml
connection:
  type: duckdb
  path: /data/warehouse.duckdb    # or :memory:
  schema: main
```

```bash
npm install duckdb
```

## ClickHouse

```yaml
connection:
  type: clickhouse
  url: ${CLICKHOUSE_URL}          # http://readonly:pass@host:8123
  database: analytics
```

```bash
npm install @clickhouse/client
```

## Same metrics, different SQL

`grane query revenue -d country --last 30d --sql` prints the compiled SQL for
your configured warehouse. The semantic model (metrics.yml) does not change.

## Not in this release

Databricks, Trino, and a community connector SDK. Demand on GitHub issues
will drive the next engines.
