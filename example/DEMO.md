# Canonical demo

This is the shortest path from a clone (or `npx`) to a governed analytical
answer. The shop is fictional. The failure mode is not.

## The question

> Why did revenue fall last month?

Ask that of any MCP agent connected to this project. Do not ask it to write
SQL.

## What the data contains

Completed order revenue is deterministic and relative to today:

| Month | web | mobile | partner | total |
| --- | ---: | ---: | ---: | ---: |
| Prior calendar month | 8,000 | 5,400 | 8,000 | 21,400 |
| Last calendar month | 8,000 | 5,400 | 4,800 | 18,200 |

Last month's partner orders all carry the ungoverned warehouse column
`orders.discount_code = PARTNER20`. That field is **not** a governed
dimension. `customers.email` is excluded. `product_category` sits below the
order grain, so combining it with `revenue` is refused.

## What you should see

The **agent** chooses the investigation. **Grane** compiles and executes.

1. `catalog()` — discover `revenue`, `orders`, `channel`, `country`, and the
   explorable column `orders.discount_code`.
2. Governed `query`: `revenue` for `last_month`, then the prior month (or
   month grain over those two months). **trust: governed.** Provenance
   includes `generated_sql` authored by Grane.
3. Governed slice: `revenue` by `channel` for last month. Partner is the
   decline.
4. Controlled exploration: same query with
   `raw_dimensions: ["orders.discount_code"]`. **trust: mixed.** The warning
   says `discount_code` is not an approved definition. Treat it as a lead.
5. Optional safety beat: `dimensions: ["product_category"]` → structured
   `unsafe_query`. Optional policy beat: `raw_dimensions: ["customers.email"]`
   → `column_not_permitted`. Report the refusal. Do not invent SQL.

The agent's reply must open with the trust headline and distinguish governed
facts (the partner revenue drop) from exploratory evidence (PARTNER20).

## Agent brief (paste into chat if the client needs a nudge)

```text
Use Grane. Do not write SQL.

Question: Why did revenue fall last month?

1. Call catalog().
2. Query governed metrics only at first (revenue, last_month, then the prior
   month; then revenue by channel).
3. After you identify the declining governed slice, investigate permitted raw
   columns such as orders.discount_code. Label that result trust: mixed.
4. If Grane refuses a query (product_category, customers.email, …), report the
   refusal instead of writing SQL.
5. Start your answer with the trust headline. Separate governed facts from
   exploratory leads.
```

## Commands

```bash
npx grane-analytics demo
# from a clone: npm run demo

grane -p example/analytics-duckdb mcp connect cursor
```

Postgres (optional, needs Docker):

```bash
docker compose -f example/docker-compose.yml down -v
docker compose -f example/docker-compose.yml up -d --wait
npm run demo:postgres
```

Reseed Postgres after schema changes with `down -v` so init scripts re-run.
