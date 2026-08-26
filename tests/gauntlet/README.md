# Grane Gauntlet (internal)

The Gauntlet is **not** the public A/B/C usefulness benchmark in
`tests/benchmark`. That suite asks whether Grane helps an agent compared with
raw SQL and a `SKILL.md`. This suite asks a different question:

> How badly can we break Grane?

It assumes Grane is wrong until a scenario fails to prove it wrong. A crash is
undesirable. A plausible-looking incorrect analytical answer is much worse.

**When Grane cannot deterministically prove that a query is safe, it must
refuse rather than guess.** A safe refusal is a pass.

## Running it

```bash
npm install
npm install -D @duckdb/node-api   # already a repo devDependency
npm run test:gauntlet
```

Without DuckDB the suite skips rather than failing, same as the public
benchmark.

## Outcomes

| result | meaning |
| --- | --- |
| `PASS` | Safe execution, mathematically correct against independent gold |
| `PASS — SAFE REFUSAL` | Grane identified that the request cannot be safely resolved |
| `PASS — EXPLORATORY` | Permitted exploration, correctly labelled `mixed` / `exploratory` |
| `FAIL` | Bug that does not necessarily produce a wrong number (bad error, crash) |
| `CRITICAL FAIL` | Wrong number, silent fan-out, unsafe join, wrong grain, wrong trust |
| `SECURITY CRITICAL` | Blocked column, write, injection, permission bypass, secret leak |

CI does **not** fail because Grane cannot yet pass every scenario. A healthy
Gauntlet keeps adding cases Grane cannot pass. CI fails only when:

- gold SQL disagrees with the TypeScript fixtures (the harness is wrong)
- scenario ids collide or the suite is far too small
- a known defect-class mutation (no cardinality check, empty exclude list)
  stays green — meaning the suite would not have caught that bug

## Ground truth

Every numeric check has two independent sources, neither of which is Grane:

1. TypeScript reductions over `data.ts` (the seed arrays)
2. Reviewed SQL in `gold.ts`, executed against the same DuckDB warehouse

Cardinality facts in `SAFE_SLICES` / `ONE_TO_MANY` are read off the schema by
hand. They are not taken from Grane's relationship graph.

## Public benchmark vs this suite

```text
PUBLIC BENCHMARK   (tests/benchmark)   → prove usefulness
INTERNAL GAUNTLET  (tests/gauntlet)    → prove robustness
```

Do not merge the two. Do not optimise this suite for 100%.
