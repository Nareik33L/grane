# Canonical demo

The shop lives in [`demo/`](../demo/). This file is a pointer so older links
and `example/DEMO.md` still work.

```bash
npx grane-analytics demo
# from a clone: npm run demo

grane -p demo/analytics mcp connect cursor
```

Ask: *Why did revenue fall last month?*

You should see: revenue down ~14%, Germany the outlier, card authentication
failures the lead. Revenue and geography are governed. The failure-code slice
is exploratory. `customers.email` is blocked. Grouping revenue by
`product_category` is refused.

Full script and schema traps: [`demo/README.md`](../demo/README.md).
Questions: [`demo/questions.md`](../demo/questions.md).

Postgres:

```bash
docker compose up
# or: npm run demo:postgres   # after docker compose up -d postgres --wait
```
