# Contributing to Grane

Grane is an open-source, self-hosted semantic layer for AI agents. The kernel
is deterministic: pull requests that add LLM calls to query execution will
not be accepted.

## Development

```bash
npm install
npm run test:unit
docker compose -f example/docker-compose.yml up -d --wait
npm test
```

`npm run test:unit` does not need Postgres. Full `npm test` needs the example
database on `localhost:5433`.

## Scope

In scope: metrics, dimensions, relationships, validation, the SQL compiler,
join/grain safety, provenance, MCP, CLI, and database connectors.

Out of scope: dashboards, chart builders, a built-in chatbot, hosted
analytics, or anything that makes Grane invent business definitions.

See [README.md](README.md) and [docs/connect-an-agent.md](docs/connect-an-agent.md).
