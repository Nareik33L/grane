# MetricFlow support matrix (Grane)

Inventory and support frontier for MetricFlow **0.212.0** (dbt-core 1.12.3,
dbt-duckdb 1.11.0, dbt-metricflow 0.14.0) as imported by Grane. This is not
MetricFlow parity. If Grane cannot preserve a construct's value semantics, it
skips or refuses rather than returning an approximation with `trust: governed`.

Manifest inspected: dbt `target/semantic_manifest.json` plus YAML
(`semantic_models`, model-embedded `semantic_model`, top-level `metrics`).
Parser: `src/providers/dbt/parse.ts`. Mapper: `src/providers/dbt/map.ts`.

## Status legend

| Status | Meaning |
| --- | --- |
| **supported** | Imported; executed values match MetricFlow on tested queries |
| **supported with constraints** | Imported; some query shapes refuse |
| **unsupported / skipped** | Not in the governed catalog; requesting it is `undefined_metric` with the skip reason |
| **query-shape dependent** | Imported, but some requests are `unsafe_query` / `ambiguous_query` |

## Matrix

| Construct | Status | Reason |
| --- | --- | --- |
| simple measure metric (`sum` / `count` / `count_distinct` / `avg` / `min` / `max`) | supported | Plain column (or `COUNT(1)`); see `tests/unit/semantic-fidelity.test.ts` |
| ratio | supported with constraints | Both components imported, same entity, no nested ratio, no ratio-level filter, no filtered/offset inputs |
| derived | supported with constraints | Only `metric / metric`. Other expr (`* 12`, `-`, offsets) skipped |
| cumulative (unbounded, rolling window, `grain_to_date`) | unsupported / skipped | `MetricFlow type "cumulative" (window … \| grain_to_date …) is not compiled by Grane.` |
| conversion | unsupported / skipped | `MetricFlow type "conversion" … is not compiled by Grane.` |
| window on a simple/ratio metric | unsupported / skipped | Defense: `MetricFlow window "…" is not compiled by Grane.` |
| `offset_window` / `offset_to_grain` | unsupported / skipped | Input `describeInput`; derived change metrics skipped |
| `fill_nulls_with` (integer, simple) | supported with constraints | `COALESCE` on the aggregate of **existing** groups. Not a timespine. |
| `join_to_timespine` | query-shape dependent | Totals OK; per-period `time.grain` is `unsafe_query` (no spine). COALESCE is not timespine fill. |
| `non_additive_dimension` | supported with constraints | `min`/`max` window; foreign-entity `group_by` or empty (global snapshot); day–year grain. Combined with an unsupported window type: skip the metric. |
| `agg_time_dimension` | supported | Must be a declared time dimension of the model. Untimed component + query time: `ambiguous_query` (#20). |
| metric filters | supported with constraints | `=` / `!=` / `<>` / `and` on the metric's own model; JSON `NULL` literals are not imported (not mapped to `is_null`); #31 grain / fan-out / SA off-grain classification unchanged |
| query time grain (output) | query-shape dependent | Must be ≥ the metric's native grain. Day grouping of a month-grain metric is `unsafe_query`. |
| metric-defined grain vs query range | supported with constraints | Native week/month/quarter/year expands civil `from`/`to` to complete overlapping periods (MetricFlow 0.212). Day stays civil. Mixed coarse + civil-day metrics in one query refuse. |
| component temporal alignment | query-shape dependent | Ratio components must share entity; mixed native grains in one query refuse; untimed companion must not inherit time (#20) |
| `time_granularity` on the metric object in the manifest | ignored (always null in 0.212 Oakwell) | Native grain is taken from the **time dimension**, not this field |
| `type_params.input_measures` / `is_private` / `metric_aggregation_params` | parsed via YAML/measure path | Manifest-only `metric_aggregation_params` is unused when YAML is present (Oakwell). Extra input keys skip the metric. |

## Import-time vs query-time

**Import / catalog:** cumulative, conversion, offsets, non-ratio derived,
unsupported filters/aggs, skipped components of a ratio, hour-grain time
dimensions. Listed under `catalog.unsupported` with a deterministic reason.

**Query time:** `join_to_timespine` + `time.grain`; output grain finer than
native grain; mixed native grains; untimed component + `query.time`; #31
filter support; #32 cardinality; #20 time inheritance.

`trust: mixed` is never used as a substitute for missing MetricFlow
semantics.

## Oakwell catalog (canonical fixture `380f13e`)

76 MetricFlow metrics discovered. After this PR (same class of counts as
parent; grain alignment is query-shape, not a new import skip):

- **61 imported** (simple, eligible ratio, eligible derived-ratio)
- **15 unsupported metrics**, including:
  - cumulative / `grain_to_date`: `trailing_90d_work_items`, `trailing_30d_tickets`, `revenue_ytd`, `all_time_revenue`
  - conversion: `trial_to_paid_conversion`
  - `offset_window` derived: `customer_churn_rate`, `gross_mrr_churn_rate`, `net_revenue_retention`, `mrr_mom_change`
  - other derived expr: `arr`, `net_new_mrr` (GT-013)
  - unsupported agg: `median_invoice_value`, `p90_first_response_hours`
  - cross-grain ratio: `tickets_per_active_customer`, `work_items_per_active_customer`

`ending_mrr` is imported at **month** grain; `revenue` at **day** grain.
No ordinary simple metric is skipped solely because of grain alignment.
