# Time-window vs metric-grain alignment

Resolved in correctness #35. Characterization of the previous hole is kept
below so the parent governed-wrong stays auditable.

## What MetricFlow 0.212 actually does

Run against Oakwell (`mf query --explain`, MetricFlow 0.212.0):

| Query | Generated time bound | Value |
| --- | --- | --- |
| `ending_mrr` 2026-08-01..2026-08-31 | `DATE_TRUNC('month', month_start) BETWEEN '2026-08-01' AND '2026-08-31'` | 2,309,714.33 |
| `ending_mrr` 2026-08-02..2026-08-31 | **same** (start snapped to 1 Aug) | 2,309,714.33 |
| `ending_mrr` 2026-08-01..2026-08-15 | **same** (end snapped to 31 Aug) | 2,309,714.33 |
| `ending_mrr` 2026-07-15..2026-08-15 | Jul 1 .. Aug 31 | 2,309,714.33 (last snapshot) |
| `new_mrr` 2026-07-15..2026-08-15 | Jul 1 .. Aug 31 | 67,320.67 |
| `revenue` 2026-07-02..2026-07-31 | **not** expanded (day grain) | 2,154,558.37 |

Month-grain (and coarser) agg time dimensions expand the query window to
every complete period that overlaps `[from, to]`. Day-grain metrics keep
civil bounds.

## What Grane does

After relative periods resolve to civil `from`/`to`:

1. **Native YAML, or a MetricFlow time dimension at day grain:** civil
   bounds on the time column (`>= from` and `< to+1 day`). Unchanged.
2. **Imported metric whose agg time dimension declares week / month /
   quarter / year:** the civil range is expanded to complete periods of
   that grain **before** filtering (the same expansion MetricFlow 0.212
   compiled above). A note records the original and aligned range.
   `trust` stays `governed` because the value semantics are preserved.
3. **Output `time.grain` finer than that native grain:** `unsafe_query`.
   `GROUP BY` at day on a month-grain column would redefine the metric.
4. **Mixing a coarse-grain metric with a civil-day metric in one query:**
   `unsafe_query`. One range cannot be both expanded and not expanded.

Cumulative windows, `grain_to_date`, `offset_window`, conversion metrics,
and `join_to_timespine` period spines are still **not compiled**. They are
skipped at import with a reason that names the construct. A derived/ratio
whose component was skipped is also skipped (no laundering).

Native YAML that omits `time_granularity` keeps civil bounds. Do not set
that field unless the time column is actually at that grain.

## Parent governed-wrong (fixed)

On `main` before this change, Grane applied civil bounds to month-grain
`ending_mrr` and returned **0 / `trust: governed`** for 2026-08-02..08-31
while MetricFlow returned 2,309,714.33. That is closed by (2).

See `docs/metricflow-support.md` for the support matrix.
