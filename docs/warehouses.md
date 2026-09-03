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
First week on Postgres: [first-week.md](first-week.md). Production Docker:
[production.md](production.md).

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

The canonical shop is `demo/`. `npx grane-analytics demo` materialises
`demo/seed/duckdb.sql` into a local DuckDB file (Node, not Python):

```bash
npx grane-analytics demo
# or: python3 example/scripts/build_duckdb.py   # also writes Parquet
grane -p demo/analytics query revenue -d country --last last_month
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

## Time dimensions and `project.timezone`

Warehouse temporal types are not interchangeable. Compilation reads the
column's introspected type and distinguishes:

| Kind | Typical warehouse types | Filter / group |
| --- | --- | --- |
| Civil `DATE` | `DATE`, ClickHouse `Date` / `Date32` | Compared and truncated as that calendar date. `project.timezone` does **not** shift it. |
| Timestamp without time zone | Postgres/DuckDB `timestamp`, MySQL `DATETIME`, Snowflake `TIMESTAMP_NTZ` | Treated as a UTC wall-clock instant (the session timezone is pinned to UTC), then localized to `project.timezone`. |
| Instant | `timestamptz`, `TIMESTAMP WITH TIME ZONE`, BigQuery `TIMESTAMP`, Snowflake `TIMESTAMP_TZ` / `TIMESTAMP_LTZ` | Localized to `project.timezone` (existing `AT TIME ZONE` / `CONVERT_TIMEZONE` / …). |

Relative periods (`last_month`, `30d`, `<N>m`, …) still resolve to civil
`from`/`to` in the project timezone before compilation. That is "which
calendar dates did the user ask for?", not "reinterpret this DATE column".
`<N>m` is N calendar months ending today: shift today back N months,
clamp the day to the last valid civil day of the target month, then take
the day after that through today. JavaScript `Date` overflow is not used.

`contains` is literal substring match (case-insensitive where the dialect
already was). `%` and `_` in the user value do not become SQL LIKE
wildcards.

`project.week.starts` is `monday` (default) or `sunday`. A week grain is
the civil interval `[start, next start)` in that calendar. DATE columns
use the warehouse DATE; timestamps use the project-local civil date
after the existing timezone contract. Warehouse-native week defaults
and session `WEEK_START` settings are not used.

If the warehouse type is unknown at compile time and `project.timezone` is
not UTC, Grane refuses (`unsafe_query`) instead of applying timezone
semantics that might be wrong. `grane query` / `explain` introspect the
schema when a time range is present so DATE vs timestamp can be distinguished.

DuckDB execution sets `TimeZone=UTC` on the connection so identical SQL does
not change meaning with the host timezone. Postgres already used
`SET LOCAL TIME ZONE 'UTC'`.

## Same metrics, different SQL

`grane query revenue -d country --last 30d --sql` prints the compiled SQL for
your configured warehouse. The semantic model (metrics.yml) does not change.

## Not in this release

Trino and a community connector SDK. Demand on GitHub issues will drive
the next engines.
