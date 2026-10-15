# dbt-labs/metricflow simple_manifest

Pinned public MetricFlow YAML (Apache-2.0) so import/validate can assert
exact metric, entity, and dimension names. Import currently covers only
simple cases: this tree imports 2 of 112 metrics (`largest_listing`,
`smallest_listing`). The other 110 skip reasons are snapshotted in
`skipped-metrics.json`.

- Upstream: https://github.com/dbt-labs/metricflow
- Path: `metricflow_semantics/test_helpers/semantic_manifest_yamls/simple_manifest`
- Commit: `fe4b8c1ccb72a8ca77494b345777eff20a714119`
- License: Apache-2.0 (see `LICENSE`)
- Copyright: dbt Labs

`dbt_project.yml` is a Grane detect wrapper; it is not part of upstream.
`saved_queries.yaml` and `project_configuration.yaml` are omitted (not
semantic models or metrics).
