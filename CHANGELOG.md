# Changelog

## Unreleased

- Imported MetricFlow metrics whose agg time dimension is week, month,
  quarter, or year expand the requested civil `from`/`to` to complete
  overlapping periods of that grain (MetricFlow 0.212 query-window
  alignment) rather than clipping a period-grain DATE to a partial window
  and returning `trust: governed`. Day-grain metrics keep civil bounds.
  Cumulative / `grain_to_date` / `offset_window` / conversion stay skipped
  at import with the construct in the reason; a ratio cannot launder a
  skipped component. See `tests/unit/metricflow-time-grain.test.ts`.

- A group exists iff the query's analytical population produces that
  GROUP BY key. Metric-definition FILTER is not query WHERE: SUM/AVG/MIN/MAX
  over zero contributing values are NULL, COUNT is 0, and `fill_nulls_with`
  COALESCE-s the aggregate without dropping the group. MetricFlow 0.212 may
  omit those extra NULL/0 groups; contributing aggregates match. See
  `tests/unit/noncontributing-groups.test.ts`.

- Promised result order is repeated on the outermost SELECT after the
  cardinality wrapper. Inner `__grane_result` still has ORDER BY + LIMIT so
  semantic top-N membership is chosen before the wrapper join; SQL does not
  promise CTE order survives that join. Default order is unchanged (time
  grain → period ASC; otherwise first metric DESC when grouped). See
  `tests/unit/final-ordering.test.ts`.

- Cardinality guards inspect the rows that can participate in the requested
  result. Query filters on joined table T constrain P(n) of T (later hops
  read that filtered reach); they do not shrink the fact population P0.
  Duplicates that fail every same-table predicate no longer false-refuse.
  Duplicates that survive the predicate still refuse. NULL measures are
  excluded from P0 only for base-table SUM/AVG/MIN/MAX/COUNT(column)/COUNT
  DISTINCT when no selected output comes from a joined table; COUNT(*) and
  joined group-by keep every qualifying row. See
  `tests/unit/cardinality-participation.test.ts`.

- Selected public result names must be unique. A metric and a dimension
  both named `code` is `ambiguous_query` rather than a successful result
  with duplicate SELECT aliases (`code` / `code:1`). Identical logical
  selections are deduplicated. Generated `period_${grain}` collisions keep
  the PR #29 contract. See `tests/unit/public-output-names.test.ts`.

- Generated time-grain output `period_${grain}` (for example `period_month`)
  is a stable public result field. A selected metric, dimension, or raw
  alias of the same name is `ambiguous_query` rather than a successful
  result with duplicate SELECT aliases. The name remains legal in queries
  that do not generate that period field. See
  `tests/unit/time-period-alias.test.ts`.

- Identifiers in the `__grane_` prefix are reserved for internal
  execution. A user metric named `__grane_row` is refused rather than
  silently stripped from a successful result. Provider imports skip the
  name as unsupported. See `tests/unit/internal-namespace.test.ts`.

- Cardinality-wrapper padding is identified by a structural marker
  (`__grane_row`), not by “every visible column is NULL”. A real GROUP
  BY row whose dimension and metric values are NULL is preserved. A
  LEFT JOIN miss from `__grane_card` is still stripped so an empty
  grouped query stays empty. Completeness from PR #26 is unchanged.
  See `tests/unit/null-group-padding.test.ts`.

- Successful query results carry machine-readable `completeness`
  (`status`, `limit`, `source`) on the result and in provenance. A
  request `limit` is semantic top-N and is complete. Omitted `limit`
  uses `limits.default_rows` as an execution cap; `max_rows` is the
  hard bound. Truncation is detected from the pre-LIMIT group count
  (`COUNT(*) OVER()`), so an exact-cap result is not labelled
  truncated. Trust is unchanged. MCP and CLI expose the same field.
  See `tests/unit/row-limit-completeness.test.ts`.

- Semi-additive series keys: the metric entity's primary key is the
  declared grain and is always refused as a first/last partition (default
  `group_by: entity` or an explicit list that includes it). A relationship
  on that key does not prove it is a continuing series — join cardinality
  is not temporal-stability metadata. Empty `group_by` stays a global
  snapshot. Explicit columns that are not the entity primary key are the
  native YAML series declaration and are executed as declared. MetricFlow
  `non_additive_dimension.group_by` of a primary or unique entity is not
  imported; a foreign-entity group_by is that provider's series
  declaration. See `tests/unit/semi-additive-series-key.test.ts`.

- A query whose metric dependency closure includes an `experimental` metric
  cannot be `trust: governed`. Status is the existing approval field
  (`approved` default, `experimental` = not an approved definition,
  `deprecated` = still approved). Trust walks requested metrics and ratio
  numerator/denominator recursively. Provider imports that set
  `status: approved` (dbt/MetricFlow, Cube, LookML, Ossie, Malloy) are
  unchanged. The mixed headline now says "not every field is an approved
  definition" so it covers experimental metrics as well as raw fields.
  See `tests/unit/experimental-trust.test.ts`.

