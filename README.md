# Grane

**The open-source semantic layer for AI agents.**

Connect your database, define your business metrics in code, and give any
MCP-compatible agent governed access to your data.

**Self-hosted. Deterministic. No dashboards.**

> Your AI can write SQL. That doesn't mean it knows what Revenue means.

---

## What Grane does

AI agents can already write SQL. But your database does not know your
company's approved definitions of Revenue, MRR, Active Customer or ARPU —
and letting an LLM invent them produces plausible-looking, wrong numbers.

Grane sits between your database and your agents:

```text
Claude / ChatGPT / Cursor / internal agents
                 |
                 |  MCP
                 v
              GRANE          metrics, dimensions, relationships,
                 |           deterministic compiler, validation,
                 |  SQL      join/grain safety, provenance
                 v
           Your Postgres
```

- **The agent reasons. Grane enforces truth.** Agents send semantic requests
  ("revenue by country last month"); Grane resolves the approved definitions,
  plans the joins, compiles the SQL, and executes it read-only.
- **Fan-out safety.** Grane knows relationship cardinality and metric grain.
  Measures across `one_to_many` joins are pre-aggregated deterministically;
  queries that would silently multiply rows are refused.
- **Refusal is a trust feature.** Ask for a metric that isn't defined and
  Grane returns a structured `undefined_metric` response with suggestions —
  it never invents business logic.
- **Provenance on every result.** `trust: governed`, a query id, the exact
  metric definition versions, and the generated SQL.
- **No LLM inside.** Grane is deterministic infrastructure. No API keys, no
  hosted data plane, nothing leaves your environment.

## Connect ChatGPT, Claude, Gemini, or any MCP agent

Grane does **not** need your OpenAI, Anthropic, or Google API keys. You use
**your own agent subscription or API key** on the chat side; Grane sits in the
middle and answers governed analytics queries over MCP.

```text
Your agent (ChatGPT / Claude / Gemini / Cursor)  — your LLM keys
        |
        | MCP
        v
Grane  — no LLM keys; metrics + SQL compiler
        |
        | read-only SQL
        v
Your Postgres  — DATABASE_URL
```

**Setup in three steps:**

1. **Database** — point `grane.yml` at Postgres with a read-only user; define
   metrics in YAML; run `grane validate`.
2. **Grane MCP** — run `grane serve` (HTTP) or let the agent launch
   `grane serve --stdio` (local desktop clients).
3. **Agent** — add Grane as an MCP server in Claude, ChatGPT, Gemini CLI,
   Cursor, etc., then ask questions in chat.

| Agent | Typical setup | Grane transport |
| --- | --- | --- |
| Claude Desktop | `claude_desktop_config.json` or Connectors UI | stdio (local) or HTTPS (remote) |
| ChatGPT | Settings → Connectors (Developer Mode) | **HTTPS only** — deploy Grane publicly |
| Gemini CLI | `~/.gemini/settings.json` | stdio or HTTP |
| Cursor / VS Code | `.cursor/mcp.json` | stdio or local HTTP |

Full walkthrough: **[docs/connect-an-agent.md](docs/connect-an-agent.md)**

MCP tool reference: **[docs/mcp-setup.md](docs/mcp-setup.md)**

Warehouse connections: **[docs/warehouses.md](docs/warehouses.md)**

## Quickstart (with the example database)

```bash
npm install -g grane-analytics @duckdb/node-api
git clone https://github.com/Nareik33L/grane.git
cd grane

# DuckDB (no Docker): seeded shop data in example/analytics-duckdb
grane -p example/analytics-duckdb validate
grane -p example/analytics-duckdb query revenue -d country --last 30d

# Or Postgres:
docker compose -f example/docker-compose.yml up -d --wait
grane -p example/analytics validate
grane -p example/analytics query revenue --dimension country --last last_month
grane -p example/analytics serve
# MCP  http://localhost:8080/mcp
```

## Install

```bash
npm install -g grane-analytics
# or: npx grane-analytics --help
```

The CLI command is still `grane`. Requires Node 20+.

## Warehouses

Set `connection.type` in `grane.yml`. Postgres and Redshift use the bundled
`pg` driver. Other engines need one extra package:

