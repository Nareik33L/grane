# Grane Gauntlet (internal)

The Gauntlet is **not** the public A/B/C usefulness benchmark in
`tests/benchmark`. That suite asks whether Grane helps an agent compared with
raw SQL and a `SKILL.md`. This suite asks a different question:

> How badly can we break Grane?

It assumes Grane is wrong until a scenario fails to prove it wrong. A crash is
undesirable. A plausible-looking incorrect analytical answer is much worse.

The suite tracks **two independent dimensions**:

- **Behavioural correctness** — every scenario produces its expected
  disposition and the correct result/behaviour. Target: 100%.
- **Capability** — of scenarios that are *legitimately expected to be
  answerable*, what share Grane can already `EXECUTE` or `EXPLORE`. Raise
  this by teaching the kernel new deterministic semantics, never by converting
  executable work into refusals, and never by counting deliberate refusal
  tests as missed capability.

Do **not** report capability as `(EXECUTE + EXPLORE) / all Gauntlet scenarios`.
Many scenarios exist specifically to prove that Grane refuses.

A refusal must **not** pass a scenario whose expected disposition is
`EXECUTE` or `EXPLORE`. Generic refuse must **not** pass `CLARIFY`.
Execution of a `REFUSE_SAFETY` / `REFUSE_POLICY` scenario is a critical
failure.

## Running it

```bash
npm install
npm install -D @duckdb/node-api   # already a repo devDependency
npm run test:gauntlet
```

Without DuckDB the suite skips rather than failing, same as the public
benchmark.

## Expected dispositions

Every scenario has an expected disposition. Grane only passes if it produces
that class of outcome (and the gold number / trust label when executing).

| disposition | meaning |
| --- | --- |
| `EXECUTE` | Deterministic governed answer. Gold must match. |
| `EXPLORE` | Safe execution on non-governed data, labelled `mixed` / `exploratory`. |
| `CLARIFY` | Multiple valid interpretations; structured `ambiguous_query`. |
| `REFUSE_SAFETY` | Grain / cardinality / query-safety / stale-model violation. |
| `REFUSE_POLICY` | Permissions, blocked columns, exploration disabled. |
| `INVALID` | Malformed, hostile, or impossible input. Structured `invalid_query` (or Query Model rejection). Not a capability gap. |
| `UNSUPPORTED` | Grane could theoretically answer this safely and deterministically, but the kernel does not yet have that capability. Must not be used for policy, safety, ambiguity, or malformed input. |

See `UNSUPPORTED.md` for the audit of the former 56-count bucket.

## Scorecard metrics

| Metric | Definition | Target |
| --- | --- | --- |
| Behavioural correctness | Correct disposition **and** behaviour / all scenarios | 100% |
| Answerable capability coverage | `(EXECUTE + EXPLORE)` among scenarios whose expected set is only `EXECUTE`, `EXPLORE`, and/or true `UNSUPPORTED` | Increase over time |
| Safety accuracy | Correct `REFUSE_SAFETY` / exclusive expected `REFUSE_SAFETY` | 100% |
| Policy accuracy | Correct `REFUSE_POLICY` / exclusive expected `REFUSE_POLICY` | 100% |
| Clarification accuracy | Correct `CLARIFY` / exclusive expected `CLARIFY` | 100% |
| Unsupported count | Otherwise-legitimate analytical scenarios the kernel cannot yet support | Decrease without harming correctness |
| Invalid input | Malformed/hostile payloads correctly rejected | Count; not a capability remainder |

## Outcomes

| result | meaning |
| --- | --- |
| `PASS` | `EXECUTE` — mathematically correct against independent gold |
| `PASS — EXPLORATORY` | `EXPLORE` — permitted exploration, correctly labelled |
| `PASS — CLARIFY` | `CLARIFY` — structured request for a unique interpretation |
| `PASS — SAFE REFUSAL` | `REFUSE_SAFETY` |
| `PASS — POLICY` | `REFUSE_POLICY` |
| `PASS — INVALID` | `INVALID` — malformed input rejected, not a guessed answer |
| `PASS — UNSUPPORTED` | `UNSUPPORTED` — true capability gap, not a guessed answer |
| `FAIL` | Bug that does not necessarily produce a wrong number (bad error, crash) |
| `CRITICAL FAIL` | Wrong number, silent fan-out, unsafe join, wrong grain, wrong trust |
| `SECURITY CRITICAL` | Blocked column, write, injection, permission bypass, secret leak |

CI does **not** fail because Grane cannot yet pass every scenario. A healthy
Gauntlet keeps adding cases Grane cannot pass. CI fails only when:

- gold SQL disagrees with the TypeScript fixtures (the harness is wrong)
- scenario ids collide or the suite is far too small
- a known defect-class mutation (no cardinality check, empty exclude list)
  stays green — meaning the suite would not have caught that bug

Do not delete, weaken, or rewrite scenarios merely to raise the score.
Do not turn executable failures into refusals.
Do not reclassify a scenario merely because Grane currently cannot satisfy it.

The original 908 scenarios are permanent regression tests. New coverage is
additive: last-as-of adversarial cases (`tests/gauntlet/scenarios/semi.ts`)
and COMPOSITION HELL (`composition` category) combine features that already
work in isolation. Every composition has gold from TypeScript fixtures or
reviewed SQL, never from Grane.

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

Do not merge the two. Behavioural correctness is 100%; capability grows as
the kernel learns new deterministic semantics.
