# dbt-labs/jaffle_shop (classic)

Pinned public fixture for import / validate / compat.

- Upstream: https://github.com/dbt-labs/jaffle-shop-classic
  (historical URL: https://github.com/dbt-labs/jaffle_shop)
- Commit: `fd7bfacae4f497ff044a6a0275268676bf1b64c3` (2024-04-18)
- License: Apache-2.0 (see `LICENSE`)
- Copyright: dbt Labs

Classic jaffle_shop has dbt models and tests but no MetricFlow
`semantic_models`. Grane detects `dbt` and import yields an empty semantic
graph plus that warning — the honest real-world result. Seeds and `etc/`
artwork are omitted to keep the pin small; detect and import only need
`dbt_project.yml` and `models/`.
