# Grane demo shop

A small SaaS/e-commerce warehouse with a planted last-month revenue drop.

```bash
# from the repo root
npm run demo
# after grane-analytics@0.6.5 is on npm: npx grane-analytics demo
# optional Postgres: docker compose up -d postgres --wait && npm run demo:postgres
```

The default run builds `analytics/warehouse.duckdb` and points `analytics/grane.yml` at it.
Later `query` / `validate` / MCP commands use that DuckDB file. Docker is not required.

The 40-second walkthrough is [`why-revenue-fell.gif`](why-revenue-fell.gif) (still: [`why-revenue-fell.svg`](why-revenue-fell.svg)).

Then ask an agent:

> Why did Revenue fall last month?

## What you should see

1. **Revenue last month** — down about 14%, `trust: governed`.
2. **Revenue by country** — Germany is the outlier, `trust: governed`.
3. **Failed payments by failure_code** in Germany — `CARD_AUTH_FAILED` is up sharply, `trust: mixed` / exploratory.

The agent reasons. Grane only executes. There is no dashboard and no Grane-written prose.

`failure_code` is not in the semantic model. Grane still allows it because the column is permitted. Grouping **completed revenue** by a payment column would fan out and is refused; the investigation therefore counts failed payments at payment grain.

## Layout

| path | what |
| --- | --- |
| `seed/` | Postgres + DuckDB schema and data |
| `analytics/` | Grane project (`grane.yml`, metrics, dimensions, relationships) |
| `questions.md` | Example questions, including grain traps and blocked PII |
| `mcp.json` | Ready-to-paste MCP snippet |
| `run.sh` | Same investigation as `grane demo` |

`customers.email` is excluded. `support_tickets` and `checkout_events` are one-to-many children used as grain traps.

This dataset is also the A/B/C thesis benchmark in `tests/benchmark`.