- `project.week.starts` (`monday` | `sunday`, default `monday`) now determines
  week-grain bucket boundaries. Compilation emits an explicit civil-week
  expression per dialect instead of the warehouse `date_trunc('week')`
  default. DATE columns stay civil; timestamps use the existing localized
  civil date, then the configured week start. See
  `tests/unit/week-starts.test.ts`.

- Relative `<N>m` / `last_<N>m` periods clamp the shifted civil day to the
  last valid day of the target month. JavaScript `Date` overflow no longer
  turns `2026-03-31` minus one month into `2026-03-03` (and a `1m` window
  of `2026-03-04..2026-03-31`). The documented contract is unchanged: N
  calendar months ending today, i.e. the day after the clamped shift
  through today. `last_month`, `<N>d`, and explicit `from`/`to` are
  unchanged. See `tests/unit/relative-month.test.ts`.
- `contains` is literal substring containment. User `%`, `_`, and the LIKE
  escape character are escaped in SQL (`ESCAPE '!'`) on every dialect;
  the bound parameter stays the raw string. Case-insensitive behaviour
  (ILIKE / LOWER) is unchanged. See `tests/unit/contains-literal.test.ts`.

- Time dimensions are classified from the live warehouse type, not by name.
  A `DATE` is a civil calendar value: `project.timezone` no longer rewrites
  `2026-08-01` into another day via `::timestamptz AT TIME ZONE`. Filtering
  and grouping compare/truncate the warehouse DATE. Timestamp without time
  zone is treated as a UTC wall-clock instant (session timezone is pinned to
  UTC on DuckDB, matching Postgres `SET LOCAL TIME ZONE 'UTC'`); timestamp
  with time zone is an instant and still localizes to `project.timezone`.
  If the column type is unknown and the project timezone is not UTC,
  compilation refuses rather than guessing. See `docs/warehouses.md` and
  `tests/unit/date-timezone.test.ts`.
- Pre-aggregation CTEs now honour the same many_to_one contract as the outer
  query: each hop after the fan-out is a `LEFT JOIN` with a scoped runtime
  cardinality guard. A participating duplicate inside `orders → order_items →
  products` refuses; an unreachable duplicate does not. See
  `tests/unit/preagg-cardinality.test.ts`.
- An untimed metric (or ratio component) plus an explicit time range is an
  `ambiguous_query`, whether requested alone or composed with timed metrics.
  Companion metrics cannot change its meaning. Untimed metrics without a
  time constraint are unchanged. See `tests/unit/untimed-composition.test.ts`.

- Runtime cardinality checks are scoped to the rows a relationship could
  actually multiply: the **metric-contributing population** (base rows inside
  the time bounds and base-table filters that can contribute to at least one
  requested metric — its own base-table filters and time window, the selected
  snapshot rows for semi-additive metrics; the union across metrics and ratio
  components) and, for every hop, the **reachable population** of the joined
  table (rows referenced by a non-NULL FK of the previous hop's population,
  the same rule at every depth). Duplicated keys that no contributing fact
  reaches — unused, filtered out, outside the time range, not
  snapshot-selected, behind another branch of an earlier hop, or reachable
  only from rows a metric filter excludes — no longer cause a false
  `unsafe_query`. Reachable duplicates still refuse, including when a
  joined-dimension `WHERE` would hide the multiplied rows. Empty-population
  queries are governed-safe; a grouped query whose GROUP BY produces zero rows
  still observes its guards. Every guard reports the metrics it protects, its
  relationship path and its key source. Bind parameters are numbered in
  textual order, so `?`-placeholder warehouses (MySQL, Snowflake, Databricks)
  bind correctly with the layered statement. See
  `tests/unit/query-cardinality.test.ts` and
  `tests/unit/cardinality-populations.test.ts`.
  Semi-additive metrics keep their base-table query filters through snapshot
  selection: the filter chooses the snapshot date *and* constrains the rows
  kept at that date (global and per-`group_by` snapshots alike). An
  intermediate revision of this change applied the filter only to date
  selection when the query traversed a relationship, so
  `ending_mrr WHERE segment = 'Enterprise' BY customer_status` summed every
  segment at the Enterprise snapshot date with `trust=governed`; that is fixed
  and pinned by `tests/unit/snapshot-population.test.ts` and the Oakwell
  interop test (`tests/integration/oakwell.test.ts`, runs when the fixture and
  its built warehouse are present).

