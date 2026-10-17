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
| **(b) Independent SQL** | Handwritten SELECT against the warehouse driver (`@duckdb/node-api` or `pg`). No Grane kernel, no Grane connector, no compiler SQL, and **no import of `src/query/time.ts`**. Relative periods are computed in the SQL from `max(orders timestamps)` (`date_trunc` / `make_date` / intervals). Definitions follow `demo/analytics/metrics.yml` (completed orders, `completed_at`, pre-aggregate one-to-many payments). Independent SQL is written to run on both DuckDB and Postgres (e.g. `DOUBLE PRECISION`, not DuckDB-only `DOUBLE`). |

The two paths are not allowed to share SQL. If Grane refuses a grain trap, path
(b) still runs the naive join so the log shows the number an ungoverned query
would have returned.

## Data

- **DuckDB** — `demo/seed/duckdb.sql`, the warehouse `npx grane demo` builds.
- **Postgres (CI)** — `demo/seed/01_schema.sql` + `02_data.sql` loaded into an
  isolated `grane_cons_*` schema on the GitHub Actions Postgres 16 service
  (`GRANE_PG_WRITE_URL`). `public` is left empty. Runtime queries use the
  `grane_readonly` role.
- **Postgres (this agent's recorded JSON)** — a local Ubuntu `postgresql-16`
  16.15 install on `127.0.0.1:5432`, not the Actions service. CI still
  re-executes against the Actions `postgres:16` container.

Dates in the seed are `CURRENT_DATE`-relative. Relative periods (`last_month`,
`30d`, `last_quarter`, `q2`) are anchored to `max(orders timestamps)`, not
wall-clock now. Path (a) pins kernel `now` to that timestamp and uses
`time.period`. Path (b) encodes the same windows in SQL.

## Expected outcomes

| kind | questions | pass when |
| ---- | --------- | --------- |
| `match` (12) | revenue last month / orders / AOV / Q2 / last quarter / 30d / by country / by plan / by channel last month / payments by country / revenue+payments / customer count | both answer, non-empty, non-zero, **same row count**, cells equal to the penny |
| `mismatch` (1) | “How many customers ordered last month?” | Grane equals **governed SQL** (customers created last month); independent SQL is distinct completed-order customers; the two differ. Any other Grane number (including +1) fails. |
| `grane_refuses` (3) | revenue by product category / ticket category / checkout event type | Grane status is **`unsafe_query`** (not `invalid_query`); independent SQL still returns a non-empty non-zero table |

The runner prints `match=12 refuse=3 mismatch=1`, not `16/16`. The suite fails
if the harness is broken, a required engine cannot run, a `match` pair
diverges or is empty/trivial, a grain trap is not `unsafe_query`, Grane misses
the governed value on the definition pair, or a committed all-time figure was
tampered.

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

The snapshot is [`tests/consistency/results/committed.json`](../tests/consistency/results/committed.json)
(DuckDB v1.5.5 and local PostgreSQL 16.15). Classification: 12 match, 3 refuse,
1 mismatch. Open the JSON for every cell.

All-time questions (no relative period) are checked against that file: changing
a committed cell must fail the suite. Time-windowed questions are re-executed
live and are not locked to the snapshot, because the seed is `CURRENT_DATE`-relative.

Each `--write` run also writes timestamped JSON/CSV (`consistency-<UTC>-<sha12>.*`)
and copies the same payload to `committed.json`. Every file includes `ran_at` and
`commit_sha` (`git rev-parse HEAD` at execution; that revision is the parent of
the commit that adds the files). `--write` refuses a dirty tree, so `git_dirty`
is false.

**Do not edit result files by hand.** Regenerated with `--write` only.

## What this is not

- Not the A/B/C thesis benchmark (`tests/benchmark`), which scores naive vs
  SKILL.md vs Grane against reviewed gold SQL on DuckDB only.
- Not a publish, tag, or token step.
- Not live MCP HTTP in this suite: path (a) is `GraneKernel.query`, which is
  what `src/mcp/server.ts` registers as the `query` tool. Spinning an HTTP
  server is not required to exercise that path.

## AI answer consistency (Release 1 item 5b)

Same 16 questions as above, asked of this model (`Cursor Grok 4.6`) two ways,
five times each:

| path | what the model saw | what was executed |
| ---- | ------------------- | ----------------- |
| **A** | DuckDB DDL only. No metrics.yml, no Grane tools. | The model's SQL on demo DuckDB (`demo/seed/duckdb.sql`). |
| **B** | Compiled Grane catalog JSON (metrics, dimensions, exploration columns, time periods). No warehouse DDL, no `query` HTTP server. | The model's Query Model v1 object through `GraneKernel.query` (same call the MCP `query` tool makes). |

Exact prompts: [`tests/consistency/ai-runs/prompts/path-a.txt`](../tests/consistency/ai-runs/prompts/path-a.txt) and [`path-b.txt`](../tests/consistency/ai-runs/prompts/path-b.txt). Temperature is **not controllable** in this runtime (recorded as that string, not a guessed number). Attempt files under [`tests/consistency/ai-runs/attempts/`](../tests/consistency/ai-runs/attempts/) and per-question transcripts under [`transcripts/`](../tests/consistency/ai-runs/transcripts/) are unedited. Scoring is only [`npx tsx tests/consistency/ai-runs/score.ts`](../tests/consistency/ai-runs/score.ts) against #117's expected outcome per question (match value, `unsafe_query` refusal, or governed value) — not against the independent-SQL grain-trap numbers. The generated table is [`SUMMARY.md`](../tests/consistency/ai-runs/SUMMARY.md). Do not copy figures into this document.

**Limits (this is not an independent lab study):** one model; temperature not controllable; each round asked all 16 questions in one prompt (within-round leakage); path B is `GraneKernel.query`, not a live MCP HTTP session; no API keys. The five rounds per path were isolated subagent contexts told not to read `questions.ts`. Identical prompts can still yield identical answers. The `attempts/*.json` “raw” replies are files the agent wrote, not API logs. Report only what SUMMARY.md shows, including any variance (or lack of it) on the Grane path.
