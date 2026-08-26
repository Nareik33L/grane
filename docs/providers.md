# Semantic connectors

Grane compiles analytics from one in-memory model: entities, metrics,
dimensions, relationships. That model can come from **native YAML** in the
Grane project, or from **whatever semantic system the company already has**.

```text
dbt / Cube / LookML / Ossie / fragment / …
        ↓
Grane connector (auto-detect)
        ↓
entities, metrics, dimensions, relationships
        ↓
deterministic compiler
```

Point Grane at the folder. You should not have to redefine Revenue.

## Auto-detect

Omit `type`. Grane sniffs the path:

```yaml
# grane.yml
providers:
  - path: ../analytics
```

It recognises:

| Kind | How it is detected |
| --- | --- |
| **dbt / MetricFlow** | `dbt_project.yml`, `semantic_models:`, model-embedded `semantic_model:`, or `target/semantic_manifest.json` |
| **Cube** | YAML `cubes:` (schema files) or `cube.js` |
| **LookML** | `*.lkml` / `*.lookml` views and explores |
| **Apache Ossie** | `*.ossie.yaml`, `osi_document.json`, or `semantic_model` + `datasets` |
| **Fragment** | Generic Grane maps (`entities` / `metrics` / `dimensions` / `relationships`) dumped by any other tool |
| **Malloy** | `*.malloy` (detected; export Ossie/Cube/fragment until a Malloy compiler is added) |

A path can match more than one kind. Auto-load merges them; duplicate names are
still an error.

Force a reader when sniffing is ambiguous:

```yaml
providers:
  - type: cube
    path: ../cube
  - type: ossie
    file: ./model.ossie.yaml
```

Aliases: `metricflow` → dbt, `looker` → lookml, `osi` → ossie, `grane` → fragment.

## Native YAML (always on)

Files next to `grane.yml` are always loaded. Use them for metrics the upstream
system does not govern.

## What each reader maps

All readers contribute the same four maps. Grane does **not** call dbt, Cube,
Looker, or MetricFlow at query time. Import happens at load; Grane compiles SQL.

Unsupported constructs (derived metrics, subqueries, untranslatable filters)
are **skipped with a warning**, not guessed.

### dbt / MetricFlow

See the original MetricFlow notes: simple metrics, ratios, entity joins,
`{{ Dimension('order__status') }} = 'completed'` filters.

### Cube

`sql_table` cubes, `sum` / `count` / `countDistinct` / `avg` / `min` / `max`
measures, dimensions, and `{CUBE}.fk = {other}.pk` joins.

### LookML

`view` + `sql_table_name`, `dimension` / `dimension_group`, `measure` with
simple `${TABLE}.column` SQL, `explore` joins with `sql_on`.

### Apache Ossie

Datasets → entities, dimension fields → dimensions, `SUM(table.column)`-style
metrics, `from`/`to`/`from_columns`/`to_columns` relationships. This is the
vendor-neutral interchange hatch: if a tool can emit Ossie, Grane can read it.

### Fragment

If a system can write Grane-shaped YAML/JSON, that is enough:

```yaml
metrics:
  revenue:
    entity: order
    type: sum
    sql: ${orders.net_amount}
```

## Mix with native YAML

```yaml
providers:
  - path: ../jaffle_shop

dimensions:
  device:
    entity: order
    sql: ${orders.device_type}
```

The same name from two connectors is an error.

## Example

```bash
npx grane-analytics -p example/analytics-from-dbt validate --offline
```

`example/analytics-from-dbt` can also be written as `providers: [{ path: ../dbt-shop }]`.
