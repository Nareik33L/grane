# Grane

**The open-source analytics harness for AI agents.**

Agents reason. Grane executes.

Connect your warehouse, define the business metrics that matter, and give any
MCP-compatible agent governed access to those definitions — plus permissioned
exploration of everything else.

**Self-hosted. Deterministic. Semantic-first, not semantic-only.**

> Your AI can write SQL. That doesn't mean it knows what Revenue means.
> Grane tells it which numbers are authoritative and which conclusions are exploratory.

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

- **The agent reasons. Grane enforces truth — and labels exploration.** Agents
  send semantic requests ("revenue by country last month"); Grane resolves the
  approved definitions, plans the joins, compiles the SQL, and executes it
  read-only. Permitted raw warehouse columns can be requested as
  `raw_dimensions` / `raw_metrics` without writing SQL.
- **Fan-out safety.** Grane knows relationship cardinality and metric grain.
  Measures across `one_to_many` joins are pre-aggregated deterministically;
  queries that would silently multiply rows are refused — including exploratory
  ones.
- **Refusal is a trust feature.** Ask for a metric that isn't defined and
  Grane returns a structured `undefined_metric` response with suggestions —
  it never invents business logic. Raw columns are allowed only when
  exploration is enabled and the column is not excluded.
- **Three trust levels.** `governed` (approved definitions only), `mixed`
  (approved metrics plus raw fields), `exploratory` (raw warehouse data).
  Agents must not present exploration as approved business truth.
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
3. **Agent** — register Grane with `grane mcp connect <client>` (Claude,
   Cursor, Gemini, VS Code, ChatGPT, Windsurf, Claude Code, or generic), then
   ask questions in chat.

| Agent | Typical setup | Grane transport |
| --- | --- | --- |
| Claude Desktop | `grane mcp connect claude` | stdio (local) or HTTPS (remote) |
| ChatGPT | `grane mcp connect chatgpt` (prints HTTPS steps) | **HTTPS only** — deploy Grane publicly |
| Gemini CLI | `grane mcp connect gemini` | stdio or HTTP |
| Cursor / VS Code | `grane mcp connect cursor` or `vscode` | stdio or local HTTP |

Full walkthrough: **[docs/connect-an-agent.md](docs/connect-an-agent.md)**

MCP tool reference: **[docs/mcp-setup.md](docs/mcp-setup.md)**

Warehouse connections: **[docs/warehouses.md](docs/warehouses.md)**

Semantic connectors (dbt, Cube, LookML, Ossie): **[docs/providers.md](docs/providers.md)**

First week on your own Postgres: **[docs/first-week.md](docs/first-week.md)**

Production HTTP (Docker, TLS, agent tokens, audit log): **[docs/production.md](docs/production.md)**

## Install

```bash
npm install -g grane-analytics
# or: npx grane-analytics --help
```

The CLI command is still `grane`. Requires Node 20+. Postgres is bundled.
Other warehouse drivers are **not** installed with the CLI — add only the one
you use (see Warehouses below).

## Quickstart (your own Postgres)

```bash
grane init
export DATABASE_URL=postgres://readonly_user:...@host:5432/db
grane discover --write-relationships   # inspect schema; merge FKs, keep existing keys
# define entities and about five metrics (see metrics.yml comments)
grane validate
grane query revenue -d country --last 30d
grane mcp connect cursor
```

Use a **read-only database user**. Grane also wraps every query in a
`READ ONLY` transaction with a statement timeout, but the database remains
the final security boundary. Queries are appended to `.grane/audit.jsonl`.

Step-by-step: **[docs/first-week.md](docs/first-week.md)**.

## Example database

```bash
git clone https://github.com/Nareik33L/grane.git
cd grane

# Postgres demo (Docker):
docker compose -f example/docker-compose.yml up -d --wait
grane -p example/analytics validate
grane -p example/analytics query revenue --dimension country --last last_month
grane -p example/analytics serve
# MCP  http://localhost:8080/mcp

# DuckDB alternative (no Docker): npm install @duckdb/node-api
grane -p example/analytics-duckdb validate
grane -p example/analytics-duckdb query revenue -d country --last 30d
```

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

## Existing semantic models

If the company already defines Revenue in dbt, Cube, Looker, Apache Ossie, or Malloy,
do not copy it into Grane YAML. Point a connector at that project:

```yaml
# grane.yml — type is optional; Grane sniffs the folder
providers:
  - path: ../jaffle_shop
```

Native YAML still works for metrics the upstream system does not have.
Duplicate names are refused. See **[docs/providers.md](docs/providers.md)**.
A runnable dbt example is `example/analytics-from-dbt`.

## The MCP surface

Four tools, deliberately hard to misuse:

