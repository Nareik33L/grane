# V1 semantic limitations

These are **deliberately unsupported** in Grane V1. They are not accidental
gaps, and they are not counted as `UNSUPPORTED` capability failures in the
Gauntlet. A request that needs one of these must refuse or clarify — never
guess.

| Limitation | Why it stays out of V1 |
| --- | --- |
| `count_distinct` across a `one_to_many` relationship | Pre-aggregation cannot preserve distinct identity once rows fan out. |
| Child-grain / many-to-many dimensions (`product_category`, `ticket_category`, `campaign_name`, `plan_name`, `session_browser`, `experiment_variant`, `checkout_error`) on order-grain metrics | Joining below the metric grain silently multiplies rows. |
| Named relationship picker when multiple fan-out-free paths exist | Query Model v1 has no relationship-name selector. Ambiguous paths (`countries.name`) clarify rather than BFS-guess. |
| `ytd` / `q1` / `fyYYYY` when a fiscal year is configured | Calendar vs fiscal is ambiguous. Use `this_year`, `this_fiscal_year`, `this_quarter`, or an explicit range. |
| `additive: none` as a cross-time refuse | Non-additive measures are defined; V1 does not yet special-case them as a time-window refusal. |
| FX conversion / as-of join of snapshots to orders | No governed rate metric; exchange_rates is dirty (duplicate dates). |
| Rolling `1w` / `4w` as calendar weeks | Those specs are N×7-day windows, not `this_week` / `last_week`. |
| `inventory` as snapshot last-as-of | Inventory is a SUM at product grain, not a semi-additive daily snapshot. |
| Mixed-entity queries (`revenue` + `account_balance`, `revenue` + `customers`) | Cannot share a FROM without inventing a join. |
| Last-as-of across a join (semi-additive measure not on the entity table) | V1 last-as-of is entity-local. |
| As-of join of daily snapshots onto orders | Would require a declared as-of relationship, not a guessed inequality join. |

When a future version adds one of these, it gets its own normal + boundary +
adversarial + composition tests. Until then, the Gauntlet treats a guessed
answer in any of these areas as a critical failure.
