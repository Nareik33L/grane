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

## Certification

The map in `src/connectors/certification.ts` is the source of truth. `catalog.server.warehouse`
exposes `{ type, certification, certified_version }`. Gold values for the shared corpus are
TypeScript reductions over the seed, not SQL on the engine under test. Reports write to
`certification/<engine>.json` (see `certification/README.md`).

| State | Meaning |
| --- | --- |
| `certified` | Shared corpus runs in Grane CI. |
| `self_certifiable` | Connector ships; Grane CI does not run the corpus. Verify against your warehouse. |
| `compile_only` | SQL is compiled for this dialect; live execution is not a Grane-certified path. |

| Warehouse | `connection.type` | State | Minimum certified version |
| --- | --- | --- | --- |
| PostgreSQL | `postgres` | `certified` | 16 |
| MySQL / MariaDB | `mysql` | `certified` | 8 |
| Snowflake | `snowflake` | `self_certifiable` | — |
| BigQuery | `bigquery` | `self_certifiable` | — |
| DuckDB | `duckdb` | `certified` | 1.5 |
| ClickHouse | `clickhouse` | `certified` | 24 |
| Amazon Redshift | `redshift` | `self_certifiable` | — |
| Databricks | `databricks` | `self_certifiable` | — |

First week on Postgres: [first-week.md](first-week.md). Production Docker:
[production.md](production.md).

## Postgres / Redshift

```yaml
connection:
  type: postgres          # or redshift
  url: ${DATABASE_URL}
  schema: public
  # ssl: true
  # ssl_verify: false     # only if you cannot fix the certificate chain
  # pool_size: 5          # Postgres pool; raise on a shared HTTP server
```

When `ssl: true`, certificates are verified. Set `ssl_verify: false` to opt out.
Redshift uses the Postgres driver. Aggregates use `CASE WHEN` instead of
`FILTER (WHERE ...)`.

## MySQL

```yaml
connection:
  type: mysql
  url: ${MYSQL_URL}       # mysql://readonly:pass@host:3306/shop
  schema: shop            # database name
  # ssl: true
  # ssl_verify: false     # only if you cannot fix the certificate chain
  # pool_size: 5
```

```bash
npm install mysql2
```

Each query connection runs `SET SESSION TRANSACTION READ ONLY` and
`SET time_zone = '+00:00'`. `limits.timeout_ms` is the mysql2 query timeout
(and MySQL `max_execution_time` when the server accepts it). Aggregates use
`CASE WHEN` rather than `FILTER (WHERE ...)`. Named-zone `CONVERT_TZ` needs
the server timezone tables (`mysql_tzinfo_to_sql`); `grane mcp doctor` warns
when `CONVERT_TZ` returns NULL. CI certifies MySQL 8 (`COUNT(*) OVER` needs
8.0+). Load `utf8mb4` for `contains` (café) and treat `DECIMAL` as decimal,
not `DOUBLE`.

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

Each query best-effort `ALTER SESSION SET STATEMENT_TIMEOUT_IN_SECONDS` and `TIMEZONE = 'UTC'`.

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
Empty results keep column names from the getQueryResults schema. `jobTimeoutMs` is `limits.timeout_ms`.

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
npx grane-analytics demo   # requires grane-analytics@0.6.5+
# from a clone: npm install && npm run demo
# or: python3 example/scripts/build_duckdb.py   # also writes Parquet
npx grane-analytics -p demo/analytics query revenue -d country --last last_month
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
Empty results still return column names from the statement schema, not
`Object.keys` of the first row. The session is pinned with `SET TIME ZONE 'UTC'`
and `queryTimeout` is `limits.timeout_ms` in seconds.

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

Queries use ClickHouse `FORMAT JSON` so `meta` supplies column names when
`data` is empty. Each query sets `readonly=1`, `join_use_nulls=1` (unmatched
LEFT JOIN is NULL, not `0`/`''`), `session_timezone=UTC`,
`aggregate_functions_null_for_empty` (empty SUM is NULL, not 0),
`output_format_json_quote_64bit_integers`, and `max_execution_time` from
`limits.timeout_ms` (plus an abort signal). Aggregates use `CASE WHEN`
rather than `FILTER (WHERE ...)`. `contains` uses
`positionCaseInsensitiveUTF8` because ClickHouse 24 has no `LIKE … ESCAPE`
(that SQL clause landed in 26.6). CI certifies ClickHouse 24. Week starts
use `toStartOfWeek(expr, 1)` (Monday) and `toStartOfWeek(expr, 0)` (Sunday).
Timestamp localization formats the instant in `project.timezone` and re-parses
it (`toTimeZone` keeps the Unix instant, so civil bounds would not shift).
Ratio CAST uses `Nullable(Decimal(38, 12))` so a NULL numerator stays NULL.

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

DuckDB execution sets `TimeZone=UTC` on the connection (and again before
each query) so identical SQL does not change meaning with the host timezone.
Postgres uses `SET LOCAL TIME ZONE 'UTC'`, MySQL `SET time_zone = '+00:00'`,
ClickHouse `session_timezone=UTC`, Snowflake `ALTER SESSION SET TIMEZONE = 'UTC'`,
and Databricks `SET TIME ZONE 'UTC'`. BigQuery `TIMESTAMP` values are already UTC.

## Same metrics, different SQL

`grane query revenue -d country --last 30d --sql` prints the compiled SQL for
your configured warehouse. The semantic model (metrics.yml) does not change.

## Not in this release

Trino and a community connector SDK. Demand on GitHub issues will drive
the next engines.