- Join execution is now part of the governed contract, not only join keys.
  Dimension traversal uses `LEFT JOIN` so unmatched facts stay in the
  population (NULL group), matching MetricFlow. Each joined table carries an
  in-statement cardinality guard; if a declared one-side key is duplicated in
  the warehouse the executor refuses rather than returning multiplied facts.
  A short dimension name that several semantic models declare with different
  columns is no longer first-writer-wins: the short alias is unsupported and
  each meaning is addressed as `<entity>__<dimension>`. Import order cannot
  change a governed identifier. See `tests/unit/join-safety.test.ts`.
- dbt/MetricFlow relationships are resolved from declared entities only. An
  adversarial review found Grane joining `orders.customer_id` to the surrogate
  primary key of a semantic model merely *named* `customer` — a wrong row with
  `trust: governed`. A relationship is now imported only when another semantic
  model declares the same entity name as `primary` or `unique`, and it joins
  to that entity's declared column (the unique column when that is how the
  target declares it). Semantic model names, table names and key names play no
  part. Entities with no such target, `natural` targets, SQL-expression
  entities and one-to-one (primary/unique-to-primary/unique) joins are
  recorded under `unsupported` with the reason. Relationship conformance tests
  execute the compiled joins against DuckDB
  (`tests/unit/relationship-fidelity.test.ts`).
- `fill_nulls_with` is no longer dropped from imported metrics: it compiles as
  `COALESCE(<aggregate>, n)` after aggregation (native `fill_nulls_with` is
  available on Grane metrics too). `join_to_timespine: true` is carried and a
  per-period breakdown of such a metric is refused (`unsafe_query`) instead of
  being returned sparse; totals and non-time groupings are exact.
- `--filter` on the CLI accepts `!=` and `<>` alongside `=`, matching the
  kernel and MCP filter operators.
- dbt/MetricFlow import hardened after an independent interoperability test
  (76-metric SaaS fixture). Everything Grane imports from dbt now either
  reproduces the upstream semantics or is skipped with a reason; nothing is
  guessed:
  - `agg: count` with `expr: 1` (any numeric literal) is a row count,
    `COUNT(1)` — a `count` metric may now omit `sql`. Previously the metric
    name was used as a column.
  - Filters keep their operator (`=`, `!=`, `<>`) as `{ field, operator,
    value }`. Previously `!=` collapsed into an equality map. Other predicates
    (`or`, `in`, `>`/`<`, `null`, `TimeDimension`, `Entity`, cross-model
    dimensions, SQL wrappers) skip the metric instead of degrading.
  - `non_additive_dimension` maps to `additive: semi` with an explicit
    `semi_additive` block: `window` (`max` → last, `min` → first), `group_by`
    (only the declared entities; empty = one snapshot for the whole result,
    MetricFlow's default) and `granularity` (the dimension's declared
    `time_granularity`; all rows in the last period are kept). Filters and the
    time range apply before the snapshot is chosen, both bounds are enforced,
    and the snapshot key is never inferred from names or surrogate keys.
  - Native `semi_additive.group_by` / `semi_additive.granularity` are available
    for Grane YAML; `group_by` defaults to the entity primary key as before.
  - Queries combining a semi-additive metric with a metric whose row selection
    differs refuse (`unsafe_query`) instead of intersecting the two selections.
  - Ratios whose numerator and denominator live at different entities are
    skipped at import and refused by the compiler for native definitions.
  - Providers record deliberate skips. `catalog` lists them under
    `unsupported` (kind, name, reason, source) and requesting one returns
    `undefined_metric` with the reason, so "not imported" is distinguishable
    from "does not exist".
  - Semantic models without a column-backed primary entity are skipped with
    their metrics (Grane never assumes `id`); relationships are created only to
    models whose declared primary entity matches; SQL-expression dimensions
    are recorded as unsupported rather than dropped silently. Imported
    dimension descriptions carry the MetricFlow identity (`invoice__country`)
    and column.
  - `grane init --provider <path>` writes `providers:` live and prints the
    import-first next steps. Docs gained an "Already have dbt / MetricFlow?"
    path.
  - Semantic fidelity tests execute compiled SQL against a hand-computed
    DuckDB warehouse (`tests/unit/semantic-fidelity.test.ts`).
- HTTP MCP authentication denials (`missing` / `invalid` bearer token) append
  one `kind: "auth"` JSONL line. Existing `query` / `refusal` events still
  always include `query`; auth events omit it and never log the token.
- Canonical demo shop in `demo/`: planted last-month revenue drop (Germany /
  `CARD_AUTH_FAILED`). `npx grane-analytics demo` (or `npm run demo`) builds a
  local DuckDB warehouse, runs the investigation, and prints the question to
  ask an agent. `docker compose up` is the Postgres path. `--dir`, `--connect`,
  `--postgres`, and `--serve` come along. The same dataset powers the A/B/C
  benchmark. `warehouse.duckdb` is generated, not committed.
