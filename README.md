# Grane

The open-source analytics harness for AI agents.

**Agents reason. Grane executes.**

Your AI can write SQL.
That doesn't mean it knows what Revenue means.

```text
Agent → MCP → Grane → Warehouse
```

- Deterministic business metrics
- Safe joins and grain
- Governed + exploratory analytics
- Works with existing semantic definitions
- No LLM inside Grane
- Fully self-hosted

![Why did revenue fall last month?](demo/why-revenue-fell.gif)

## Try it

Requires Node 20+. No Docker. No API keys for Grane.

From a git clone (until `0.7.0` is on npm), one guided command:

```bash
git clone https://github.com/Nareik33L/grane.git
cd grane
npm install
npm run setup
```

That walks you through: demo shop **or** your own warehouse (any connector Grane already supports) → write/validate project config → register Cursor / Claude / another MCP client → a question to ask the agent. Type `back` to return to the previous step. Prompts are the default. CI / scripts can skip them:

```bash
npm run setup -- --yes --path demo --connect cursor
npm run setup -- --yes --path own --url postgres://readonly@host:5432/db --offline --skip-connect
```

`npm run demo` still builds the shop and runs the investigation without the wizard. Once `grane-analytics@0.7.0` is published, the same paths are `npx grane-analytics setup` and `npx grane-analytics demo`.

On the demo path you should see: revenue down ~14%, Germany the outlier, card authentication failures the lead. Then ask:

> Why did Revenue fall last month?

The demo writes a DuckDB connection into the project it just built. Query that same project — no Postgres, no Docker:

```bash
npx tsx src/cli/index.ts -p demo/analytics query revenue --last last_month
```

From a clone, `npx grane-analytics` is `npx tsx src/cli/index.ts` until you `npm run build` and use `node dist/cli/index.js`.

Postgres (optional):

```bash
docker compose up
```

Demo project: [`demo/`](demo/). Questions: [`demo/questions.md`](demo/questions.md).

---

## Why Grane exists

AI agents can already write SQL. Your database does not know the approved definition of Revenue — and letting an LLM invent it produces plausible-looking, wrong numbers.

Grane sits between the warehouse and the agent. The agent sends intent (`revenue by country`, `period: last_month`). Grane resolves the definition, plans joins, compiles SQL, and executes it read-only. Permitted raw columns can be explored without writing SQL, and every result is labelled `governed`, `mixed`, or `exploratory`.

If Grane cannot safely resolve the meaning, it **refuses**. That is a feature.

Connect Claude, ChatGPT, Gemini, Cursor, or any MCP agent. Grane does not need their API keys.

Walkthrough: **[docs/connect-an-agent.md](docs/connect-an-agent.md)** · MCP tools: **[docs/mcp-setup.md](docs/mcp-setup.md)** · Your own Postgres: **[docs/first-week.md](docs/first-week.md)**

## Install (your warehouse)

```bash
npm install -g grane-analytics
grane init
export DATABASE_URL=postgres://readonly_user:...@host:5432/db
grane discover --write-relationships
grane validate
grane validate --production
grane certify --engine postgres
grane mcp connect cursor
```

Use a **read-only database user** — that role is the real control. Grane refuses write-headed SQL on every warehouse and honours `limits.timeout_ms`. Postgres and Redshift wrap each query in a `READ ONLY` transaction with `statement_timeout`. DuckDB file connections open with `access_mode: READ_ONLY`. MySQL sets `SESSION TRANSACTION READ ONLY`. ClickHouse sends `readonly=1`. Snowflake, BigQuery, and Databricks rely on the warehouse role plus the write-keyword guard.

## Architecture

```text
Claude / ChatGPT / Cursor / internal agents
                 |
                 |  MCP
                 v
              GRANE          metrics, dimensions, relationships,
                 |           deterministic compiler, validation,
                 |  SQL      join/grain safety, provenance
                 v
           Your warehouse
```

Four MCP tools: `catalog`, `query`, `validate`, `explain`. Agents send analytical intent, not SQL.

```json
{
  "metrics": ["revenue"],
  "dimensions": ["country"],
  "raw_dimensions": ["orders.discount_code"],
  "time": { "period": "last_month" }
}
```

| `trust` | Meaning |
| --- | --- |
| `governed` | Approved definitions only. Present as business truth. |
| `mixed` | Approved metrics plus permitted raw fields. A lead, not approved truth. |
| `exploratory` | Raw warehouse data only. Investigation, not governed analytics. |

## Benchmark

Same shop, same questions, three ways — no LLM in the loop. **50 questions.**
Paths A and B are representative SQL fixtures, not live model samples.
Grane compiled the same request five times: identical SQL.

| | Numeric | Refusal | Permission | Overall |
| --- | ---: | ---: | ---: | ---: |
| A Direct DB MCP | 31% | 72% | 0% | 47% |
| B DB MCP + SKILL.md | 94% | 90% | 100% | 91% |
| C Grane | 100% | 100% | 100% | 100% |

A well-written `SKILL.md` gets definitions right. It still writes fan-out joins
and cannot *enforce* a PII denylist. Grane compiles the join plan and refuses
the rest. If live agents beat these fixtures, that is useful — publish it.

```bash
npm run test:benchmark
```

Methodology: [`tests/benchmark/README.md`](tests/benchmark/README.md).

## Warehouses and semantic providers

Postgres is bundled. Other engines are optional installs. Certified in CI: PostgreSQL 16, MySQL 8, DuckDB 1.5, and ClickHouse 24. Other engines are not CI-certified — see [docs/warehouses.md](docs/warehouses.md). Already have dbt/MetricFlow, Cube, LookML, Ossie, or Malloy? `grane init --provider ../your_project` imports those definitions instead of copying YAML; what Grane cannot compile faithfully is skipped with a reason, never guessed. See [docs/warehouses.md](docs/warehouses.md) and [docs/providers.md](docs/providers.md).

Production HTTP (Docker, TLS, agent tokens, audit log): [docs/production.md](docs/production.md).

## What Grane is not

No dashboards, no chart builder, no built-in chatbot, no hosted data plane, no required LLM API key.

## Development

```bash
npm install
npm run setup                                            # guided demo or own warehouse + MCP
npm run demo
npm run test:unit                                        # no database needed
docker compose up -d postgres --wait
npm test                                                 # unit + integration

npm run test:benchmark                                   # A/B/C thesis on the demo shop
npm run test:gauntlet                                    # internal robustness gauntlet
```

`tests/gauntlet` is the internal robustness suite: a hostile warehouse and
hundreds of scenarios designed to make Grane return the wrong number, bypass a
permission, or label exploration as governed. See
[tests/gauntlet/README.md](tests/gauntlet/README.md). Adopters put their own
query + gold YAML next to `grane.yml` and run `grane test`
([docs/tests.md](docs/tests.md)).

## License

Apache-2.0
