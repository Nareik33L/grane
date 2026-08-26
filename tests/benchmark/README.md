# The A/B/C thesis benchmark

Does a good agent plus a database MCP plus a well-written `SKILL.md` already
answer analytics questions correctly, or does a deterministic semantic layer earn
its keep? This suite asks the same ~50 questions of the canonical demo shop
(`demo/`) three ways and scores the answers against independently reviewed SQL.

| path | what it is |
| ---- | ---------- |
| A    | Direct warehouse SQL — what an unconstrained agent with a database MCP emits |
| B    | Warehouse SQL written from [`SKILL.md`](./SKILL.md) — correct metric prose, model still writes the joins |
| C    | Grane Query Model v1 — the agent sends intent, `GraneKernel` compiles the SQL |

No LLM is called. Paths A and B are handwritten SQL fixtures in
[`cases.ts`](./cases.ts), so the run is deterministic and repeatable. Gold
answers are separate reviewed SQL in the same file, executed against the same
demo warehouse; Grane never scores itself.

That is deliberate. Live agents are probabilistic; these fixtures are a
reproducible ruler. Path C is compiled five times in CI to show the SQL does
not drift. If you run a live agent against the same questions, publish those
numbers too — they are allowed to surprise us.

## Running it

```bash
npm install
npm run test:benchmark
```

The shop is built from `demo/seed/duckdb.sql` at the start of the run (relative
dates, so last_month stays populated). Relative periods are anchored to the
newest timestamp in the warehouse.

## What is scored

Each question is graded independently:

- **numeric** — does the answer match gold, to the penny?
- **definition** — right status filter, right timestamp column?
- **grain** — no one-to-many join at the query grain without pre-aggregation
- **refusal** — refuse when there is no correct single answer
- **permission** — do not reference blocked PII (`customers.email`)

The suite is not constructed so Grane must win. Path B is allowed to score
highly: the SKILL.md is written to be correct. Join pre-aggregation and
enforced PII are where a compiler still earns its keep.

## What fails the build

Only a broken harness: gold SQL that will not run, a fixture that will not run,
path C unable to execute, gold SQL that its own ruler rejects, or scoring that
produced nothing. Low scores for A and B are the finding, not a failure.

Thesis assertions: path C never returns a number for a grain-unsafe or
undefined question, emits no fan-out join at the query grain, beats path A on
numeric and refusal correctness, and compiles identical SQL five times.