- Benchmark expanded to ~50 questions with a permission score and a five-run
  compile check for Grane. Paths A and B remain representative SQL fixtures.
- `time.period` accepts `this_quarter`, `last_quarter`, and `q2`–`q4`
  (calendar). `q1` stays the 0.6.5 rule: year-to-date within calendar Q1, or
  `ambiguous_query` when a fiscal year is configured.
- Hostile-input and information-boundary regression tests (SQL injection in
  filters, blocked `customers.email` on every access path, grain traps on
  tickets / checkout events / payment failure codes).
- README opening shortened around the demo.

## 0.6.5

- Deterministic kernel capabilities used by the Gauntlet:
  - Semi-additive metrics (`additive: semi`) take last-as-of per entity key
    rather than summing snapshot rows across time.
  - Ratio (and other) metrics with disagreeing `time_dimension`s apply the
    query window to each component on its own timestamp via `FILTER`, not a
    shared outer `WHERE`.
  - An explicit `time.dimension` that is not the metrics' canonical time is
    labelled `mixed` and still executes.
  - Multiple fan-out-free join paths refuse with `ambiguous_query` rather
    than BFS-guessing.
  - `this_fiscal_year` / `last_fiscal_year` resolve from
    `project.fiscal_year.starts_month`. `ytd` / `q1` / `fyYYYY` require
    clarification when a fiscal year is configured. Unknown periods and
    impossible civil dates (`2023-02-29`) are structured `invalid_query`.
- Gauntlet scenarios carry an expected disposition (`EXECUTE`, `EXPLORE`,
  `CLARIFY`, `REFUSE_SAFETY`, `REFUSE_POLICY`, `UNSUPPORTED`). A refusal
  cannot pass an `EXECUTE` / `EXPLORE` scenario.

## 0.6.4

- Internal **Grane Gauntlet** (`tests/gauntlet`, `npm run test:gauntlet`): a
  hostile DuckDB warehouse and ~900 scenarios that try to make Grane return
  the wrong number, silently fan out, bypass a permission, or label
  exploration as governed. Independent gold SQL and fixture reductions;
  a safe refusal is a pass. Not the public A/B/C benchmark.
- First-week path on your own Postgres: `grane discover --write-relationships`
  merges inferred foreign keys into `relationships.yml` without clobbering
  existing keys. `grane init` scaffolds five-metric comments, audit, and
  agent-token placeholders. Guide: `docs/first-week.md`.
- Production HTTP: non-root Docker image with `/health` HEALTHCHECK, GHCR
  publish on `v*` tags (`ghcr.io/nareik33l/grane`), and `docs/production.md`
  (`docker run -v project -e DATABASE_URL`, read-only DB user, TLS in front,
  per-agent bearer tokens). No SSO.
- Query audit log: append-only JSONL (default `.grane/audit.jsonl`) of time,
  agent, trust, query model, SQL, row count, and refusals. No row payloads,
  no tokens. Opt out with `audit.enabled: false`. Docker: `GRANE_AUDIT_PATH`
  and `GRANE_AUDIT_STDOUT=1` (JSON lines on stderr).

## 0.6.3

- MCP `query` / `explain` / `validate` lead with a trust headline, then JSON
  with `trust` first. Agents must open the reply with that line and put it in
  any chart title. The CLI prints the same headline above the table.

## 0.6.2

- `grane mcp connect` with stdio replaces a leftover HTTP entry of the same
  name in the other Cursor/VS Code/Gemini config (project vs `~/.cursor/mcp.json`).
  That stops Cursor connecting to `localhost:8080` after a previous `grane serve`.

## 0.6.1

- Agent dimension allow-lists apply to governed filters, `time.dimension`,
  catalog `available_dimensions`, and `undefined_dimension` suggestions.
  HTTP 401 responses include `WWW-Authenticate` and drain the request body.

## 0.6.0

- Query Model v1 accepts `time.period` (`last_month`, `30d`, `last_30d`, …)
  resolved in the project timezone. Agents no longer have to compute `from`/`to`.
- HTTP MCP per-agent bearer tokens (`auth.agents` in `grane.yml`) with optional
  metric/dimension allow-lists and per-agent exploration.
- Deeper semantic readers: Malloy `table()` sources, Cube `cube('name', {…})`
  JavaScript (never eval'd), LookML `derived_table` bound to a materialized
  relation, MetricFlow derived `metric/metric` ratios.

## 0.5.0

- Public language: deterministic analytics harness (agents reason, Grane executes).
- A/B/C thesis benchmark on the DuckDB example shop.
- Universal semantic connector: dbt/MetricFlow, Cube YAML, LookML, Apache Ossie,
  Grane fragments; auto-detect from `providers: [{ path: … }]`.
