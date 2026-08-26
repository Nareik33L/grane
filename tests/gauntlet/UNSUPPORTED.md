# Audit: the 56 UNSUPPORTED Gauntlet scenarios

**Date:** 2026-08-26
**Suite size:** 908
**Originally counted as `PASS — UNSUPPORTED`:** 56
**After this measurement pass:** those 56 are relabelled (`INVALID` or
`REFUSE_SAFETY`). Kernel execution is unchanged. True unsupported-capability
count is 0.

This audit does **not** add kernel capabilities. It answers what those 56
actually are, which of them are real capability gaps, and what should be
built next.

## Verdict in one paragraph

**None of the 56 are legitimate analytical questions that Grane cannot yet
answer.** They are 6 malformed time payloads and 50 schema-mutation
robustness checks. Under the definition below they must **not** sit in the
UNSUPPORTED capability bucket. After correcting the label, the true
**unsupported-capability count is 0.** Capability growth from here means
new deterministic semantics (and new scenarios), not converting these 56
into executions.

## Definition used

`UNSUPPORTED` means:

> Grane could theoretically answer this **safely and deterministically**,
> but the kernel does not currently have the required capability.

It does **not** mean:

- prohibited by policy
- inherently unsafe
- genuinely ambiguous
- malformed / hostile / impossible from available information

Those belong in `REFUSE_POLICY`, `REFUSE_SAFETY`, `CLARIFY`, or invalid-input
rejection.

---

## The 56, grouped

### A. Malformed time input — 6

Kernel already rejects these with structured `invalid_query`. That is
correct. They are **not** missing calendar math.

| id | Query | Why it is labeled UNSUPPORTED today | True class | Become executable? |
| --- | --- | --- | --- | --- |
| `gen/time/period/not_a_period` | `time.period = "not_a_period"` | Generator treats unknown specs as UNSUPPORTED | **Malformed input** | No. Garbage identifier. |
| `gen/time/period/empty` | `time.period = ""` | Same | **Malformed input** (Query Model `min(1)`) | No. |
| `gen/time/range/non-leap-29-feb` | `2023-02-29 .. 2023-02-29` | Invalid civil date | **Malformed input** | No. 2023-02-29 is not a date. |
| `gen/time/range/from-after-to` | `2025-01-01 .. 2024-01-01` | Inverted range | **Malformed input** | No. |
| `gen/time/range/unpadded-date` | `2024-1-1 .. 2024-1-31` | Not `YYYY-MM-DD` | **Malformed input** | No. Do not guess padding. |
| `gen/time/range/slash-date` | `2024/01/01 .. 2024/01/31` | Not `YYYY-MM-DD` | **Malformed input** | No. |

**Category:** malformed input (was filed under “unsupported time semantics”).
**Correct disposition:** invalid-input rejection, **not** UNSUPPORTED.
**New metadata needed:** none.
**Should remain non-executable:** yes, all 6.

### B. Stale-model validation — 6

Custom checks: after a warehouse schema mutation, `validate()` must fail.
No analytical question is being asked.

| id | Mutation | True class | Become executable? |
| --- | --- | --- | --- |
| `gen/schema/rename-payments-amount` | `payments.amount` → `gross_amount` | **Insufficient semantic information** / model integrity | No. The definition points at a missing column. |
| `gen/schema/drop-orders-net-amount` | drop `orders.net_amount` | same | No. |
| `gen/schema/drop-orders-completed-at` | drop `orders.completed_at` | same | No. |
| `gen/schema/type-net-amount-text` | `net_amount` type → text | same | No. SUM of text is not a safe new semantic. |
| `gen/schema/drop-customers` | drop `customers` table | same | No. |
| `gen/schema/drop-orders-customer-id` | drop `orders.customer_id` | same | No. |

**Category:** insufficient semantic information (stale model).
**Correct disposition:** `REFUSE_SAFETY` (must not silently execute).
**New metadata needed:** none — validation already catches it.
**Should remain non-executable:** yes.

