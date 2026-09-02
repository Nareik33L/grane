# Grane

**The open-source analytics harness for AI agents.**

Agents reason. Grane executes.

Connect a warehouse, define the metrics that matter, and give any MCP agent
governed access to those definitions — plus permissioned exploration of
everything else, clearly labelled.

**Self-hosted. Deterministic. Semantic-first, not semantic-only.**

> Your AI can write SQL. That doesn't mean it knows what Revenue means.
> Grane tells it which numbers are authoritative and which conclusions are exploratory.

---

## Try it (one command)

Requires Node 20+. No Docker. No API keys for Grane.

```bash
npx grane-analytics demo
```

From a clone:

```bash
git clone https://github.com/Nareik33L/grane.git
cd grane
npm install
npm run demo
```

That builds a local DuckDB shop, runs governed queries, shows a mixed-trust
slice, and prints the question to ask an agent:

> Why did revenue fall last month?

Then connect a local agent (stdio, not ChatGPT HTTPS) using the project path
`demo` printed:

```bash
grane -p example/analytics-duckdb mcp connect cursor
# also: claude, vscode, gemini
```

Restart the client, open a **new chat**, and ask the question. The agent
should call Grane tools — not write analytical SQL.

Expected investigation (agent plans, Grane compiles):

1. Governed `revenue` last month vs the prior month — **trust: governed**
2. Slice by `channel` — partner is the decline
3. Investigate `orders.discount_code` — **trust: mixed** (a lead, not approved truth)
4. Optional: `product_category` is refused (below order grain); `customers.email` is blocked

Full script: **[example/DEMO.md](example/DEMO.md)**

The CLI command is `grane` (`npx grane-analytics` runs the same binary).
Postgres is bundled; DuckDB is pulled for this demo. Other warehouse drivers
stay optional.

---

## Why Grane exists

AI agents can already write SQL. Your database does not know the company's
approved definition of Revenue — and letting an LLM invent it produces
plausible, wrong numbers.

```text
Your agent (Cursor / Claude / Gemini / ChatGPT)  — your LLM keys
        |
        | MCP  (no LLM key)
        v
     GRANE     metrics, compiler, join/grain safety, provenance
        |
        | read-only SQL Grane compiled
        v
Your warehouse
```

- **The agent reasons. Grane executes.** Agents send semantic requests
  (`revenue` by `channel` last month). Grane resolves definitions, plans
  joins, compiles SQL, and runs it read-only. Agents do not get a SQL tool
  for analytics.
- **Three trust levels.** `governed` (approved definitions), `mixed`
  (approved metrics plus raw fields — a lead), `exploratory` (raw warehouse
  data). The first sentence of every answer must be the trust headline.
- **Refusal is a trust feature.** Undefined metrics, unsafe grains, and
  excluded columns return structured errors. Grane never invents business
  logic.
- **No LLM inside.** Deterministic infrastructure. Nothing leaves your
  environment.

---

## Connect an agent

After the demo (or after `grane validate` on your own project):

```bash
grane mcp doctor
grane mcp connect cursor    # claude, vscode, gemini, …
```

Desktop clients use **stdio** (`grane serve --stdio` launched by the agent).
ChatGPT needs a **public HTTPS** URL — that is not the first-run path.

Walkthrough: **[docs/connect-an-agent.md](docs/connect-an-agent.md)**  
MCP tools: **[docs/mcp-setup.md](docs/mcp-setup.md)**

---

## Your own Postgres

Once the demo makes sense:

```bash
npm install -g grane-analytics
mkdir analytics && cd analytics
grane init
export DATABASE_URL=postgres://readonly_user:...@host:5432/db
grane discover --write-relationships
# define entities and about five metrics
grane validate
grane query revenue -d country --last 30d
grane mcp connect cursor
```

Use a **read-only database user**. Grane also wraps queries in a `READ ONLY`
transaction, but the warehouse remains the security boundary.

Step-by-step: **[docs/first-week.md](docs/first-week.md)**  
Production HTTP (Docker, TLS, agent tokens): **[docs/production.md](docs/production.md)**  
Warehouses: **[docs/warehouses.md](docs/warehouses.md)**  
Existing dbt / Cube / LookML / Ossie models: **[docs/providers.md](docs/providers.md)**

---

## Defining metrics

YAML, reviewed in pull requests, versioned in Git:

```yaml
metrics:
  revenue:
    description: Net revenue from completed orders
    owner: finance
    entity: order
    type: sum
    sql: ${orders.net_amount}
    time_dimension: ${orders.completed_at}
    unit: GBP
    status: approved
    synonyms: [sales, net sales]
    filters:
      orders.status: completed
```

`grane validate` checks references against the live schema and refuses unsafe
fan-out before an agent runs a query.

---

## The MCP surface

Four tools, deliberately hard to misuse:

| Tool | Purpose |
| --- | --- |
| `catalog()` | Discover metrics, dimensions, entities, and (when enabled) explorable columns |
| `query()` | Resolve → validate → compile → execute → provenance |
| `validate()` | Dry-run without executing |
| `explain()` | Definitions, join plan, exact SQL |

```json
{
  "metrics": ["revenue"],
  "dimensions": ["channel"],
  "raw_dimensions": ["orders.discount_code"],
  "time": { "period": "last_month" }
}
```

Every result leads with a trust headline. `generated_sql` is Grane's, not the
agent's.

| `trust` | Meaning |
| --- | --- |
| `governed` | Approved definitions only. Present as business truth. |
| `mixed` | Approved metrics plus permitted raw fields. A lead, not an approved conclusion. |
| `exploratory` | Raw warehouse data only. Investigation, not governed analytics. |

```yaml
exploration:
  enabled: true
  schemas: [main]
  exclude:
    - customers.email
```

`grane promote orders.discount_code` writes a governed dimension when a raw
field earns it.

---

## What Grane is not

No dashboards, no chart builder, no built-in chatbot, no hosted data plane,
no required LLM API key. Agents own presentation; Grane owns analytics truth
— and always says which numbers are governed and which are exploratory.

---

## Development

```bash
npm install
npm run demo                 # DuckDB shop; also npm run demo:postgres
npm run test:unit            # no database needed
npm test                     # unit + integration (Postgres on :5433)
npm run test:benchmark       # A/B/C thesis benchmark
npm run test:gauntlet        # internal robustness suite
```

`tests/benchmark` asks the same questions of the demo shop three ways. See
[tests/benchmark/README.md](tests/benchmark/README.md).

`tests/gauntlet` is the internal robustness suite. See
[tests/gauntlet/README.md](tests/gauntlet/README.md).

## License

Apache-2.0
