# Semantic providers

Grane compiles analytics from a single in-memory model: entities, metrics,
dimensions, relationships. That model can be **native YAML** in the Grane
project, or it can be **read from a system you already maintain**.

```text
dbt / MetricFlow / future providers
        ↓
Grane semantic provider
        ↓
entities, metrics, dimensions, relationships
        ↓
deterministic compiler
```

You should not have to define Revenue twice. Point Grane at the existing
project; add native YAML only for things that system does not govern.

## Native YAML (always on)

Files next to `grane.yml` (`metrics.yml`, `dimensions.yml`, …) are the native
provider. Nothing else is required.

## dbt / MetricFlow

```yaml
# grane.yml
providers:
  - type: dbt
    project: ../jaffle_shop          # directory with dbt_project.yml
    # semantic_manifest: ../jaffle_shop/target/semantic_manifest.json
    # dbt_manifest: ../jaffle_shop/target/manifest.json
```

Grane reads, in order:

1. MetricFlow YAML in the dbt project — both the legacy top-level
   `semantic_models:` spec and the dbt 1.12+ `models:` / `semantic_model:` spec.
2. `target/semantic_manifest.json` when YAML is absent (or when you pass
   `semantic_manifest` without a project).
3. `target/manifest.json` when present, for physical relation aliases.

It does **not** run dbt or MetricFlow at query time. Definitions are imported
at `grane validate` / `grane serve` load, then Grane compiles SQL itself.

Imported names show up in `catalog()` with `source.provider: "dbt"` and in
query provenance.

### What maps

| MetricFlow | Grane |
| --- | --- |
| Semantic model + primary entity | Entity (table + primary key) |
| Dimensions | Dimensions |
| Simple metrics / measures (`sum`, `count`, `count_distinct`, `average`, `min`, `max`) | Metrics |
| Ratio metrics | Ratio metrics |
| Foreign/unique entities shared across models | `many_to_one` relationships |

Simple MetricFlow filters of the form
`{{ Dimension('order__status') }} = 'completed'` become metric filters.
Untranslatable Jinja, derived/cumulative/conversion metrics, and non-column
`expr` values are **skipped with a warning** — Grane will not invent the
missing logic.

### Mix with native YAML

```yaml
providers:
  - type: dbt
    project: ../jaffle_shop

# Extra governed slice dbt does not define:
dimensions:
  device:
    entity: order
    sql: ${orders.device_type}
```

The same metric, dimension, entity, or relationship **name** from two
providers is an error. Rename or delete one definition.

## Other modelling systems

`providers[].type` is an extension point. `dbt` (alias `metricflow`) is
implemented. A Cube, LookML, or Malloy loader is the same interface: read
the upstream project, contribute the four maps, let the kernel compile.

Unknown types fail at load with the list of supported providers.

## Example

```bash
# DuckDB shop whose metrics live in example/dbt-shop, not in Grane YAML
npx grane-analytics -p example/analytics-from-dbt validate --offline
```
