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
| DuckDB | `duckdb` | `npm install @duckdb/node-api` |
| ClickHouse | `clickhouse` | `npm install @clickhouse/client` |
| Amazon Redshift | `redshift` | bundled (`pg`) |
| Databricks | `databricks` | `npm install @databricks/sql` |

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
npm install @duckdb/node-api
```

`:memory:` is useful for tests. A file path persists tables across `grane` runs.
Relative file paths are resolved from the directory that contains `grane.yml`.

A seeded e-commerce file ships at `example/analytics-duckdb/warehouse.duckdb`
(rebuild with `python3 example/scripts/build_duckdb.py`). Point Grane at it:

```bash
grane -p example/analytics-duckdb validate
grane -p example/analytics-duckdb query revenue -d country --last 30d
```

### MotherDuck (hosted DuckDB)

Sign up at [app.motherduck.com](https://app.motherduck.com), create an access
token, and upload the example file:

```bash
export MOTHERDUCK_TOKEN=...
python3 -c "
import duckdb, os
con = duckdb.connect('md:', config={'motherduck_token': os.environ['MOTHERDUCK_TOKEN']})
con.execute(\"CREATE OR REPLACE DATABASE grane_example FROM 'example/analytics-duckdb/warehouse.duckdb'\")
"
```

Then in `grane.yml`:

```yaml
connection:
  type: duckdb
  path: md:grane_example?attach_mode=single
  token: ${MOTHERDUCK_TOKEN}
  schema: main
```

The same tables are also exported as Parquet in
`example/analytics-duckdb/parquet/` for upload into Databricks (see
`databricks_load.sql` in that folder).

## Databricks

```yaml
connection:
  type: databricks
  host: ${DATABRICKS_SERVER_HOSTNAME}   # xxx.cloud.databricks.com
  http_path: ${DATABRICKS_HTTP_PATH}    # /sql/1.0/warehouses/...
  token: ${DATABRICKS_TOKEN}
  catalog: main
  schema: analytics
```

```bash
npm install @databricks/sql
```

Use a SQL warehouse HTTP path and a read-only personal access token (or
service principal token). Tables compile as `` `catalog`.`schema`.`table` ``.

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

Trino and a community connector SDK. Demand on GitHub issues will drive
the next engines.
