# `grane certify`

Workstream 6. Runs the **same** shared certification corpus as CI
(`tests/certification/`, TypeScript gold over `data.ts`) against one warehouse.
It creates and drops its own namespace (`grane_cert_<runid>`) and **refuses**
connections that cannot `CREATE SCHEMA` (or equivalent). Existing adopter
tables are never the seed target.

```bash
grane certify --engine snowflake
grane certify --engine redshift --out-dir certification
# engine defaults to connection.type in grane.yml
grane certify
```

Exit 0 on pass **or** skip (cloud secrets absent). Exit 1 on corpus failure or
CREATE SCHEMA refusal.

Writes `certification/<engine>.json` plus a human summary. JSON reports are
gitignored; this is not a second gold set.

Snowflake, BigQuery, Databricks, and Redshift stay `self_certifiable` until
Grane CI actually runs this corpus against them. Postgres certification does
not cover Redshift — use `--engine redshift`.

## Environment variables

Cloud adapters call `available()` false (and `grane certify` skips) when the
required `GRANE_CERT_*` variables below are unset. They are **in-repo**, not
live in OSS CI. Do not point these at a production read-only user; the cert
role must be allowed to create and drop `grane_cert_<runid>` only.

| Engine | Required | Optional | Isolated namespace |
| --- | --- | --- | --- |
| `snowflake` | `GRANE_CERT_SNOWFLAKE_ACCOUNT`, `GRANE_CERT_SNOWFLAKE_USER`, `GRANE_CERT_SNOWFLAKE_PASSWORD`, `GRANE_CERT_SNOWFLAKE_WAREHOUSE`, `GRANE_CERT_SNOWFLAKE_DATABASE` | `GRANE_CERT_SNOWFLAKE_ROLE` | schema `grane_cert_<runid>` |
| `bigquery` | `GRANE_CERT_BIGQUERY_PROJECT` | `GRANE_CERT_BIGQUERY_LOCATION`, `GRANE_CERT_BIGQUERY_CREDENTIALS` | dataset `grane_cert_<runid>` |
| `databricks` | `GRANE_CERT_DATABRICKS_HOST`, `GRANE_CERT_DATABRICKS_HTTP_PATH`, `GRANE_CERT_DATABRICKS_TOKEN` | `GRANE_CERT_DATABRICKS_CATALOG` | schema `grane_cert_<runid>` |
| `redshift` | `GRANE_CERT_REDSHIFT_URL` | — | schema `grane_cert_<runid>` |

### `snowflake`

Creates and drops schema `grane_cert_<runid>`. QUERY_TAG=grane and STATEMENT_TIMEOUT come from limits.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRANE_CERT_SNOWFLAKE_ACCOUNT` | yes | Account identifier (e.g. xy12345.us-east-1) |
| `GRANE_CERT_SNOWFLAKE_USER` | yes | User that can CREATE SCHEMA |
| `GRANE_CERT_SNOWFLAKE_PASSWORD` | yes | Password |
| `GRANE_CERT_SNOWFLAKE_WAREHOUSE` | yes | Warehouse |
| `GRANE_CERT_SNOWFLAKE_DATABASE` | yes | Database that will own `grane_cert_<runid>` |
| `GRANE_CERT_SNOWFLAKE_ROLE` | no | Role (optional) |

### `bigquery`

Creates and drops dataset `grane_cert_<runid>` (1-day table expiration). Jobs set maximumBytesBilled from limits.max_bytes_billed (default 10 GiB).

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRANE_CERT_BIGQUERY_PROJECT` | yes | GCP project id |
| `GRANE_CERT_BIGQUERY_LOCATION` | no | Location (default US) |
| `GRANE_CERT_BIGQUERY_CREDENTIALS` | no | Service-account JSON key path; else ADC / GOOGLE_APPLICATION_CREDENTIALS |

### `databricks`

Creates and drops schema `grane_cert_<runid>`. queryTimeout is limits.timeout_ms in seconds.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRANE_CERT_DATABRICKS_HOST` | yes | Workspace host (xxx.cloud.databricks.com) |
| `GRANE_CERT_DATABRICKS_HTTP_PATH` | yes | SQL warehouse HTTP path |
| `GRANE_CERT_DATABRICKS_TOKEN` | yes | PAT / service-principal token that can CREATE SCHEMA |
| `GRANE_CERT_DATABRICKS_CATALOG` | no | Unity Catalog (default main) |

### `redshift`

Creates and drops schema `grane_cert_<runid>`. Uses ddl('redshift') and the Redshift dialect (CASE WHEN, not FILTER). Postgres CI certification does not cover Redshift.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRANE_CERT_REDSHIFT_URL` | yes | postgres:// user with CREATE SCHEMA (pg driver) |

### CI-certified engines (not `GRANE_CERT_*`)

- `postgres`: GRANE_PG_WRITE_URL / GRANE_PG_READ_URL (CI postgres:16). Isolated schema `grane_cert_<runid>`.
- `mysql`: GRANE_MYSQL_WRITE_URL / GRANE_MYSQL_READ_URL plus timezone tables. Isolated database `grane_cert_<runid>`.
- `clickhouse`: GRANE_CLICKHOUSE_URL (CI clickhouse:24). Isolated database `grane_cert_<runid>`.
- `duckdb`: No env. Requires `@duckdb/node-api`. Isolated temp file; never opens an adopter database.

## Dormant GitHub Actions

`.github/workflows/certify-cloud.yml` is present but dormant:

- `workflow_dispatch` with an engine input
- optional weekly Monday schedule
- optional PR label `certify-cloud`

Jobs skip cleanly when the corresponding `GRANE_CERT_*` secrets are absent.
`continue-on-error` is `false` only on the certify step, which runs **only**
when the secret is present. Public OSS CI therefore stays green without
paying cloud credentials.

## Cost controls

Wired from `limits` (and connector defaults) so a certify run cannot run
open-ended:

| Engine | Control |
| --- | --- |
| BigQuery | `maximumBytesBilled` ← `limits.max_bytes_billed` (default 10 GiB); cert datasets expire tables in 1 day |
| Snowflake | `STATEMENT_TIMEOUT_IN_SECONDS` ← `limits.timeout_ms`; `QUERY_TAG = 'grane'` |
| Databricks | `queryTimeout` ← `limits.timeout_ms` (seconds) |
| Redshift | Postgres `statement_timeout` via the shared driver |
