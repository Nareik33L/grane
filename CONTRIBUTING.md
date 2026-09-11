# Contributing to Grane

Grane is an open-source, self-hosted analytics harness for AI agents. The kernel
is deterministic: pull requests that add LLM calls to query execution will
not be accepted.

## Development

```bash
npm install
npm run demo
npm run test:unit
docker compose up -d postgres --wait
npm test
```

Warehouse SDKs for Snowflake, BigQuery, and Databricks are not
installed with the repo. Add the driver you are working on. DuckDB, `mysql2`,
and `@clickhouse/client` are devDependencies so CI can certify those engines.

`npm run test:unit` is the PR gate. GitHub Actions provisions PostgreSQL 16,
MySQL 8 (timezone tables loaded via `mysql_tzinfo_to_sql`), and ClickHouse 24
and runs the shared certification corpus on every pull request via `GRANE_PG_*`,
`GRANE_MYSQL_*`, and `GRANE_CLICKHOUSE_URL`. Locally those live engines skip
unless a server is reachable (Postgres `postgres://grane:grane@127.0.0.1:5432/grane_demo`,
MySQL `mysql://root:grane@127.0.0.1:3306/grane_demo` with tz tables,
ClickHouse `http://default:grane@127.0.0.1:8123`,
or the Docker demo Postgres on `localhost:5433`).

Full `npm test` still needs the demo database on `localhost:5433`
(`docker compose up -d postgres --wait`) for integration MCP/workflow tests.
`npm run test:benchmark` builds the DuckDB shop from `demo/seed/duckdb.sql`.
`npm run test:gauntlet` needs only `@duckdb/node-api`. See
`tests/benchmark/README.md` and `tests/gauntlet/README.md`.

The first experience is `npm run demo` or `docker compose up`.

## Scope

In scope: metrics, dimensions, relationships, validation, the SQL compiler,
join/grain safety, provenance, controlled exploration of raw warehouse
columns, semantic connectors (dbt, Cube, LookML, Apache Ossie, auto-detect),
MCP, CLI, database connectors, the query audit log, and production Docker.

Out of scope: dashboards, chart builders, a built-in chatbot, hosted
analytics, unrestricted agent-written SQL, SSO, or anything that makes Grane
invent business definitions or present exploration as governed truth.

See [README.md](README.md), [docs/first-week.md](docs/first-week.md),
[docs/production.md](docs/production.md),
[docs/connect-an-agent.md](docs/connect-an-agent.md), and
[SECURITY.md](SECURITY.md) for vulnerability reports.