### C. Extra relationship must not start guessing — 44

`gen/schema/extra-rel-0` … `gen/schema/extra-rel-43`

Each adds `extra_N` as `support_tickets.customer_id → customers.id` or
`orders.customer_id → customers.id` (`many_to_one`). Then:

`revenue` by `ticket_category`

must still refuse. The extra edge does not create a fan-out-free path from
orders to tickets. Grane already refuses (`unsafe_query`). That is
**correct safety behaviour**, duplicated 44 times as a mutation test.

**Category:** safety limitation (grain / fan-out), not an implementation gap.
**Correct disposition:** `REFUSE_SAFETY`.
**New metadata needed:** none.
**Become executable?** No, not without a new, proven-safe grain strategy for
two facts sharing a customer. Inventing that to “unlock 44 scenarios”
would be exactly the silent fan-out the Gauntlet exists to catch. The 44
are copies of one invariant.

---

## Counts by requested category

| Category | Count of the 56 | Notes |
| --- | --- | --- |
| unsupported metric semantics | 0 | |
| unsupported time semantics | 0 | The 6 time cases are **malformed**, not missing periods. `this_fiscal_year` already executes. |
| unsupported grain handling | 0 | Extra-rel is existing grain **safety**, already correct. |
| unsupported join planning | 0 | |
| unsupported aggregation | 0 | |
| unsupported exploratory behaviour | 0 | |
| insufficient semantic information | 6 | Stale-model validate tests. |
| genuine ambiguity | 0 | (`ytd` / `q1` / `fy2024` / `countries.name` are already `CLARIFY`, not in the 56.) |
| safety limitation | 44 | Extra-rel / ticket_category still unsafe. |
| policy limitation | 0 | |
| implementation gap | 0 | Nothing here is “we know the answer, we just have not coded it.” |
| malformed / invalid input | 6 | Time payloads. |
| other | 0 | |

**Could reasonably become EXECUTE / EXPLORE:** **0 / 56**
**Require new semantic metadata:** **0 / 56**
**Genuinely should remain non-executable:** **56 / 56**

---

## Mixed dispositions (not in the 56, but labeled with UNSUPPORTED)

42 generated cases previously allowed `UNSUPPORTED` as one of several
acceptable outcomes (`EXECUTE | UNSUPPORTED` on MCP abuse; `EXECUTE |
UNSUPPORTED | CLARIFY` on hostile filters). Those are **hostile / malformed
payload** tests: bind a parameter or reject the payload. They are not a
capability backlog. The unions are now `EXECUTE | INVALID` and
`EXECUTE | INVALID | CLARIFY`.

---

## What is *not* in the 56 but *is* a real capability question

These are the places capability can grow without weakening safety.
They are **absent from the 56** because they were never labeled
UNSUPPORTED — they either already execute under a different meaning, or
they correctly refuse as safety/clarify.