| Tool | Purpose |
| --- | --- |
| `catalog()` | Discover metrics, dimensions, entities, synonyms, and (when enabled) explorable warehouse columns |
| `query()` | Run a Query Model v1 request: resolve → validate → compile → execute → provenance |
| `validate()` | Dry-run a query without executing it |
| `explain()` | Inspect definitions, trust level, the join plan and the exact SQL |

Agents send analytical intent, not SQL:

```json
{
  "metrics": ["revenue"],
  "dimensions": ["country"],
  "raw_dimensions": ["orders.discount_code"],
  "filters": [{ "field": "customer_type", "operator": "=", "value": "business" }],
  "time": { "period": "last_month", "grain": "month" },
  "order": [{ "field": "revenue", "direction": "desc" }],
  "limit": 100
}
```

Every result leads with a trust headline, then JSON (trust first):

```text
trust: mixed — approved metrics plus raw fields; a lead, not approved truth.
```

```json
{
  "trust": "mixed",
  "headline": "trust: mixed — approved metrics plus raw fields; a lead, not approved truth.",
  "governed": ["revenue"],
  "ungoverned": ["orders.discount_code"],
  "warning": "orders.discount_code is not defined in the Grane semantic model",
  "provenance": {
    "query_id": "q_1faea438cc34",
    "trust": "mixed",
    "query_model": "v1",
    "metrics": { "revenue": { "definition_version": "a82cf1d3" } },
    "generated_sql": "SELECT ...",
    "executed_at": "2026-08-25T12:00:00Z"
  }
}
```

See [docs/connect-an-agent.md](docs/connect-an-agent.md) for ChatGPT, Claude,
Gemini, Cursor, and `grane mcp connect`. See [docs/mcp-setup.md](docs/mcp-setup.md)
for MCP tool reference and config file formats.

## The trust contract

Grane is **semantic-first, not semantic-only**. A company should not have to
model its entire warehouse before agents can investigate. Define Revenue, MRR,
Customers; let agents explore `discount_code` or `device_type` when policy
allows. Grane still compiles the SQL — agents never get unrestricted SQL by
default.

| `trust` | Meaning |
| --- | --- |
| `governed` | Every field came through an approved Grane definition. Present as business truth. |
| `mixed` | Approved metrics combined with permitted raw warehouse fields. A strong lead, not an approved conclusion. |
| `exploratory` | Raw warehouse data only. Investigation, not governed analytics. |

Enable exploration in `grane.yml`:

```yaml
exploration:
  enabled: true
  schemas:
    - public
  exclude:
    - users.password_hash
    - customers.ssn
```

Set `enabled: false` to refuse every raw column. Excluded columns are never
queryable. The database credentials used by Grane should remain read-only.

When a raw field is repeatedly useful:

```bash
grane usage                          # orders.discount_code used in 47 analyses
grane promote orders.discount_code   # writes a governed dimension to dimensions.yml
```

When Grane returns `trust: governed`, it guarantees that every metric and
dimension was explicitly defined in the semantic model, every join was known
and cardinality-safe, no business logic was invented by an LLM, the SQL is
inspectable, and the exact definition versions are identified. If Grane
cannot safely resolve the requested meaning, it refuses instead.

## What Grane is not

No dashboards, no chart builder, no built-in chatbot, no hosted data plane,
no required LLM API key. Agents own presentation; Grane owns analytics truth
— and always says which numbers are governed and which are exploratory.

## Development

```bash
npm install
npm run test:unit                                        # no database needed
docker compose -f example/docker-compose.yml up -d --wait
npm test                                                 # unit + integration

npm install -D @duckdb/node-api
npm run test:benchmark                                   # A/B/C thesis benchmark
npm run test:gauntlet                                    # internal robustness gauntlet
```

See [docs/warehouses.md](docs/warehouses.md) for supported warehouses
(Postgres, MySQL, Snowflake, BigQuery, DuckDB, ClickHouse, Redshift,
Databricks); extra drivers are optional installs. Production Docker:
[docs/production.md](docs/production.md).

`tests/benchmark` asks the same questions of the DuckDB example shop three ways
— direct warehouse SQL, SQL written from a well-written `SKILL.md`, and the
Grane Query Model — and scores all three against independently reviewed SQL. See
[tests/benchmark/README.md](tests/benchmark/README.md).

`tests/gauntlet` is the internal robustness suite: a hostile warehouse and
hundreds of scenarios designed to make Grane return the wrong number, bypass a
permission, or label exploration as governed. Each scenario has an expected
disposition (`EXECUTE` / `EXPLORE` / `CLARIFY` / `REFUSE_SAFETY` /
`REFUSE_POLICY` / `UNSUPPORTED`). A refusal cannot pass a scenario that should
execute. See [tests/gauntlet/README.md](tests/gauntlet/README.md).

## License

Apache-2.0
