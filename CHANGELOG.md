# Changelog

## Unreleased

- **MCP guided YAML authoring (V2-18).** The Set up Grane prompt is an
  open-ended conversation (first question: “What metrics are important to
  you?”). The agent suggests plain-English meanings from discovered columns;
  the user confirms via multiple choice. Suggested meanings stay unconfirmed
  until the user picks one. `propose_definitions` returns a play-back
  summary derived from the draft YAML (including `description`) — it must
  match the proposal. `submit_proposal` refuses a stale draft when the
  session changed after `propose_definitions` (resolve, `record_term`, or
  any edit); call `propose_definitions` again. MCP
  **only reads** `setup_tone` from `~/.grane/config.json`, with the same
  symlink / invalid-JSON refusal as the writer; tone changes wording only,
  never YAML or the proposal. Missing config defaults to `technical`.
  Authoring stays proposal-only: a gauntlet that steers toward
  approve / pin / skip review is refused. Cursor/Claude HTTP next steps pass
  `--authoring` to `grane serve` and do not print stdio args. User-local
  config temp writes use exclusive `wx` create so a planted `.tmp` symlink
  is not followed. No enforcement change. npm publish stays on hold.
- **MCP setup steps (V2-17).** CLI output after `setup` / `mcp connect`, README,
  and docs use short numbered steps (reload, then chat, then the four core
  tools). Commands and paths match real behaviour: stdio args
  `-p <project> serve --stdio`, Cursor `.cursor/mcp.json`, HTTP bind
  `127.0.0.1:8080` at `/mcp`, connect HTTP default `http://localhost:8080/mcp`.
  Default serve is four tools and no prompts; the Set up Grane prompt is listed
  only if authoring is on. Put `--authoring` in the client config args for this
  process. On stdio, `authoring.enabled` advertises all nine tools. HTTP
  authoring needs `auth.agents`. Authoring tools only propose; a human merges
  and pins. User-local `setup_tone` temp writes use flag `wx`. No enforcement
  change.
- **Setup wizard for non-technical users (V2-16).** The first interactive
  question is a tone/skill check: (1) “Connect a warehouse, import my
  existing semantic YAML and configure governance” vs (2) “I have no idea
  what the above means”. Option 1 keeps concise data-engineering wording;
  option 2 is fully plain English and hand-held. The choice is stored in
  `~/.grane/config.json` (`setup_tone`), not in project YAML or the active
  pin, so later setup steps and MCP authoring (V2-18) can read it. Wording
  only: defaults, enforcement, and writes are identical on both paths.
  After tone, `grane setup` asks one start question (default: local demo
  shop on DuckDB), then a confirm. Demo Postgres, own warehouse, and
  existing YAML are explicit choices. MCP registration is skipped unless
  `--connect` is set. Authoring, auto-pin, and demo-shop YAML are never
  implied by a default. `--yes` / `--import` skip the tone question and do
  not write the user-local config. Tone is saved only after confirm (so
  “nothing is written until you say yes” is true). Writes to
  `~/.grane/config.json` refuse a symlink (file or `~/.grane/` dir), use
  temp-file + rename at mode `0600`, and will not overwrite invalid JSON
  (fix or delete the file, then run setup again). `--yes --path demo|own`,
  `--import`, `--postgres`, and `--postgres --authoring` keep the same YAML,
  banners, and ready lines as before. Warehouse hints still say `certified`
  vs `self_certifiable`. DuckDB own-path file defaults to `warehouse.duckdb`.
