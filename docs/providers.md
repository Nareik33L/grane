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

## Already have dbt / MetricFlow?

Keep your definitions where they are. Five steps:

1. **Keep existing definitions.** Nothing is copied into Grane YAML.
2. **Point Grane at the project.** `grane init --provider ../your_dbt_project`
   writes `providers:` live in `grane.yml`. A `target/semantic_manifest.json`
   is used when present (run `dbt parse`); otherwise the YAML is read directly.
3. **Configure the warehouse.** `connection:` in `grane.yml` — the same
   database dbt builds into. Use a read-only role.
4. **Validate.** `grane validate` imports metrics, dimensions, entities and
   joins, checks every column against the live schema, and prints one line per
   upstream definition Grane deliberately did not import, with the reason.
5. **Connect the agent.** `grane mcp doctor`, then `grane mcp connect <client>`.

Native YAML stays available as a peer provider for anything the dbt project
does not govern.

```bash
mkdir analytics && cd analytics
grane init --provider ../your_dbt_project
export DATABASE_URL='postgres://grane_readonly:...@db.internal:5432/analytics'
grane validate
grane query revenue --last 30d
```

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
| **Malloy** | `*.malloy` `source: name is table('t') extend { … }` (simple measures, dimensions, `join_one`) |

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
are **skipped, never guessed**. Every skip is recorded: `grane validate` prints
it with the reason, and the MCP `catalog` tool lists it under `unsupported`
(kind, name, reason, source). Asking for a skipped metric by name returns
`undefined_metric` with that reason, so an agent can tell "not imported" from
"does not exist" and will not approximate it with other metrics.

### dbt / MetricFlow

Reads `semantic_models:` (legacy spec), model-embedded `semantic_model:` (latest
spec), and `target/semantic_manifest.json`. `target/manifest.json` supplies
relation names when present.

Imported, with the upstream semantics preserved:

| MetricFlow | Grane |
| --- | --- |
| Primary entity backed by a column | Entity + primary key. Models without one are skipped; Grane never assumes `id`. |
| Foreign (or natural) entity → another semantic model that declares the **same entity name** as its `primary` or `unique` entity | `many_to_one` relationship from the entity's column to the target's declared entity column — the unique column when that is how the target declares it, never its surrogate primary key. Semantic model names and table names are not join keys; an entity no model declares, one declared only as `foreign` elsewhere, a `natural` target (validity windows) or an entity whose `expr` is a SQL expression is recorded under `unsupported` with the reason. Primary/unique-to-primary/unique (one-to-one) joins are recorded as unsupported rather than imported. |
| Categorical / time dimension with a plain column `expr` | Dimension. A short name is exposed only when every declaration of it is the same physical column. If two semantic models declare the same name with different columns, the short name is recorded under `unsupported` and each meaning is exposed as `<entity>__<dimension>` (MetricFlow's identity). Import order cannot change which identifier means what. |
| `agg: sum / count / count_distinct / average / min / max` over a column | Same aggregation. `agg: count` with `expr: 1` (any numeric literal) is a row count, `COUNT(1)`. |
| `filter: {{ Dimension('order__status') }} = 'completed'` — `=`, `!=`, `<>`, string / number / boolean literal, joined with `and`, on the metric's own model | Metric filter with the **same operator** |
| `non_additive_dimension` (`window_agg` / `window_choice` `max` or `min`; `group_by` / `window_groupings` entities) | `additive: semi` with an explicit `semi_additive` block: `window`, `group_by` (the declared entities; **empty keeps one snapshot for the whole result**, MetricFlow's default) and the dimension's declared `time_granularity`. Filters and the time range apply before the snapshot is chosen. |
| `ratio`, or `derived` whose expr is exactly `metric / metric` | Ratio, when both components are imported and share one entity |

Skipped with a reason: cumulative, conversion, other derived expressions
(`× 12`, `a - b`, offsets, aliases), `median` / `percentile`, ratios whose
numerator and denominator sit at different grains, ratios with their own
filter or filtered inputs, filters using `or`, `in`, `>`/`<`, `null`,
`TimeDimension`, `Entity`, SQL wrappers or another model's dimension,
SQL-expression dimensions, and snapshot dimensions at sub-day granularity.
`fill_nulls_with` (an integer) is applied as `COALESCE(<aggregate>, n)` after
aggregation — the declared semantics, and what MetricFlow compiles for a
`type_params.measure` input (note: dbt-core 1.12 does not pass the field
through for model-embedded `metrics:`, so `mf query` on that toolchain shows
`null` where Grane shows the declared value). Ratio components keep their own
fill; `fill_nulls_with` on a non-simple metric skips it, as MetricFlow rejects
it. `join_to_timespine: true` is carried on the metric: totals and non-time
groupings are exact, but a per-period breakdown is refused (`unsafe_query`)
because Grane has no time spine to produce the empty periods MetricFlow would
return — it is never returned sparse as if it were complete.

Joins that traverse a declared `many_to_one` relationship are `LEFT JOIN`s:
unmatched facts (missing dimension row or NULL foreign key) stay in the
population and land in the NULL group, matching MetricFlow's metric-to-dimension
traversal. A query filter on the joined column is applied in `WHERE` after the
join, so `=` and `!=` both exclude unmatched facts (`NULL` compares to nothing).
`PRIMARY` / `UNIQUE` is the upstream **semantic** contract that the target key
is unique; MetricFlow trusts that declaration and will fan out if the warehouse
violates it. Grane additionally **runtime-verifies** the contract in the same
`SELECT`: a hidden `MAX(rows-per-key)` over each joined table. If any key is
duplicated the executor refuses (`unsafe_query`) rather than returning multiplied
facts. It does not `DISTINCT`, pick a row, or relabel the result exploratory.
`trust=governed` therefore means: the metadata said many-to-one, and the data
this statement read honoured that.

A query that combines a semi-additive metric with a metric whose row selection
differs (an additive one, or a semi-additive one with a different filter,
window, key set or granularity) is refused; query them separately.

### Cube

`sql_table` cubes in YAML **or** `cube('name', { … })` JavaScript. `sum` / `count` /
`countDistinct` / `avg` / `min` / `max` measures, dimensions, and
`{CUBE}.fk = {other}.pk` (or `${CUBE}` JS) joins. JavaScript is parsed, never
eval'd. SQL-subquery cubes are bound to the cube name with a warning.

### LookML

`view` + `sql_table_name`, `dimension` / `dimension_group`, `measure` with
simple `${TABLE}.column` SQL, `explore` joins with `sql_on`. `derived_table`
views bind to a warehouse relation named after the view (materialize the PDT;
Grane will not run the LookML SQL).

### Malloy

`source: orders is table('orders') extend { dimension: … measure: x is sum(col)
join_one: customers on customer_id }`. Nested queries and SQL blocks are skipped.

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
