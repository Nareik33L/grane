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

Warehouse SDKs (MySQL, Snowflake, BigQuery, DuckDB, ClickHouse, Databricks)
are not installed with the repo. Add the driver you are working on, e.g.
`npm install mysql2`.

`npm run test:unit` is the PR gate. GitHub Actions provisions PostgreSQL 16
and runs the live-Postgres correctness corpus (plus the older
`describe.skipIf` Postgres blocks) on every pull request via
`GRANE_PG_WRITE_URL` / `GRANE_PG_READ_URL`. Locally those tests skip unless
a server is reachable (default `postgres://grane:grane@127.0.0.1:5432/grane_demo`,
or the Docker demo on `localhost:5433`).

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
[docs/production.md](docs/production.md), and
[docs/connect-an-agent.md](docs/connect-an-agent.md).
