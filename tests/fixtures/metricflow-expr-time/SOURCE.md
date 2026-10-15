# MetricFlow expression time-dimension skip fixture

Apache-2.0 derivative of [dbt-labs/metricflow](https://github.com/dbt-labs/metricflow)
`simple_manifest` `semantic_models/listings_latest.yaml` plus three
metrics from `metrics.yaml` (`largest_listing`, `smallest_listing`,
`listings`), pinned at
`fe4b8c1ccb72a8ca77494b345777eff20a714119`. License: Apache-2.0 (see
`LICENSE`). Copyright: dbt Labs.

Upstream `ds` is `expr: created_at` (a plain column). This copy changes
**only** that expr to `cast(created_at as DATE)` so tests can assert the
import skip reason for a *declared* time dimension that is a SQL
expression. Grane does not compile `cast(...)`. `dbt_project.yml` is a
Grane detect wrapper; it is not part of upstream.
