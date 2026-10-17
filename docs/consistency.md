# Grane vs independent SQL consistency

Release 1 item 5. Same metric questions, same demo shop, two execution paths,
two certified engines. Figures in this repository come from recorded runs under
[`tests/consistency/results/`](../tests/consistency/results/). Do not copy
numbers into this document by hand.

## What is compared

Each question from [`demo/questions.md`](../demo/questions.md) (simple metrics,
time windows, dimensions, multi-table, grain traps, and the
customers-vs-ordered definition pair) is asked:

| path | how |
| ---- | --- |
| **(a) Grane** | `GraneKernel.query` — the same call the MCP `query` tool makes. Intent is a Query Model v1 request (`metrics`, `dimensions`, `time.period`, …). Grane compiles and executes. |
| **(b) Independent SQL** | Handwritten SELECT against the warehouse driver (`@duckdb/node-api` or `pg`). No Grane kernel, no Grane connector, no compiler SQL. Definitions follow `demo/analytics/metrics.yml` (completed orders, `completed_at`, pre-aggregate one-to-many payments). Independent SQL is written to run on both DuckDB and Postgres (e.g. `DOUBLE PRECISION`, not DuckDB-only `DOUBLE`). |

The two paths are not allowed to share SQL. If Grane refuses a grain trap, path
(b) still runs the naive join so the log shows the number an ungoverned query
would have returned.

## Data

- **DuckDB** — `demo/seed/duckdb.sql`, the warehouse `npx grane demo` builds.
- **Postgres** — `demo/seed/01_schema.sql` + `02_data.sql` loaded into an
  isolated `grane_cons_*` schema on the certified CI Postgres 16 service
  (`GRANE_PG_WRITE_URL` / `127.0.0.1:5432` / demo `localhost:5433`). `public`
  is left empty. Runtime queries use the `grane_readonly` role.

Dates in the seed are `CURRENT_DATE`-relative. Relative periods (`last_month`,
`30d`, `last_quarter`, `q2`) are anchored to `max(orders timestamps)`, not
wall-clock now, so last_month stays populated. Path (a) gets that instant as
kernel `now` and uses `time.period`; path (b) resolves the same ranges with
`resolveRelativeRange` / `namedQuarterRange` independently.

## Expected outcomes

| kind | questions | pass when |
| ---- | --------- | --------- |
| `match` | revenue / orders / AOV / Q2 / last quarter / 30d / by country / by plan / by channel last month / payments by country / revenue+payments / customer count | both answer, cells equal to the penny (order-insensitive) |
| `mismatch` | “How many customers ordered last month?” | both answer, cells **differ** (Grane `customers` + `last_month` is `customers.created_at`; independent SQL is distinct completed-order customers) |
| `grane_refuses` | revenue by product category / ticket category / checkout event type | Grane refuses; independent SQL still returns rows |

The suite fails if the harness is broken, a required engine cannot run, a
`match` pair diverges, a grain trap is answered by Grane, or the definition
pair accidentally agrees.

## How to rerun

```bash
npm install
# live compare (also run in CI)
npm run test:consistency

# record JSON + CSV under tests/consistency/results/
npx tsx tests/consistency/run.ts --write
npx tsx tests/consistency/run.ts --engine duckdb --write
npx tsx tests/consistency/run.ts --engine postgres --write
```

CI GitHub Actions already starts Postgres 16. Locally, Postgres is optional
unless `GRANE_CERT_REQUIRE` includes `postgres` or
`GRANE_CONSISTENCY_REQUIRE_POSTGRES=1`:

```bash
docker compose up -d postgres --wait   # localhost:5433
# or a CI-shaped instance on 5432 with GRANE_PG_WRITE_URL / GRANE_PG_READ_URL
```

If DuckDB’s driver is missing: `npm install -D @duckdb/node-api`. If Postgres
is unreachable, the report status is `skipped` and this document does not
invent Postgres numbers.

## Recorded results

Each `--write` run commits (when you git-add them):

- one JSON file named `consistency-<UTC timestamp>-<sha12>.json`
- one CSV per engine that actually ran, `duckdb-…csv` / `postgres-…csv`

Every file includes `ran_at` (ISO-8601 UTC) and `commit_sha` (the `git rev-parse
HEAD` at execution time — the revision the queries ran against, which may be
the parent of the commit that adds the files). `git_dirty` is true when the
tree was not clean. Question objects store both answers, generated/handwritten
SQL, trust, refusal status, and timings.

**Do not edit result files by hand.** Regenerate them with `--write`. The
vitest gate re-executes the queries; it does not treat committed JSON as gold
numbers, because `CURRENT_DATE`-relative seeds and calendar Q2 move.

## What this is not

- Not the A/B/C thesis benchmark (`tests/benchmark`), which scores naive vs
  SKILL.md vs Grane against reviewed gold SQL on DuckDB only.
- Not a publish, tag, or token step.
- Not live MCP HTTP in this suite: path (a) is `GraneKernel.query`, which is
  what `src/mcp/server.ts` registers as the `query` tool. Spinning an HTTP
  server is not required to exercise that path.
