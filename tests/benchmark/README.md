# The A/B/C thesis benchmark

Does a good agent plus a database MCP plus a well-written `SKILL.md` already
answer analytics questions correctly, or does a deterministic semantic layer earn
its keep? This suite asks the same 29 questions of the same DuckDB example shop
three ways and scores the answers against independently reviewed SQL.

| path | what it is                                                                 |
| ---- | -------------------------------------------------------------------------- |
| A    | Direct warehouse SQL — what an unconstrained agent with a database MCP emits |
| B    | Warehouse SQL written from [`SKILL.md`](./SKILL.md) — correct metric prose, model still writes the joins |
| C    | Grane Query Model v1 — the agent sends intent, `GraneKernel` compiles the SQL |

No LLM is called. Paths A and B are handwritten SQL fixtures in
[`cases.ts`](./cases.ts), so the run is deterministic and repeatable. Gold
answers are separate reviewed SQL in the same file, executed against the same
`warehouse.duckdb`; Grane never scores itself.

## Running it

```bash
npm install
npm install -D @duckdb/node-api   # the benchmark's only extra dependency
npm run test:benchmark
```

Without `@duckdb/node-api` the suite skips with a message rather than failing, so
CI can run it without making DuckDB a default runtime install.

Relative periods are anchored to the newest timestamp in the warehouse, not to
wall-clock now, and the project timezone is pinned to UTC. The example database
is seeded relative to its build time, so anchoring to the data keeps the numbers
stable and keeps "last month" populated however long after the build it runs.

## Reading the scores

Each question is graded on four independent dimensions, each with its own
denominator (`.` in the per-case table means not applicable):

- **numeric** — does the answer match gold, to the penny? Graded only where a
  correct answer exists.
- **definition** — does the SQL apply the metric definition: the right status
  filter, and the period measured on the right timestamp column? Grane's
  generated SQL is checked by exactly the same rules as the handwritten
  fixtures, with parameters inlined first.
- **grain** — does the outermost query join a one-to-many child of its own base
  table? `payments`, `refunds` and `order_items` all fan out `orders`, so joining
  them without pre-aggregating first multiplies the base rows. The cardinality
  facts live in [`sql.ts`](./sql.ts), read off the schema by hand rather than
  from Grane's join planner.
- **refusal** — for questions with no correct answer (revenue below order grain,
  metrics the model has no data for), did the path refuse instead of returning a
  plausible number? Graded on every question, so refusing an answerable one
  costs the same as answering an unanswerable one.

Path C additionally records the trust label it returned: `governed`, `mixed`
(governed metric plus a raw warehouse column) or `exploratory` (raw columns
only).

## What fails the build

Only a broken harness: gold SQL that will not run, a fixture that will not run,
path C unable to execute, gold SQL that its own ruler rejects, or scoring that
produced nothing. Low scores for A and B are the finding, not a failure.

Three assertions do encode the thesis, and would fail if it stopped holding:
path C never returns a number for a grain-unsafe or undefined question, path C
emits no fan-out join at the query grain, and path C beats path A on both
numeric and refusal correctness.
