# Follow-ups from the post-GAUNTLET governed-correctness review

Recorded during the DATE / pre-aggregation / untimed-metric fix. Item 3
(`contains` LIKE wildcards) was later fixed when an independent gauntlet
produced a governed-wrong counterexample. The rest stay deferred. Do not
fold them into timezone, cardinality, month-arithmetic, or contains work
unless a later review proves they are inseparable.

## 1. `project.week.starts` accepted but ignored

- **Observed:** The config field parses and is stored; generated week
  truncation does not consult it.
- **Supported/documented:** Accepted in YAML; week grain is documented as
  `date_trunc('week', …)` (warehouse default).
- **Governed-contract impact:** A Monday-start project can label a Sunday
  week-start as governed if the warehouse week differs.
- **Priority:** Medium. Document the warehouse default as the v0 contract,
  or honour the setting in every dialect.

## 2. Row-limit truncation is weakly represented in provenance

- **Observed:** `LIMIT` is applied; provenance does not state that the
  result was truncated relative to the full population.
- **Supported/documented:** `limits.max_rows` / query `limit` are supported.
- **Governed-contract impact:** A truncated governed table can be presented
  as complete.
- **Priority:** Medium. Add an explicit `truncated` / `row_limit` field.

## 3. `contains` LIKE wildcards — fixed

Resolved: `contains` is literal substring containment. Dialects wrap the
bound value with LIKE-metacharacter escaping and `ESCAPE '!'`. See
`tests/unit/contains-literal.test.ts`. Do not reopen as a wildcard
operator.

## 4. Semi-additive grouping by its own primary entity can make snapshot selection vacuous

- **Observed:** `group_by` defaulting to the entity key, then grouping the
  query by that same entity, can keep every snapshot row.
- **Supported/documented:** `semi_additive.group_by` is supported; this
  edge is not called out.
- **Governed-contract impact:** Possible over-count labelled governed.
- **Priority:** High once reproduced against Oakwell / MetricFlow.

## 5. MetricFlow time-window / metric-grain alignment

- **Observed:** Large differentials on partial periods (e.g. `ending_mrr`
  over a 30-day range; additive month-grain metrics). See
  `docs/time-window-grain.md`.
- **Supported/documented:** Grane applies the requested civil `from`/`to`
  to the time column. MetricFlow may align bounds to the metric grain.
- **Governed-contract impact:** High if Grane claims MetricFlow
  compatibility for those metrics; none if Grane documents a different rule.
- **Priority:** High product decision. Do not silently change with timezone.

## 6. Non-contributing NULL / 0 result groups

- **Observed:** Metric-definition filters as `FILTER` can leave groups with
  NULL/fill values that MetricFlow omits.
- **Supported/documented:** Noted as a follow-up in the compiler.
- **Governed-contract impact:** Row sets (and ORDER BY/LIMIT over them) can
  differ; aggregates of contributing rows agree.
- **Priority:** Low / product decision.

## 7. NULL-dimension group dropped by executor padding heuristic

- **Observed:** The wrapper-padding strip treats an all-null analytical row
  as empty. A real NULL-dimension group can look the same.
- **Supported/documented:** Implementation detail; not documented.
- **Governed-contract impact:** A legitimate NULL group can disappear.
- **Priority:** Medium.

## 8. `validate` vs kernel on an off-path metric filter

- **Observed:** Validate can flag an off-path metric filter that the kernel
  later allows into a raw binder error.
- **Supported/documented:** Validate is structural; compile is the
  execution gate.
- **Governed-contract impact:** Agents can see `ok` from validate and then
  hit an unstructured warehouse error.
- **Priority:** Medium. Compile should refuse structurally.

## 9. `ORDER BY` / outer-wrapper portability

- **Observed:** Ordering lives inside `__grane_result`; the outer
  `card LEFT JOIN result` does not repeat it. SQL does not guarantee order
  survives.
- **Supported/documented:** TODO in the compiler. Dialect NULL-placement
  also differs.
- **Governed-contract impact:** Sorted governed results can reshuffle.
- **Priority:** Medium.

## 10. Conservative NULL-measure cardinality behaviour

- **Observed:** A NULL measure on a reachable duplicated key still refuses
  (the join would multiply the fact row, even if the measure is NULL).
- **Supported/documented:** Matches the written guard contract.
- **Governed-contract impact:** Possible false refusal vs a more generous
  "NULL measures cannot multiply" rule. Changing it is a product decision.
- **Priority:** Low unless a fixture depends on it.