| Type | Extra install |
| --- | --- |
| `postgres` / `redshift` | (bundled) |
| `mysql` | `npm install mysql2` |
| `snowflake` | `npm install snowflake-sdk` |
| `bigquery` | `npm install @google-cloud/bigquery` |
| `duckdb` | `npm install @duckdb/node-api` |
| `clickhouse` | `npm install @clickhouse/client` |
| `databricks` | `npm install @databricks/sql` |

Connection examples: **[docs/warehouses.md](docs/warehouses.md)**

## Quickstart (your own database)

```bash
grane init                 # scaffolds grane.yml, metrics.yml, dimensions.yml, relationships.yml
export DATABASE_URL=postgres://readonly_user:...@host:5432/db
grane discover             # introspect tables, columns, FKs; infer relationships
# ... define entities, metrics, dimensions, relationships ...
grane validate             # the "type checker for analytics"
grane query revenue -d country --last 30d
grane serve                # or: grane serve --stdio
```

Use a **read-only database user**. Grane also wraps every query in a
`READ ONLY` transaction with a statement timeout, but the database remains
the final security boundary.

## Defining metrics

Configuration is code: YAML files, reviewed in pull requests, versioned in
Git, edited by you or your coding agent.

```yaml
# entities: the business objects metrics are counted at (their grain)
entities:
  order:
    table: orders
    primary_key: id

# metrics.yml
metrics:
  revenue:
    description: Net revenue from completed orders
    owner: finance
    entity: order
    type: sum                       # sum | count | count_distinct | avg | min | max | ratio
    sql: ${orders.net_amount}
    time_dimension: ${orders.completed_at}
    unit: GBP
    status: approved                # experimental | approved | deprecated
    synonyms: [sales, net sales]
    filters:
      orders.status: completed

# dimensions.yml
dimensions:
  country:
    entity: customer
    sql: ${customers.country}

# relationships.yml — cardinality powers the join-safety checks
relationships:
  orders_to_customers:
    from: orders.customer_id
    to: customers.id
    type: many_to_one
```

`grane validate` checks every reference against the live schema, verifies
types, and detects unsafe fan-out before an agent ever runs a query.

## The MCP surface

Four tools, deliberately hard to misuse:

| Tool | Purpose |
| --- | --- |
| `catalog()` | Discover metrics, dimensions, entities, synonyms, capabilities |
| `query()` | Run a Query Model v1 request: resolve → validate → compile → execute → provenance |
| `validate()` | Dry-run a query without executing it |
| `explain()` | Inspect definitions, the join plan and the exact SQL |

Agents send analytical intent, not SQL:

```json
{
  "metrics": ["revenue"],
  "dimensions": ["country"],
  "filters": [{ "field": "customer_type", "operator": "=", "value": "business" }],
  "time": { "from": "2026-07-01", "to": "2026-07-31", "grain": "month" },
  "order": [{ "field": "revenue", "direction": "desc" }],
  "limit": 100
}
```

And every result carries provenance:

```json
{
  "provenance": {
    "query_id": "q_1faea438cc34",
    "trust": "governed",
    "query_model": "v1",
    "metrics": { "revenue": { "definition_version": "a82cf1d3" } },
    "generated_sql": "SELECT ...",
    "executed_at": "2026-08-25T12:00:00Z"
  }
}
```

See [docs/connect-an-agent.md](docs/connect-an-agent.md) for ChatGPT, Claude,
Gemini, and Cursor setup. See [docs/mcp-setup.md](docs/mcp-setup.md) for MCP
tool reference and config file formats.

## The trust contract

When Grane returns `trust: governed`, it guarantees that every metric and
dimension was explicitly defined in the semantic model, every join was known
and cardinality-safe, no business logic was invented by an LLM, the SQL is
inspectable, and the exact definition versions are identified. If Grane
cannot safely resolve the requested meaning, it refuses instead.

## What Grane is not

No dashboards, no chart builder, no built-in chatbot, no hosted data plane,
no required LLM API key. Agents own presentation; Grane owns analytics truth.

## Development

```bash
npm install
npm run test:unit                                        # no database needed
docker compose -f example/docker-compose.yml up -d --wait
npm test                                                 # unit + integration
```

V0.1 supports Postgres. The connector interface will open up to other
databases (MySQL, ClickHouse, DuckDB, Snowflake, ...) as demand appears.

## License

Apache-2.0
