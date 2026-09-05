# Governed-correctness follow-ups (contributor record)

Historical record of governed-correctness reviews: what was refused,
what was fixed, and which remainders are intentional support boundaries.
This is contributor context, not a product roadmap or a certification claim.
Do not reopen a listed item as a new campaign without a new counterexample.

Recorded during the DATE / pre-aggregation / untimed-metric fix. Item 3
(`contains` LIKE wildcards) and item 1 (`project.week.starts`) were later
fixed when independent reviews produced governed-wrong counterexamples.
Experimental metrics executing as `trust: governed` was a later
BREAK-GOVERNED finding and is also fixed. Item 7 (NULL-group padding)
is also fixed. Item 11 (`__grane_` identifier collision) is also fixed.
Item 12 (public `period_${grain}` alias collision) is also fixed.
Item 13 (selected public output-name uniqueness) is also fixed.
Item 8 (`validate` / compile disagreement on off-path metric filters)
is also fixed. Item 10 (cardinality participation / NULL-measure
false refusal) is also fixed, with an intentional conservative remainder.
Item 9 (`ORDER BY` / outer-wrapper portability) is also fixed.
Item 6 (non-contributing groups / NULL vs 0) is also fixed as an explicit
group-existence contract: groups come from the analytical population;
metric FILTER is not WHERE. MetricFlow may omit the extra NULL/0 groups.
Item 5 (MetricFlow time-window / metric-grain alignment) is also fixed:
imported week/month/quarter/year agg time dimensions expand the query
window to complete overlapping periods; cumulative/window/offset remain
explicitly unsupported. The rest stay deferred.

## 0. Experimental status vs `trust: governed` — fixed

Resolved: `status: experimental` means the metric is not an approved
definition. Trust walks the metric dependency closure; any experimental
metric in that graph yields `mixed` (not `governed`) and the existing
"not an approved definition" note. `deprecated` stays governed.
Provider imports without a native lifecycle field remain `approved`.
See `tests/unit/experimental-trust.test.ts`. Do not reopen as a new
catalog-governance subsystem.

## 1. `project.week.starts` accepted but ignored — fixed

Resolved: week-grain compilation honours `monday` / `sunday` with an
explicit civil-week expression on every dialect. See
`tests/unit/week-starts.test.ts`.

## 2. Row-limit truncation is weakly represented in provenance — fixed

Resolved: successful results carry `completeness` on the result and in
provenance (`status: complete | truncated | unknown`, plus `limit` and
`source`). `query.limit` is semantic top-N (complete even when more
unbounded groups exist). Omitted `limit` uses `default_rows` as an
execution cap; `max_rows` is the hard bound. Truncation is detected
from `COUNT(*) OVER()` (pre-LIMIT group count), not from
`rows.length === limit`. Trust is unchanged. See
`tests/unit/row-limit-completeness.test.ts`.

## 3. `contains` LIKE wildcards — fixed

Resolved: `contains` is literal substring containment. Dialects wrap the
bound value with LIKE-metacharacter escaping and `ESCAPE '!'`. See
`tests/unit/contains-literal.test.ts`. Do not reopen as a wildcard
operator.

## 4. Semi-additive grouping by its own primary entity can make snapshot selection vacuous — fixed

Resolved: the metric entity's primary key is the declared grain. Using it
as a first/last series (default `group_by: entity` or an explicit list
that includes it) is `unsafe_query` / `vacuous_semi_additive_group_by`.
A relationship on that key does not prove temporal stability — a
per-observation 1:1 dimension can be declared many_to_one. Empty
`group_by` remains a global snapshot. Explicit columns that are not the
entity primary key are the native YAML series declaration and are
executed as declared; Grane has no uniqueness metadata on those columns.
MetricFlow group_by of a primary/unique entity is skipped at import;
foreign-entity group_by is that provider's series declaration. See
`tests/unit/semi-additive-series-key.test.ts`.

## 5. MetricFlow time-window / metric-grain alignment — fixed

Resolved: imported metrics whose agg time dimension declares week / month /
quarter / year expand the requested civil `from`/`to` to complete overlapping
periods of that grain (MetricFlow 0.212 query-window alignment). Day-grain
metrics keep civil bounds. A requested output grain finer than the native
grain, or a mix of coarse-grain and civil-day metrics in one query, is
`unsafe_query`. Cumulative / `grain_to_date` / `offset_window` / conversion
remain skipped at import with the construct in the reason; ratios cannot
launder a skipped component. See `docs/time-window-grain.md`,
`docs/metricflow-support.md`, `tests/unit/metricflow-time-grain.test.ts`.
Do not implement a MetricFlow cumulative engine here.

## 6. Non-contributing NULL / 0 result groups — fixed (explicit contract)

Resolved: a group exists iff the query's analytical population (base rows
after query time bounds and query WHERE, LEFT JOINed to selected
dimensions) produces that GROUP BY key.

Metric-definition FILTER is not query WHERE. It changes contribution to
that metric. SUM/AVG/MIN/MAX over zero contributing values are NULL;
COUNT(*) / COUNT(column) / COUNT DISTINCT are 0. `fill_nulls_with`
COALESCE-s the aggregate after grouping; it does not invent or drop
groups. A group that contributes to one requested metric is not dropped
because another requested metric is NULL. Synthetic wrapper padding
remains `#27`. Cardinality P0 remains `#32`.

