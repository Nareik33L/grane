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

Grane is currently an early public alpha. APIs and features may still evolve.

![Why did revenue fall last month?](demo/why-revenue-fell.gif)

## Try it

Requires Node 20+. No Docker. No API keys for Grane.

From this repository (works before `0.6.5` is on npm):

```bash
git clone https://github.com/Nareik33L/grane.git
cd grane
npm install
npm run demo
```

Once `grane-analytics@0.6.5` is published, the same path is:

```bash
npx grane-analytics demo
```

You should see: revenue down ~14%, Germany the outlier, card authentication failures the lead. Revenue and geography are governed. The failure-code slice is exploratory.

The demo writes a DuckDB connection into the project it just built. Query or connect that same project — no Postgres, no Docker:

```bash
npx grane-analytics -p demo/analytics query revenue --last last_month
npx grane-analytics -p demo/analytics mcp connect cursor
```

From a clone, `npx grane-analytics` is `npm run demo` / `npx tsx src/cli/index.ts` until you `npm run build` and use `node dist/cli/index.js`.

Ask:

> Why did Revenue fall last month?

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
grane mcp connect cursor
```

Use a **read-only database user**. Grane also wraps every query in a `READ ONLY` transaction with a statement timeout.

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

Grane consumes provider semantics. It does not replace the semantic layer.

Runtime-tested warehouses today are **DuckDB** and **PostgreSQL**. Other implemented dialects compile and are inspected; that is not runtime certification.

The strongest, currently best-tested semantic import path is **dbt / MetricFlow**. Cube, LookML, Ossie, and Malloy are supported importers with thinner coverage. Unsupported constructs are skipped with a reason, never guessed.

Postgres is bundled. Other engines are optional installs. Point Grane at an existing project with `grane init --provider ../your_project` instead of copying YAML. See [docs/warehouses.md](docs/warehouses.md) and [docs/providers.md](docs/providers.md).

Production HTTP (Docker, TLS, agent tokens, audit log): [docs/production.md](docs/production.md).

## What Grane is not

No dashboards, no chart builder, no built-in chatbot, no hosted data plane, no required LLM API key.

## Development

```bash
npm install
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
[tests/gauntlet/README.md](tests/gauntlet/README.md).

## License

Apache-2.0