- **Docs + compat cert (V2-15).** [docs/v2-authoring.md](docs/v2-authoring.md)
  is the operator guide: proposals-as-PRs, experimental vs governed,
  `--authoring`, local vs shared, read-only discovery with sampling caps,
  `grane proposals`, `.grane/active.json` (only `serve` honours it),
  `project.base_branch`, the temporal `group_by` warning on existing YAML,
  demo Postgres ready-made vs build-your-own, and importer status. README
  quickstart links the guide. CI compares `example/` (postgres) and `demo/`
  (duckdb) certify reports to the pre-V2 main baseline (`7a7ffc6`); an
  existing-YAML compat cert loads those projects and allows only the
  temporal warning as a new finding. Docs and README warehouse claims must
  match `WAREHOUSE_CERTIFICATION` exactly (`certified` vs `self_certifiable`);
  no cloud warehouse is certified until a credentialed `certify-cloud` run
  has actually passed. Docs name three categories that match the map
  (`runtime-certified` / `compile-supported` / `not yet certified`); no cloud
  warehouse is runtime-certified. Before/after compile evidence vs pre-V2
  `7a7ffc6` is committed (`docs/v2-compat-evidence.md`). Import/validate never
  pin or overwrite originals. Unsupported YAML is rejected with a How-to-fix
  error. Hand-built dbt/Cube/LookML/Malloy/Ossie fixtures plus pinned
  public Apache-2.0 `dbt-labs/jaffle_shop` (classic) and
  `dbt-labs/metricflow` `simple_manifest` (2 of 112 metrics imported) are
  documented. `jaffle-sl-template` is not vendored (upstream ships no
  LICENSE).
  [docs/release-checklist.md](docs/release-checklist.md) lists credentialed
  `certify-cloud` on the exact RC commit and QA's independent RC cert — do
  not run those from this PR. npm publish stays on hold.
  The configured base is never read from HEAD's committed tree (a feature
  branch that commits `base_branch: feature` cannot become the base). Base
  comes from `base_branch` on `origin/HEAD` / `main` / `master` (a pin is
  checked against that value, not used to discover it); otherwise
  `grane setup` is required. With no committed
  `base_branch`, `origin/HEAD` disagreeing with local `main`/`master` is
  refused. `runGit` strips inherited `GIT_*` and sets
  `GIT_NO_REPLACE_OBJECTS=1`; `refs/replace/*` and `.git/info/grafts` are
  refused. `.grane/` must be a regular directory (not a symlink).
  Committed `project.base_branch` wins over `origin/HEAD` (disagreement is
  refused); working-tree YAML cannot redirect the base or silence audit.
  Approve requires the proposal commit reachable from base (forged
  `Grane-Proposal` trailers are refused). fail_closed audit refuses a
  symlink or `/dev/null`. Gate-7 cases (including these) are wired into
  `traps.ts`. Pinned public projects: `dbt-labs/jaffle_shop` (classic) and
  `dbt-labs/metricflow` `simple_manifest` @ `fe4b8c1c` (Apache-2.0; imports
  2 of 112 metrics, names asserted; 110 skip reasons snapshotted). A
  "measure not found" skip names the missing column-backed primary entity.
  A declared time dimension whose expr
  is `cast(... as DATE)` skips the metric as an unsupported expression, not
  as "not a declared time dimension". A develop-only repo with no
  `origin/HEAD` is refused even if HEAD commits `base_branch`. When
  `origin/<base>` exists, merge detection uses that tip.
