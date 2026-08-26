# Contributing to Grane

Grane is an open-source, self-hosted analytics harness for AI agents. The kernel
is deterministic: pull requests that add LLM calls to query execution will
not be accepted.

## Development

```bash
npm install
npm run test:unit
docker compose -f example/docker-compose.yml up -d --wait
npm test
```

Warehouse SDKs (MySQL, Snowflake, BigQuery, DuckDB, ClickHouse, Databricks)
are not installed with the repo. Add the driver you are working on, e.g.
`npm install mysql2`.

`npm run test:unit` does not need Postgres. Full `npm test` needs the example
database on `localhost:5433`.

## Scope

In scope: metrics, dimensions, relationships, validation, the SQL compiler,
join/grain safety, provenance, controlled exploration of raw warehouse
columns, MCP, CLI, and database connectors.

Out of scope: dashboards, chart builders, a built-in chatbot, hosted
analytics, unrestricted agent-written SQL, or anything that makes Grane
invent business definitions or present exploration as governed truth.

See [README.md](README.md) and [docs/connect-an-agent.md](docs/connect-an-agent.md).
