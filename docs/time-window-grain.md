# Time-window vs metric-grain alignment

Characterization only. The DATE / timezone fix does **not** change this.

## What the gauntlet reported

Against MetricFlow on Oakwell-like data:

- `ending_mrr` over a 30-day range → Grane `0`, MetricFlow `2,309,714.33`
- Additive month-grain metrics where MetricFlow aligns the requested bounds
  to the metric's declared `time_granularity`, while Grane filters the raw
  civil dates.

These look similar to the timezone bug (ending MRR August 2026 → 0) but they
are a different question: **which rows does a requested `[from, to]` include
when the metric is defined at month grain?**

## What Grane does today

After relative periods resolve to civil `from`/`to`:

1. **DATE columns:** `date_col >= DATE from AND date_col < DATE (to+1 day)`.
   A 30-day range ending 2026-08-31 includes snapshot dates in that window
   only. A month-end snapshot stored as `2026-08-01` (month start) or
   `2026-08-31` (month end) is included iff that DATE falls in the range.
2. **Timestamps:** the same bounds, after localizing the instant to
   `project.timezone`.
3. **Semi-additive:** last/first snapshot **among rows that already passed
   that filter**. If no snapshot DATE lies in the range, the result is
   empty / 0 — not "the latest snapshot of the month that overlaps the
   range".

There is no step that expands `2026-08-02 .. 2026-08-31` to the full
August grain, and no step that maps a 30-day window onto "the month-end
snapshot of the last complete month".

## What MetricFlow appears to do (from the differential)

MetricFlow metrics carry `time_granularity` (day / month / …). For a metric
declared at month grain, a query window is typically **aligned to that
grain**: a range that overlaps August can select the August month-end
snapshot even when the requested dates are a 30-day subset, or the window
is expanded to `[month_start, next_month_start)`.

Exact alignment (inclusive bounds, partial last month, `where` vs
`time_constraint`) is MetricFlow-version specific. This note does not
re-implement it.

## Decision needed

**A.** Grane intentionally uses raw civil-date bounds. Then document that
MetricFlow month-grain alignment is **not** claimed, and treat the 30-day
`ending_mrr` differential as expected.

**B.** Grane claims MetricFlow compatibility for imported month-grain /
non-additive metrics. Then a later correctness fix must align windows to
the declared grain — separately from timezone localization.

Until that decision, changing alignment inside the timezone patch would
silently redefine every dated query.

## How to tell the two bugs apart

| Symptom | Timezone (fixed) | Grain alignment (open) |
| --- | --- | --- |
| Same DATE, `project.timezone` NY vs UTC changes the number | Yes | No |
| UTC project, 30-day range vs full calendar month disagree with MetricFlow | No | Yes |
| Generated SQL contains `DATE::timestamptz AT TIME ZONE` | Yes (old) | Irrelevant |
| Generated SQL is a civil DATE comparison, result still 0 vs MF month snapshot | No | Yes |