- **Authoring gauntlet (V2-14).** `tests/gauntlet/authoring*` is wired into the
  CRITICAL gate. Unexpected errors inside a security scenario score
  `SECURITY CRITICAL` (never report-only `FAIL`). Cases cover prompt injection
  in comments/samples, self-approve, active YAML / pin writes, discovery outside
  the exploration policy, huge schemas, time-like `group_by` (`ts` bigint,
  `period` varchar, `as_of` text), nullable UNIQUE grain, demo Postgres
  composite-PK / keyless / partitioned tables, and hostile slug/path arguments
  — grain, temporal `group_by`, and hostile slug/path are driven through MCP.
  Each hostile path must be refused with Grane's own
  `Refusing to commit path` (git's `Invalid path` is not a pass). Audit
  asserts inspect only lines appended since the action under test.
  SELECT-only INSERT hits the real adapter (`grane_readonly` Postgres when
  live, else DuckDB), not the recording stub.
  Missing pin write/refuse, proposal submit/approve/reject/rollback, or
  discovery `read_only:true` audit lines are `SECURITY CRITICAL`. Successful
  approve and rollback each write a proposal audit line in addition to the pin
  write. Preview/submit refuse `..` and absolute `draft_yaml` paths before
  writing. Unmerged
  proposal commits are refused by approve, rollback, and `writeActivePin`.
  Nested `.grane-demo` repos refuse approve/reject/rollback/pin write. First
  pin is the configured base (`project.base_branch` / develop), never HEAD.
  SELECT-only discovery refuses writes and still sees partitioned parents.
  V2-13 `proposals list|diff|approve|reject|rollback` is exercised against a
  merged proposal. Every authoring case asserts `main` SHA and proposal parent
  are unchanged. The MCP byte-identical sweep and pin tamper table live in the
  gauntlet; the sweep fails if a newly registered MCP tool is not included.
  Rollback `approved_by` defaults to `git user.name`. Pin restore after a
  failed audit write uses temp+rename.
- **Review/approve/rollback CLI (V2-13).** `grane proposals list|diff|approve|reject|rollback`.
  Approve requires a human TTY or a merged GitHub PR and cannot be invoked
  from MCP (`src/mcp/**` must not import or call approve, rollback, reject,
  or proposal-branch delete). `approved_by` defaults to `git user.name`.
  Rollback re-pins a previously approved pin only (`previous_commit` or
  `--to` of that set; `refs/heads/` + full 40-hex SHA, atomic write, pin
  audit). One audit line per action. Fail-closed audit preflights the log
  parent before any write tool/CLI action; if a pin write then fails to
  audit, prior pin bytes are restored. Reject audits before deleting the
  proposal branch (or restores the SHA if the audit write fails). A TTY
  reject prompts `y/N` unless `--yes`. Approve and rollback do not move
  `main` and keep the proposal parent at the original SHA. `proposals
  diff` reports removed metrics and entities, keys restored by the YAML
  merge, and files that lost comments. Approve, rollback, and reject
  refuse a nested demo authoring repo created by setup `--dir`.
- **Active-config pin (V2-12).** `.grane/active.json` is `{ref, commit,
  approved_by, approved_at}`. `grane serve` loads that commit's YAML tree
  when the pin exists; uncommitted edits do not affect serving. Projects
  without a pin behave as today (the only extra validate finding allowed is
  the `temporal_semi_additive_group_by` warning). The first pin is verified
  against the configured base branch (`origin/HEAD` / `main`), not HEAD. A
  merged proposal on a base that already had YAML still pins and validates.
  MCP/authoring cannot write the pin (CLI/TTY only). Serve requires the pin
  ref to equal the configured base under `refs/heads/` (not HEAD, tags,
  other branches, or proposal refs) and the commit to be a full 40-hex SHA.
  The configured base never falls back to HEAD: without `origin/HEAD`,
  `main`, or `master`, set `project.base_branch` to an existing local branch.
  Pin load, refuse (with reason), and write are audited. The pin file is
  written atomically. `approved_by` is a non-empty name (no substring ban).
  Malformed, missing-commit, or hand-edited pins fail closed.
- Setup offers **demo Postgres** (preloaded sample data) nested under the
  existing demo shop path. Inside it the user picks shipped demo YAML (today's
  `grane demo --postgres` behaviour) or builds YAML against demo Postgres via
  discovery, authoring tools, the Set up Grane prompt, the YAML generator, and
  a proposal PR. No shortcuts, no production YAML writes, no pin. DuckDB demo
  and own-data paths stay byte-identical (compared to a fixture captured from
  main). Back-nav on every new step. A glossary term binds to a unique
  revenue-like column when there is only one; several unique sources ask
  rather than preferring a table named `orders`. Detection and glossary
  binding share one grain rule, so a keyless table the user later resolves
  is asked about instead of silently dropping the metric. Composite-PK and
  keyless tables are listed in `skipped_tables`, not dropped. Demo Postgres
  uses `GRANE_DEMO_DATABASE_URL` only (ignores `DATABASE_URL`). `--dir` that
  is already a git repository is refused. The activate gauntlet records
  `git rev-parse main` before the MCP walk and asserts it is unchanged after,
  with the proposal branch parented at that original SHA.
- Validator warns (does not fail) existing YAML whose semi-additive
  `group_by` tracks the `time_dimension` or time-like columns stored as
  number/text (`ts` bigint, `period` varchar, `as_of` text). Authoring
  drafts still refuse that `group_by` as an error. Fan-out `preaggregate`
  copy explains that Grane totals the many side first. Nullable UNIQUE
  columns are not a grain.
- Demo Postgres schema includes a composite-PK table (`inventory_levels`), a
  keyless table (`event_stream`), and a partitioned parent (`daily_rollups`).
- `grane setup` (`grane onboard`) is a guided first-run after `git clone` +
  `npm install`: demo DuckDB or your own warehouse, validate, then
  `mcp connect`. Interactive prompts by default; `--yes --path demo|own` is
  the CI escape hatch. README "Try it" leads with this command.
- `grane setup` interactive steps accept `back` / `b` to return to the
  previous prompt. Own-data path offers every shipped warehouse
  (`postgres`, `mysql`, `duckdb`, `clickhouse`, `snowflake`, `bigquery`,
  `databricks`, `redshift`) with certified vs self_certifiable hints.
- CI sets `GRANE_CERT_REQUIRE=postgres,duckdb,mysql,clickhouse`.
  `loadAvailableEngines` throws if a required engine is unavailable instead of
  skipping it. Local runs without the variable still skip missing warehouses.
  Cloud engines stay `self_certifiable`.
- Gauntlet CI fails when any scenario scores `SECURITY CRITICAL` or
  `CRITICAL FAIL`. Ordinary `FAIL` stays report-only.
- Certification map / README / docs label MySQL 8 only. MariaDB is not
  CI-certified (`mysql:8.4` is the CI engine).
- `additive: none` is refused as unsupported (`invalid_query`). Validate
  reports `unsupported_additive_none`. It is not compiled as a governed SUM.
- Authoring detects conflicting candidates (multiple revenue-like columns,
  multiple date columns per entity, non-additive measures, fan-out joins via
  the relationship graph) and surfaces them as questions through
  `list_ambiguities` / `resolve_ambiguity`. It asks rather than guesses.
  Non-additive measures default to safe: `additive: none` is refused or asked,
  never emitted as a governed SUM. Open ambiguities block `submit_proposal`
  and are flagged on `propose_definitions` / `preview_yaml`. Resolving a
  snapshot as `semi` also asks for `group_by` so drafts pass
  `vacuous_semi_additive_group_by`. The metric time dimension and other
  temporal columns are not group_by candidates (grouping by `snapshot_at`
  would sum every snapshot). `submit_proposal` refuses invalid preview YAML.
- Authoring sessions generate draft YAML (`src/authoring/generate.ts`) in the
  current schema. `propose_definitions` delegates to it. Output is deterministic
  and must pass `loadConfig` + `validateModel` before `submit_proposal`.
  Relationships go through `planRelationshipWrite` using existing file and
  catalog maps. `createProposal` unions semantic YAML with the base branch
  (refuses on key conflicts) so drafts do not clobber adopter files.
  Exploration allow-list wildcards are never emitted. Entity `primary_key`
  comes from introspected PRIMARY KEY metadata only — never `id`, the first
  column, or a composite-key column (false grain). Composite-PK tables are
  skipped unless a column has its own single-column UNIQUE constraint.
  Keyless tables are asked, with `skip` to omit them. Unresolved/skipped
  tables are listed, not silently dropped. Glossary answers become metric
  `description`. Postgres PK lookup uses `pg_constraint` (visible to
  SELECT-only roles) and includes partitioned parents (`relkind` `p`).
  DuckDB PK lookup is schema-filtered. YAML map keys sort in ordinal (not
  locale) order.
  Semi-additive group_by refusals for the primary key and for temporal columns
  have distinct messages. Postgres, MySQL, and DuckDB introspection populate
  that metadata.

## 0.7.0

First release after 0.6.4 (`0.6.5` was never published to npm). On main since
0.6.4: Part 1 HTTP/auth/audit/exploration hardening; warehouse workstreams
WS1–WS6 (Postgres 16, MySQL 8, DuckDB 1.5, ClickHouse 24 certified in CI;
Snowflake, BigQuery, Databricks, and Redshift remain `self_certifiable`);
`grane certify`; MySQL client-deadline hotfix (#62).

- `grane certify --engine <type>` runs the shared certification corpus against
  one warehouse. It creates and drops `grane_cert_<runid>` and refuses
  connections that lack CREATE SCHEMA (never seeds existing adopter tables).
  Writes `certification/<engine>.json` plus a human summary. Snowflake,
  BigQuery, Databricks, and Redshift skip when `GRANE_CERT_*` is unset
  (`docs/certify.md`). `.github/workflows/certify-cloud.yml` is present but
  dormant (`workflow_dispatch`, optional weekly schedule, optional PR label
  `certify-cloud`); jobs skip cleanly without secrets. Cloud cost controls:
  BigQuery `maximumBytesBilled` from `limits.max_bytes_billed` (default 10 GiB),
  Snowflake `QUERY_TAG=grane` with `STATEMENT_TIMEOUT_IN_SECONDS`, Databricks
  `queryTimeout` from `limits.timeout_ms`. Redshift is self-certifiable via
  this path; Postgres CI certification does not cover it. Cloud engines stay
  `self_certifiable` (not flipped to `certified` without CI evidence).
- MySQL `limits.timeout_ms` is a client deadline that destroys the socket.
  Server `max_execution_time` is a later backup: at the same instant as the
  client deadline, MySQL 8.4 can return a successful SLEEP (`1`) or BENCHMARK
  (`0`) row, so the query would resolve instead of rejecting.

- ClickHouse 24 is `certified`: the shared corpus and connector-safety suite
  run in CI (`clickhouse/clickhouse-server:24.8`). Every query sets
  `readonly=1`, `join_use_nulls=1` (unmatched LEFT JOIN is NULL),
  `session_timezone=UTC`, `aggregate_functions_null_for_empty` (empty SUM is
  NULL), and quotes 64-bit JSON integers. `contains` uses
  `positionCaseInsensitiveUTF8` (ClickHouse 24 has no `LIKE … ESCAPE`).
  Timestamp localization uses `formatDateTime(..., '%F %T')` (ClickHouse 24
  `%M` is the month name, not minutes). The cardinality wrapper is an
  equi-join on `__grane_join` because `LEFT JOIN ON TRUE` becomes CROSS JOIN
  and drops empty right sides. Ratios CAST to `Nullable(Decimal)`.
  `@clickhouse/client` is a dev/optional dependency. Seed DDL uses
  `MergeTree` + `Nullable(...)`.

- MySQL 8 is `certified`: the shared corpus and connector-safety suite run in
  CI (`mysql:8.4`, timezone tables loaded via `mysql_tzinfo_to_sql` so
  `CONVERT_TZ` works). `mysql2` is a dev/optional dependency so CI has the
  driver. `grane mcp doctor` warns when named-zone `CONVERT_TZ` returns NULL.
  Aggregates use `CASE WHEN` (MySQL has no `FILTER`). `COUNT(*) OVER` needs
  8.0+. MySQL seed SQL doubles backslashes so `contains 'A\\B'` is a real
  backslash, not C-escape stripping.

- Warehouse certification map (`src/connectors/certification.ts`): Postgres 16,
  MySQL 8, DuckDB 1.5, and ClickHouse 24 are `certified` (shared corpus in CI).
  Other engines are `self_certifiable`, not certified. `catalog.server.warehouse`
  reports `{ type, certification, certified_version }`. `grane validate --production`
  warns (does not fail) when the configured engine is not certified.

- Certification corpus plumbing is engine-agnostic: seed arrays and TypeScript
  gold in `tests/certification/`, `ddl(dialect)` from a column-type map, and a
  `CertEngine` adapter (`tests/helpers/engines/`). Postgres, DuckDB, MySQL, and
  ClickHouse run the same parameterised suite (`tests/certification/corpus.test.ts`).
  Reports write to `certification/<engine>.json`. Connector session safety is
  unchanged.

- Connector session safety: MySQL `SET SESSION TRANSACTION READ ONLY` and
  `time_zone = '+00:00'` on the query connection; ClickHouse `readonly=1`,
  `join_use_nulls=1`, and `session_timezone=UTC`; Snowflake `TIMEZONE=UTC`
  with `STATEMENT_TIMEOUT_IN_SECONDS`; Databricks `SET TIME ZONE 'UTC'`;
  DuckDB re-pins UTC on every query. BigQuery empty results keep column
  names from the getQueryResults API schema (`schema.fields`), not
  `job.metadata` or `Object.keys` of the first row.

- HTTP MCP binds `127.0.0.1` by default (`--host` to change). Unauthenticated
  HTTP on a non-loopback address requires `--allow-anonymous`. A warning is
  printed whenever `auth.agents` is empty. The Docker image still listens on
  `0.0.0.0:8080` so published ports work; the demo compose file passes
  `--allow-anonymous`. Production HTTP without agents fails closed.
- Per-agent `exploration` defaults to `false` (global `exploration.enabled`
  already did).
- Postgres and MySQL verify TLS certificates when `connection.ssl` is true.
  Set `connection.ssl_verify: false` to opt out.
- `limits.timeout_ms` is honoured on ClickHouse, Snowflake, Databricks, and
  DuckDB, not only Postgres, MySQL, and BigQuery.
- One write-keyword list in `src/connectors/types.ts` for the kernel and every
  connector.
- Docs no longer claim every warehouse wraps queries in a Postgres `READ ONLY`
  transaction. The database role remains the real control.
- HTTP MCP caps request bodies at 1 MiB (`413`), sets `requestTimeout` /
  `headersTimeout`, and refuses extra `/mcp` work with `503` once
  `limits.max_concurrency` in-flight requests are reached (default 2 ×
  `connection.pool_size`). Optional `limits.rate_limit_rps` is a process-wide
  token bucket (`429`). `SIGTERM`/`SIGINT` drain in-flight requests then close
  the warehouse connector. Postgres/MySQL pool size is `connection.pool_size`
  (default 5).
- Exploration supports `mode: allowlist` with `include` patterns, wildcards
  (`customers.*`, `*.email`, `*_ssn`) on include/exclude, and per-agent
  `exploration_exclude`. Empty allowlist include permits nothing. The gauntlet
  mutation-checks an opened allowlist the same way it checks an emptied
  denylist.
- HTTP-originated audit events include `request_id` (honours `X-Request-Id`,
  else generated), `client_ip`, and `user_agent`.
- `audit.fail_closed: true` (or `GRANE_AUDIT_FAIL_CLOSED=1`) refuses the query
  with `config_error` when the audit append fails. Default stays best-effort.
- Every executed statement is prefixed with
  `/* grane query_id=q_… agent=finance */` for warehouse-side attribution.
- `auth.agents[].token_sha256` is an alternative to plaintext `token:` so
  `grane.yml` need not hold a secret.
- ClickHouse and Databricks take column names from result metadata, so an
  empty governed result still has its columns.
- `grane validate --production` / `grane doctor --production` fail on
  production fail-open conditions (no agents, agent `exploration: true`,
  TLS verify off, audit path not writable, limits above ceilings,
  `status: experimental` metrics).
- `grane test` runs user-authored YAML scenarios (query + disposition /
  status / gold) against the project warehouse. `grane-tests.yml` next to
  `grane.yml` is skipped by the config loader so it is not merged as project
  YAML.
- Docker publish records provenance and an SBOM; `node:22-alpine` is pinned
  by digest; Dependabot covers npm, Actions, and Docker; `SECURITY.md`
  points at GitHub private vulnerability reporting.

- Public-alpha front door: the package exposes both `grane` and
  `grane-analytics` binaries so `npx grane-analytics demo` resolves after
  this version is published (0.6.4 on npm has neither `demo` nor that
  alias). The default DuckDB demo writes `connection.type: duckdb` and
  `path: warehouse.duckdb` into the project it just built, so later
  `query` / `validate` / MCP commands use that warehouse without Postgres
  or Docker. `--postgres` is unchanged. `mcp connect` follows the npm bin
  symlink so client configs launch `node …/dist/cli/index.js` instead of
  assuming `grane` is on PATH. See `tests/unit/demo.test.ts`.

- Unique multi-hop pre-aggregation reach/cardinality CTEs walk every hop in
  the selected path, including intermediate `one_to_many` hops that are not
  uniqueness-guarded. Previously those hops were skipped, so a later
  `many_to_one` guard could alias an earlier CTE (`FROM reach_hop_mid AS hop_sku`)
  and the warehouse binder failed. Depth-general: any unique path with a
  1:N hop between the first child and a later N:1 hop. See
  `tests/unit/preagg-multihop-alias.test.ts`.

- Ambiguous fan-out measure paths refuse with `ambiguous_query` instead of
  BFS-picking the first YAML-declared route. Unique fan-out pre-aggregation
  is unchanged. See `tests/unit/ambiguous-fanout-path.test.ts`.

- Ordinary comparison and membership operators reject JSON null
  (`invalid_query`) rather than compiling SQL `= NULL` / `IN (…, NULL)`.
  Use `is_null` / `is_not_null`. Query filters and metric-definition filters
  share the rule. See `tests/unit/null-filter-semantics.test.ts`.

- Live PostgreSQL certification: GitHub Actions runs a purpose-built
  correctness corpus against PostgreSQL 16 on every PR (read-only runtime
  role, independent SQL oracles). Compile inspection is not treated as
  warehouse certification. See `tests/unit/postgres-live-certification.test.ts`.

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
