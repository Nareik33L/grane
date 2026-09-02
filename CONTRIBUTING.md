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

`npm run test:unit` does not need Postgres. Full `npm test` needs the demo
database on `localhost:5433` (`docker compose up -d postgres --wait`).
`npm run test:benchmark` builds the DuckDB shop from `demo/seed/duckdb.sql`.
`npm run test:gauntlet` needs only `@duckdb/node-api`. See
`tests/benchmark/README.md` and `tests/gauntlet/README.md`.

The first experience is `docker compose up` or `npx tsx src/cli/index.ts demo`.

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
