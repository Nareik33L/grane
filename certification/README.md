# Certification corpus

Workstream 1 of the multi-engine certification plan. The analytical scenarios
are the #36 corpus; this directory holds engine-agnostic plumbing.

Workstream 6 adds `grane certify --engine <type>` (see [docs/certify.md](../docs/certify.md)).
That CLI runs **this** corpus — it does not invent a second gold set — into an
isolated `grane_cert_<runid>` namespace.

| Path | Role |
| --- | --- |
| `tests/certification/data.ts` | Shared seed arrays |
| `tests/certification/ddl.ts` | `ddl(dialect)` from the column-type map |
| `tests/certification/gold.ts` | TypeScript reductions (never SQL on the engine under test) |
| `tests/certification/corpus.test.ts` | `describe.each(engines)` |
| `tests/helpers/cert-engine.ts` | `CertEngine` adapter |
| `tests/helpers/engines/` | Postgres, DuckDB, MySQL, ClickHouse (CI); Snowflake, BigQuery, Databricks, Redshift (`available()` false without `GRANE_CERT_*`) |

## Running

`npm run test:unit` loads the suite through
`tests/unit/postgres-live-certification.test.ts` (thin alias). Vitest does **not**
collect `tests/certification/*.test.ts` directly, so `npm test` does not double-run
the corpus.

```bash
grane certify --engine duckdb
grane certify --engine snowflake   # skips unless GRANE_CERT_SNOWFLAKE_* is set
```

Postgres runs when `GRANE_PG_WRITE_URL` / `GRANE_PG_READ_URL` resolve (GitHub
Actions `postgres:16`). DuckDB runs whenever `@duckdb/node-api` is installed
(devDependency). MySQL 8 runs when `GRANE_MYSQL_WRITE_URL` resolves and
timezone tables are loaded (`mysql_tzinfo_to_sql` in CI so `CONVERT_TZ` works).
ClickHouse 24 runs when `GRANE_CLICKHOUSE_URL` resolves (CI
`clickhouse/clickhouse-server:24.8`, with `join_use_nulls=1` on every query).

Snowflake / BigQuery / Databricks / Redshift are in-repo adapters that skip in
OSS CI. Redshift is **not** covered by Postgres certification.

## Report artifact

Each available engine writes `certification/<engine>.json` at the end of the
suite (gitignored JSON; this README is kept):

- engine version and session settings
- isolated schema name (`grane_cert_<runid>`)
- capability flags
- scenario pass/fail
- connector safety probes (SELECT-only SQL, no `__grane_` leak, UTC session)

CI uploads `certification/*.json` as the `certification-reports` artifact.
Locally the files appear in the repo root `certification/` directory after
`npm run test:unit`.