MetricFlow 0.212 applies measure filters as source WHERE before GROUP BY
and therefore omits groups Grane returns as NULL/0. Contributing
aggregates match. That row-set difference is a provider boundary, not a
governed-wrong number. Do not reopen as HAVING / WHERE metric IS NOT NULL
or by converting FILTER into query WHERE.

See `tests/unit/noncontributing-groups.test.ts`.

## 7. NULL-dimension group dropped by executor padding heuristic — fixed

Resolved: padding is identified by a structural marker (`1 AS "__grane_row"`
on the analytical SELECT). The cardinality wrapper's LEFT JOIN miss is
NULL in that column and is stripped. A real GROUP BY row whose visible
dimension and metric values are NULL is preserved. Completeness (`__grane_n`)
is read before the strip and counts real groups only. Trust is unchanged.
See `tests/unit/null-group-padding.test.ts`.

## 8. `validate` vs kernel on an off-path metric filter — fixed

Resolved: compile refuses a metric-definition filter whose table is not
bound in the FILTER/WHERE clause (unreachable table, fan-out-only path,
ratio-owned filters). MCP `validate` (explain) and `query` therefore agree
before the warehouse runs. Model `validate` uses the same bind-scope, so a
many_to_one parent filter that compile already joins is no longer flagged
as `filter_out_of_scope`. Query filters that name a metric (or synonym) are
`invalid_query`, not a physical-column hint. See
`tests/unit/metric-filter-support.test.ts`. Do not reopen as a HAVING engine
or as warehouse-error rewriting.

## 9. `ORDER BY` / outer-wrapper portability — fixed

Resolved: promised ordering is emitted both inside `__grane_result`
(ORDER BY + LIMIT choose semantic top-N / execution-cap membership) and
on the outermost SELECT after `__grane_card LEFT JOIN __grane_result`,
qualified as `__grane_result.<public output>`. SQL does not promise CTE
order survives the wrapper join. Unguarded queries already ordered at
the final SELECT and are unchanged. Default order is unchanged: time
grain → `period_${grain}` ASC; otherwise first selected metric DESC when
the query is grouped. `query.order` still requires a selected public
output. NULLS FIRST/LAST is not part of the API; warehouses keep their
default NULL placement. See `tests/unit/final-ordering.test.ts`. Do not
reopen as pagination, ranking, or a new default sort product.

## 10. Conservative NULL-measure cardinality behaviour — fixed (with an intentional remainder)

Resolved: cardinality participation is derived from the requested outputs,
not from a global `measure IS NOT NULL` heuristic.

- Same-table query filters constrain P(n) of that table (and later hops
  that read it). Duplicates that fail every predicate on T cannot appear
  in the join+WHERE result and do not refuse. Duplicates that survive
  the predicate still refuse. P0 / fact population is not shrunk by a
  joined filter (the unsafe PR #19 regression). Metric-definition FILTER
  clauses are not WHERE and do not shrink P(n).
- NULL measures are excluded from P0 only for SUM / AVG / MIN / MAX /
  COUNT(column) / COUNT DISTINCT whose measure lives on the base table,
  and only when no selected dimension, raw dimension, or time grain comes
  from a joined table. COUNT(*) keeps every qualifying row. A NULL SUM
  row grouped by a joined dimension can still create extra groups, so it
  stays in P0.

Remaining conservative refusals (intentional support boundary, not a
governed-wrong path): a duplicate on hop N while the query filter lives
only on a later hop; joined metric-definition FILTER (does not remove
groups); NULL facts that can affect selected joined-dimension groups.
Do not reopen as DISTINCT / first-row / “trust the declaration”.
See `tests/unit/query-cardinality.test.ts`,
`tests/unit/cardinality-populations.test.ts`, and
`tests/unit/cardinality-participation.test.ts`.

## 11. User aliases can collide with hidden `__grane_*` result columns — fixed

Resolved: identifiers in the `__grane_` prefix (ASCII case-insensitive)
are reserved for internal execution. Native YAML metric, dimension,
entity, entity-table, and synonym names that use the prefix are
`config_error`. Provider imports are skipped as `unsupported`. Query-time
raw aliases are `invalid_query`. Hidden-column cleanup strips the whole
prefix. Harmless nearby names (`grane_row`, `_grane_row`) remain legal.
See `tests/unit/internal-namespace.test.ts`. Do not reopen #27.

## 12. Generated `period_${grain}` collides with user fields — fixed

Resolved: `time.grain` emits a stable public column `period_${grain}`.
A selected metric, dimension, or raw alias of that exact name is
`ambiguous_query` at resolve (compile / explain / query / MCP validate
agree). Model load does not reject the name; queries without that grain
remain valid. Cross-grain and nearby names are not reserved. See
`tests/unit/time-period-alias.test.ts`. Do not reopen as a general
alias allocator.

## 13. Selected public outputs can share a result name — fixed

Resolved: after resolution, selected public SELECT names must be unique.
A metric and dimension both named `code` is `ambiguous_query` before SQL.
Identical logical selections (same canonical metric/dimension, same raw
field+type+alias) are deduplicated. Generated `period_${grain}` collisions
keep the PR #29 message. Model load does not reject coexisting names.
See `tests/unit/public-output-names.test.ts`.

## 14. Boolean / integer filter coercion — deferred

Observed by the post-#36 unrestricted gauntlet: `flag = 1` can compile as
an integer bind against a boolean column. Out of scope for the JSON-null
and ambiguous-path fix. Do not treat warehouse coercion as governed
boolean semantics. Explicit `true` / `false` remain the supported literals.