| Opportunity | Current behaviour | If implemented | Scenarios in *this* 56 unlocked | Usefulness | Complexity | Wrong-number risk | Deterministic? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Calendar week (`this_week`, `last_week`) using `project.week.starts` | `1w` / `4w` are rolling N×7 days, not calendar weeks. `week.starts` is unused. | New relative periods | 0 (new scenarios) | High | Low–medium | Low if Monday/Sunday is taken only from config | Yes |
| Unambiguous quarter names (`this_quarter`, `last_quarter`) | `q1` is `CLARIFY` when fiscal year is configured (correct). | New names; leave `q1` as clarify | 0 | High | Low | Low | Yes |
| Named calendar vs fiscal YTD (`ytd_calendar` is `this_year`) | `ytd` is `CLARIFY` (correct) | Do **not** make `ytd` execute | 0 | Medium | Low | High if `ytd` is guessed | Yes only with new names |
| Semi-additive last-as-of **with a range / grain** | Unbounded last-as-of already executes | Already in the compiler; needs Gauntlet cases | 0 | Medium | Already done | Medium (as-of vs last-in-window) | Yes |
| `additive: none` | Inventory is `sum` at product grain; no time snapshots | Optional refuse of cross-time inventory if snapshots appear | 0 | Medium | Low | Medium | Yes |
| Child-grain dimensions (revenue × `product_category`) | `REFUSE_SAFETY` | Pre-agg still hits M2M (product 1 in two categories) | 0 of the 56; would re-open join/grain refusals | High if it were safe | High | **High** | Only for proven 1:1 item rolls; **not** for this fixture |
| `count_distinct` across one_to_many | `REFUSE_SAFETY` | No safe V1 strategy | 0 | Medium | High | **High** | Not yet |
| FX via `exchange_rates` | No metric; duplicate rate on one day | Needs rate policy metadata | 0 | High | High | High (dirty duplicate) | Only with an explicit rate-pick rule |
| As-of join of snapshots to orders | Not a Query Model shape | New join semantic | 0 | High | High | High | Only with an explicit as-of key |

---

## Proposed kernel capability roadmap (do not implement in this change)

**Smallest set with the largest *genuine* capability increase:**

1. **Calendar week periods** honouring `project.week.starts` (`this_week`,
   `last_week`). Real analytics, already-configured, fully deterministic,
   low risk. Then add Gauntlet cases (normal, DST boundaries, Monday vs
   Sunday, hostile specs).
2. **Unambiguous quarter helpers** (`this_quarter`, `last_quarter`) that
   never collide with fiscal `q1`. Keep `q1` / `fy2024` / `ytd` as
   `CLARIFY` while fiscal year is configured.
3. **Gauntlet coverage for semi-additive ranges** (last-as-of period end,
   last-in-grain, empty window) — capability is already in the kernel;
   the suite does not yet try to break it.

**Do not do these to chase coverage:**

- Make `ticket_category` / `product_category` execute. That is a grain
  violation on this warehouse.
- Make `not_a_period` or `2023-02-29` execute.
- Make `ytd` pick calendar vs fiscal.
- Treat extra-rel mutation tests as a backlog of 44 features.

**Ranked against the five criteria**

| Rank | Improvement | # unlocked *in the 56* | Usefulness | Complexity | Risk | Deterministic |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Calendar weeks | 0 (adds new answerable cases) | High | Low–medium | Low | Yes |
| 2 | `this_quarter` / `last_quarter` | 0 (adds new cases) | High | Low | Low | Yes |
| 3 | Semi-additive range/grain tests | 0 (hardens existing) | Medium | Low | Medium | Yes |
| — | Child-grain pre-agg for revenue | would **reduce** safety accuracy if guessed | High | High | Critical | Not on this model |
| — | Distinct across fan-out | 0 | Medium | High | Critical | Not in V1 |

---

## Measurement (to apply with this audit)

Do **not** report capability as `(EXECUTE + EXPLORE) / 908`.

| Metric | Definition | Target |
| --- | --- | --- |
| Behavioural correctness | Correct disposition **and** behaviour / all scenarios | 100% |
| Answerable capability coverage | Of scenarios whose *legitimate* expected outcome is EXECUTE, EXPLORE, or true UNSUPPORTED, what share already EXECUTE/EXPLORE | Increase over time |
| Safety accuracy | Correct `REFUSE_SAFETY` / expected `REFUSE_SAFETY` | 100% |
| Policy accuracy | Correct `REFUSE_POLICY` / expected `REFUSE_POLICY` | 100% |
| Clarification accuracy | Correct `CLARIFY` / expected `CLARIFY` | 100% |
| Unsupported count | Answerable analytical scenarios the kernel cannot yet support | Decrease without harming correctness |
| Invalid-input accuracy | Malformed payloads correctly rejected | 100% |

After relabeling the 56, **unsupported count = 0** until new answerable
scenarios are added that the kernel cannot yet run.
