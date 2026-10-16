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
a **credentialed `certify-cloud` run has actually passed** and
`WAREHOUSE_CERTIFICATION` is updated. A pending dispatch, a skip-without-secrets
job, or a connector that compiles is not certification. They are **not yet
tested / not certified**. Postgres certification does
not cover Redshift — use `--engine redshift`. Docs and README must match
the map exactly (`certified` vs `self_certifiable`).

## Environment variables

Cloud adapters call `available()` false (and `grane certify` skips) when the
required `GRANE_CERT_*` variables below are unset. They are **in-repo**, not
live in OSS CI. Do not point these at a production read-only user — this
certification account is **not** the runtime read-only user. Exact
least-privilege GRANT SQL and IAM roles (Snowflake, BigQuery, Databricks
Unity Catalog, Redshift), plus gate 8’s separate QA credentials, are in
[certify-grants.md](certify-grants.md). The cert role must be allowed to
create and drop `grane_cert_<runid>` only.

| Engine | Required | Optional | Isolated namespace |
| --- | --- | --- | --- |
| `snowflake` | `GRANE_CERT_SNOWFLAKE_ACCOUNT`, `GRANE_CERT_SNOWFLAKE_USER`, `GRANE_CERT_SNOWFLAKE_WAREHOUSE`, `GRANE_CERT_SNOWFLAKE_DATABASE` | `GRANE_CERT_SNOWFLAKE_PRIVATE_KEY`, `GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`, `GRANE_CERT_SNOWFLAKE_PASSWORD`, `GRANE_CERT_SNOWFLAKE_ROLE` | schema `grane_cert_<runid>` |
| `bigquery` | `GRANE_CERT_BIGQUERY_PROJECT` | `GRANE_CERT_BIGQUERY_LOCATION`, `GRANE_CERT_BIGQUERY_CREDENTIALS` | dataset `grane_cert_<runid>` |
| `databricks` | `GRANE_CERT_DATABRICKS_HOST`, `GRANE_CERT_DATABRICKS_HTTP_PATH`, `GRANE_CERT_DATABRICKS_TOKEN` | `GRANE_CERT_DATABRICKS_CATALOG` | schema `grane_cert_<runid>` |
| `redshift` | `GRANE_CERT_REDSHIFT_URL` | — | schema `grane_cert_<runid>` |

### `snowflake`

Creates and drops schema `grane_cert_<runid>`. Prefer TYPE=SERVICE key-pair (`GRANE_CERT_SNOWFLAKE_PRIVATE_KEY`); a user with no TYPE is human/PERSON and needs MFA, so an automated certify run will fail. Password auth is kept for compatibility and prints a warning. QUERY_TAG=grane and STATEMENT_TIMEOUT come from limits.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRANE_CERT_SNOWFLAKE_ACCOUNT` | yes | Account identifier (e.g. xy12345.us-east-1) |
| `GRANE_CERT_SNOWFLAKE_USER` | yes | TYPE=SERVICE user that can CREATE SCHEMA |
| `GRANE_CERT_SNOWFLAKE_WAREHOUSE` | yes | Warehouse |
| `GRANE_CERT_SNOWFLAKE_DATABASE` | yes | Database that will own `grane_cert_<runid>` |
| `GRANE_CERT_SNOWFLAKE_PRIVATE_KEY` | no | PKCS8 PEM path or PEM body for key-pair auth (preferred). GitHub secret is the PEM; the workflow writes a 0600 temp file under RUNNER_TEMP. |
| `GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE` | no | Passphrase if the private key is encrypted |
| `GRANE_CERT_SNOWFLAKE_PASSWORD` | no | Legacy password or PAT (warns as password/PAT; password-only sign-in is being phased out) |
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
| `GRANE_CERT_DATABRICKS_CATALOG` | no | Unity Catalog name; set this — unset falls back to main |

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

CI sets `GRANE_CERT_REQUIRE=postgres,duckdb,mysql,clickhouse`. `loadAvailableEngines` throws if a required engine is unavailable (no silent skip). Unset locally so missing warehouses still skip. Cloud engines are unchanged.

## Dormant GitHub Actions

`.github/workflows/certify-cloud.yml` is present but dormant:

- `workflow_dispatch` with an engine input
- optional weekly Monday schedule
- optional PR label `certify-cloud`

Jobs skip cleanly when the corresponding `GRANE_CERT_*` secrets are absent.
`continue-on-error` is `false` only on the certify step, which runs **only**
when the secret is present. Public OSS CI therefore stays green without
paying cloud credentials.

### GitHub secret `GRANE_CERT_BIGQUERY_CREDENTIALS` (CI only)

The Node client (`keyFilename` / `credentials`) expects
`GRANE_CERT_BIGQUERY_CREDENTIALS` to be a **filesystem path**, not the JSON
body. Passing the GitHub secret value through as that env var is the failure
this blocks: a BigQuery cert run that **silently fails to authenticate**
because the JSON document is treated as a `keyFilename`.

In `.github/workflows/certify-cloud.yml`:

- The Actions secret stores the service-account JSON document.
- The certify step copies it with `printf` (never `echo`) into a `mktemp`
  file under `$RUNNER_TEMP` (outside the repo and outside workspace
  artifacts), mode `0600`.
- That path is exported as `GRANE_CERT_BIGQUERY_CREDENTIALS`.
- A `trap` on `EXIT` and an `always()` step delete the file on every exit
  path, including failures. Cleanup runs before the artifact upload.
- The key is never logged, echoed, or uploaded. The only artifact is
  `certification/<engine>.json`.
- Forked-PR workflows never receive the secret (`pull_request` from a fork
  has empty `secrets.*`; the job also forces `present=false` when
  `head.repo` is a fork or a different repository, and does not interpolate
  the secret onto those runs). The workflow does not use `pull_request_target`.

Locally, keep setting `GRANE_CERT_BIGQUERY_CREDENTIALS` to a key file path
(or omit it and use ADC / `GOOGLE_APPLICATION_CREDENTIALS`).

**Pending release step:** do not dispatch this workflow with real warehouse
secrets from a public PR. Kieran adds `GRANE_CERT_*` (least-privilege
accounts in [certify-grants.md](certify-grants.md)) and runs `certify-cloud`
once before the V2 tag. Listed on [release-checklist.md](release-checklist.md)
together with QA's independent RC cert, which needs a **separate credential
set**. Do not run those steps from this PR. npm publish stays on hold.

Cloud engines are compile-supported (`self_certifiable`), not
runtime-certified. See [warehouses.md](warehouses.md#runtime-certified).

## V2 example / demo compat

`example/analytics` defaults to postgres and `demo/analytics` to duckdb.
After `npm run test:unit`, CI runs `npx tsx tests/certification/compare-v2-compat.ts`
and compares those two reports to the pre-V2 main baseline (`7a7ffc6`,
`tests/fixtures/v2-compat/`). Scenario names must match; each must pass.
See [v2-authoring.md](v2-authoring.md#compatibility).

## Cost controls

Wired from `limits` (and connector defaults) so a certify run cannot run
open-ended:

| Engine | Control |
| --- | --- |
| BigQuery | `maximumBytesBilled` ← `limits.max_bytes_billed` (default 10 GiB); cert datasets expire tables in 1 day |
| Snowflake | `STATEMENT_TIMEOUT_IN_SECONDS` ← `limits.timeout_ms`; `QUERY_TAG = 'grane'` |
| Databricks | `queryTimeout` ← `limits.timeout_ms` (seconds) |
| Redshift | Postgres `statement_timeout` via the shared driver |
