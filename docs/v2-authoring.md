# V2 authoring

V2 adds a **proposal workflow** for new metric YAML: an agent (or you) drafts
definitions, Grane opens a GitHub pull request, a human merges it, then
`grane serve` can pin that merge. Existing `example/` and `demo/` YAML are
unchanged. Query, validate, and `grane certify` stay on the pre-V2 path unless
you turn authoring on.

This page is the operator guide. Implementation lives in `src/authoring/`,
`src/mcp/authoring.ts`, and `src/cli/proposals.ts`.

## Proposals are GitHub PRs

Approval is **merging a GitHub pull request**. Anyone with merge rights on the
repository can merge. Grane does not merge, reset, or move `main`.

```text
authoring_start → discover_schema → (profile_column) → record_term
       → list_ambiguities / resolve_ambiguity
       → propose_definitions → preview_yaml → submit_proposal
       → git branch grane/proposal/<id>
       → gh pr create --base <configured base> --head grane/proposal/<id>
       → human merges the PR
       → grane proposals approve <id>     # validates YAML, pin branch + PR
       → human merges the pin PR          # grane.pin.json on the base
       → grane serve                      # honours grane.pin.json
```

`submit_proposal` writes a local `grane/proposal/*` branch with plumbing
(`commit-tree` + `update-ref`). It never checks out that branch and never
writes production YAML or `.grane/active.json`. The printed `github.command`
is the `gh pr create` line to open the PR.

AI-generated metrics in the PR stay **experimental** until merge. The merge
marks them **governed**. `query()` does not load draft YAML from a session.

MCP cannot approve, roll back, reject, or delete a proposal branch. Those
are CLI/TTY only (`src/mcp/**` does not import them).

## Experimental vs governed

| State | Where | `query()` trust |
| --- | --- | --- |
| Draft on an authoring session | `.grane/sessions/` | Not loaded |
| On an open proposal / unmerged PR | `grane/proposal/*` | `experimental` — a lead, not approved truth |
| After the GitHub PR is merged | configured base branch | `governed` (status becomes approved) |
| Hand-written `status: approved` | existing YAML | `governed` |

`trust: mixed` is governed metrics plus experimental or raw fields. Present
that as a lead. `trust: exploratory` is warehouse columns only.

## `--authoring`

Authoring MCP tools are **off** until you enable them.

```bash
grane serve --stdio --authoring
grane serve --authoring                  # HTTP; requires auth.agents
grane setup --yes --path demo --postgres --authoring
```

`--authoring` enables authoring tools for **this process**.
On stdio, put `--authoring` in the client config args
(`grane serve --stdio --authoring`). On HTTP, pass `--authoring` to
`grane serve` — do not put stdio args in the client config.
On stdio, `authoring.enabled: true` in `grane.yml` also advertises all 9 tools
(and the Set up Grane prompt). HTTP needs `authoring.mode: shared` and
`auth.agents`. Authoring tools only propose a GitHub PR. Nothing is live until a
human merges and pins.

The nine tools (and the **Set up Grane** prompt) are:

`authoring_start`, `discover_schema`, `profile_column`, `record_term`,
`list_ambiguities`, `resolve_ambiguity`, `propose_definitions`,
`preview_yaml`, `submit_proposal`.

Core tools stay `catalog`, `query`, `validate`, `explain`.

## Guided conversation (Set up Grane)

The **Set up Grane** prompt is a conversation with a data engineer, not a form.
The first question is open-ended (“What metrics are important to you?”). The
agent inspects discovered columns and suggests plain-English meanings
(table/column, calculation, filters, grain). The user confirms or adjusts by
multiple choice. Suggested meanings stay **unconfirmed until the user picks
one** — nothing ambiguous is settled silently. After `propose_definitions`,
the play-back summary is derived from the draft YAML (name, table/column,
calculation, filters, grain, and description) and must match the proposal
exactly. If the session changes after `propose_definitions` (a later
`resolve_ambiguity`, `record_term`, or any other edit), `submit_proposal`
refuses until you call `propose_definitions` again — it will not commit a
stale draft.

Wording comes from `setup_tone` in `~/.grane/config.json` (the V2-16 wizard
choice). The MCP server **only reads** that file, with the same refusal of
symlinks and invalid JSON as the writer. Tone changes wording and verbosity
only — never defaults, YAML, or the proposal. Missing config defaults to
`technical`.

There is no skip-review path. If the user asks to approve, pin, skip review,
or mark metrics live, the agent must refuse. A proposal stays experimental
until a human merges the pull request and pins.

## Local vs shared

`authoring.mode` is the setup choice for *where* enabled tools are advertised
without `--authoring`:

| `mode` | stdio (`grane serve --stdio`) | HTTP (`grane serve`) |
| --- | --- | --- |
| `local` (default) | yes, if `authoring.enabled` | no |
| `shared` | yes, if `authoring.enabled` | yes, **authenticated** agent only |

HTTP authoring requires `auth.agents`. Anonymous HTTP never sees the tools.
`--authoring` on HTTP still requires at least one agent token.

```yaml
authoring:
  enabled: true
  mode: local          # or shared
  sampling: true
  sample_rows: 20
```

Prefer `local` on a laptop. Use `shared` only when a remote agent should
draft proposals, with bearer tokens and an allowlisted exploration policy.

## Discovery is read-only

`src/authoring/discover.ts` is the only path `discover_schema` and
`profile_column` use. It:

- Issues **SELECT / WITH only** (multi-statement, writes, and `WITH … INSERT`
  are refused before the driver).
- Honours `exploration` include/exclude and schema allow-lists.
- Clamps `authoring.sample_rows` to a hard cap of **50** rows
  (`DISCOVERY_SAMPLE_ROW_HARD_CAP`). Default request is 20.
- Returns samples to the caller only — they are never written to YAML, the
  audit log, or the session. The audit line records a hash, not values.
- Writes one `kind: discovery` audit event with `read_only: true`.
- Collapses driver errors to `Warehouse query failed.` so DSNs and samples
  do not leak.

`sampling: false` still counts distincts and introspects; it does not `SELECT`
column values. Setup `--offline` can disable sampling the same way.

## `grane proposals` CLI

```bash
grane proposals list
grane proposals diff <id>
grane proposals approve <id> [--approved-by NAME]
grane proposals reject <id> [--yes]
grane proposals rollback [--to <sha>] [--approved-by NAME]
```

- **list / diff** — local `grane/proposal/*` branches. Diff is against the
  active pin or the configured base. JSON includes semantic added/changed/removed
  metrics and entities, keys restored by the YAML merge, and lost comments.
- **approve** — validates YAML at the proposal's merged commit first (refuses
  before writing anything if invalid), then pins that commit — the merge
  commit, or the squash/rebase commit on the configured base whose metric
  YAML matches the proposal, **not** the moving base tip. The pinned commit
  must be reachable from the base. If no matching commit exists, it refuses
  with a clear message (never pins silently). Commits `grane.pin.json` on
  `grane/pin/*` and prints `gh pr create`. Does not merge or push the base.
  `approved_by` defaults to `git user.name`. Legacy `.grane/active.json`
  users: approve used to pin the base tip; it now pins the proposal's merged
  commit. Known limit: identical YAML committed straight to the base (no PR)
  matches as if squash-merged. Close that with branch protection (no direct
  pushes to `main`) and T2.
- **reject** — deletes the proposal ref after the audit line (restores the SHA
  if that write fails). TTY prompts `y/N` unless `--yes`. Does not write the pin.
- **rollback** — re-pins `previous_commit`, or `--to` of a previously approved
  pin only (full 40-hex SHA). When `grane.pin.json` is present, rollback
  writes the last-good local pin **and** commits a `grane/pin/*` branch
  (prints `gh pr create`) — the same as approve. It never pushes or merges.
  A last-good-only write would be ignored because the tracked file wins.

None of these move `main` or the proposal parent. Nested demo authoring repos
(`.grane-demo` from `setup --dir`) refuse approve / reject / rollback / pin
write.

## `grane.pin.json` pin (tracked; `serve` honours it)

The approved version is a **tracked** file at the repo root so other clones
see it after the pin PR is merged. It is not gitignored.

```json
{
  "ref": "main",
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "approved_by": "Ada",
  "approved_at": "2026-10-16T12:00:00.000Z"
}
```

- **`grane serve`** loads YAML from that commit. Uncommitted edits do not
  change what agents query. `catalog` / `serverInfo` include `active.commit`
  and a `config_hash` that does not depend on absolute filesystem paths.
  Pin health messages go to **stderr** (`pin_warnings`): origin differs,
  this clone has no pin but origin does, the pin is not on the base, and
  the legacy `.grane/active.json` migration warning. Serve never
  auto-switches to origin's pin.
- **`grane doctor --json`** adds `config_hash` (same hash as catalog) and
  `pin_warnings` (same strings serve prints on stderr). Those fields are
  informational; the process exit code follows production lint (`ok`),
  not pin warnings (fail-open). A missing local pin while
  `origin/<base>:grane.pin.json` exists is a warning, not a refuse.
- **`grane validate`, `grane query`, `grane certify`, `loadConfig`** read the
  working tree.
- Existing clones with **no tracked pin** still honour local
  `.grane/active.json` (today's behaviour) and print a migration warning.
- `ref` must be the configured base under `refs/heads/` (not `HEAD`, a tag,
  another branch, or a proposal ref). `commit` must be a full 40-hex SHA on
  that base. A hand-edited tracked pin that is not on the base is refused.
- MCP and authoring tools cannot write the pin. Malformed or hand-edited pins
  fail closed. Pin load / refuse / write are audited.

Two-person evidence run: [two-person-test.md](two-person-test.md).

## `project.base_branch`

The configured base comes only from an **already-established** trusted source:

1. `project.base_branch` committed on the tree of `origin/HEAD`, `main`, or
   `master` (never `HEAD`, never the working-tree `grane.yml`, never a
   hand-edited pin), or
2. `origin/HEAD`, else local `main` / `master`, when no `base_branch` is
   committed on those trees.

A valid pin's `ref` must equal that base; the pin is not used to *discover*
the base (a hand-edit of `ref` cannot redirect it). Checking out a feature
branch that commits `base_branch: feature` does **not** make `feature` the
base. A develop-only repo with no `origin/HEAD` and no local `main`/`master`
is **refused**, even if HEAD (or a feature branch) commits `project.base_branch`
— that value is not read from HEAD. Create `origin/HEAD` or `main`/`master`,
or run `grane setup` after that ref exists.

When `refs/remotes/origin/<base>` exists, approve/merge detection uses that
tip, not a local-only rewrite of `refs/heads/<base>`.

When committed `project.base_branch` is set, it wins. If `origin/HEAD` names a
different branch, Grane refuses. When `base_branch` is unset, `origin/HEAD`
disagreeing with local `main`/`master` is also refused. `origin/HEAD` (else
local `main` / `master`) is the fallback **only** when no `base_branch` is
committed on an established base.

```yaml
project:
  name: shop
  timezone: UTC
  base_branch: develop    # must be committed on main/master/origin/HEAD, not on a feature HEAD
```

The first pin must be a commit on that base. Feature-branch HEADs are refused.

## Trusted git history and `.grane/`

Authoring shells every `git` spawn with inherited `GIT_*` stripped and
`GIT_NO_REPLACE_OBJECTS=1`. A repo with `refs/replace/*` or a non-empty
`.git/info/grafts` is refused — `git replace` (or grafts) must not make a
proposal look like a parent of the base. Shallow clones are allowed.

`.grane/` must be a regular directory (`lstat`, not a symlink) so the
legacy pin and audit trail cannot live outside the project. `grane.pin.json`,
`active.json`, and the audit file must be regular files, not symlinks or
devices (`/dev/null`).

## Temporal `group_by` warning on existing YAML

Validator **warns** (does not fail) existing YAML whose semi-additive
`group_by` tracks the metric `time_dimension` or time-like columns stored as
number/text (`ts` bigint, `period` varchar, `as_of` text):

```text
WARNING temporal_semi_additive_group_by
```

Authoring drafts (`validateModel(..., { generated: true })`, preview, submit)
still **refuse** that `group_by` as an error. Projects without a pin behave as
today: the only extra validate finding V2 is allowed to add is this warning.

## Demo Postgres: ready-made vs build-your-own

`grane setup` (or `npm run setup`) first asks a tone/skill check:

1. **Connect a warehouse, import my existing semantic YAML and configure governance**
   — concise data-engineering wording for the rest of the flow.
2. **I have no idea what the above means** — everyday words and hand-held steps.

That choice is stored in `~/.grane/config.json` (`setup_tone`), not in project
YAML and not in `.grane/active.json`. Later setup steps and the MCP Set up
Grane prompt (V2-18) can read the same tone. It changes wording only: defaults,
enforcement, and writes are the same on both paths. `--yes` and `--import`
skip the question.

Then it asks **one** start question. The default is the local demo shop
(DuckDB, no database to install). Type `back` to return to the previous step.
MCP registration is skipped unless you pass `--connect`.

1. **Try the demo shop (recommended)** — files on this computer. Same planted
   revenue-drop story. Authoring stays off.
2. **Demo with Postgres (Docker)** (`localhost:5433`) — then:
   - **Use the ready-made demo YAML (recommended)** — today's
     `grane demo --postgres`. Authoring stays off. No pin.
   - **Build my own YAML against this demo (advanced)** — discovery, authoring
     tools, Set up Grane prompt, YAML generator, then a proposal PR. No
     production writes and no pin. Uses `GRANE_DEMO_DATABASE_URL` only
     (ignores `DATABASE_URL`).
3. **Connect my own data** — any shipped warehouse. Writes starter
   `grane.yml` (the `grane init` templates, not the demo shop). Authoring
   stays off. No pin.
4. **I already have Grane YAML** — load, check, then activate on a terminal.
   No AI authoring (`grane setup --import <dir>` never pins).

```bash
npm run setup -- --yes --path demo --connect cursor
npm run setup -- --yes --path demo --postgres
npm run setup -- --yes --path demo --postgres --authoring
npm run setup -- --import ./analytics --offline
```

`--dir` that is already a git repository is refused on the demo-authoring
path. `--yes --path demo|own` and `--import` keep the same project YAML and
ready lines as before this wizard change.

## Importers (unchanged)

`grane init --provider ../your_project` still imports dbt/MetricFlow, Cube,
LookML, Ossie, Malloy, or a Grane-shaped fragment. What Grane cannot compile
faithfully is **skipped with a reason**, never guessed. Native YAML next to
`grane.yml` is always loaded.

| Kind | Status |
| --- | --- |
| dbt / MetricFlow | Simple cases only. The pinned `simple_manifest` imports **2 of 112** metrics. See [providers.md](providers.md) and [metricflow-support.md](metricflow-support.md). |
| Cube (YAML / `cube.js`) | Supported. JS is parsed, never eval'd. |
| LookML | Supported. `derived_table` binds to a materialized relation. |
| Apache Ossie | Supported. |
| Malloy | Simple `source` / `measure` / `dimension` / `join_one`. |
| Fragment | Grane-shaped YAML/JSON. |

MetricFlow import currently covers only simple cases. dbt-labs/metricflow
`simple_manifest` (Apache-2.0, `tests/fixtures/metricflow-simple`) imports
**2 of 112** metrics (`largest_listing`, `smallest_listing`). Everything
else is skipped with a reason. Main unsupported constructs: semantic models
with `primary_entity` but no column-backed primary entity; `sum` (and
non-count aggs) over a literal such as `expr: 1`; cumulative / conversion /
`grain_to_date` / windows; derived expressions other than `metric / metric`
(offsets, aliases, `*`, `-`); `median` / `percentile`; metric filters Grane
cannot translate (`Entity()`, `or`, `in`, comparisons, `TimeDimension`);
ratio-level filters; SQL-expression dimensions including
`cast(ordered_at as DATE)` time dimensions (the metric skip names the
unsupported expression — it does not say "not a declared time dimension").
`cast(...)` and `sum(1)` are not imported.

V2 authoring does not replace importers. Import existing definitions; author
only what you do not already govern.

## Compatibility

`example/analytics`, `example/analytics-duckdb`, and `demo/analytics` must
produce the same `grane certify` scenario set as pre-V2 main (`7a7ffc6`).
CI compares the postgres (example) and duckdb (demo) reports to
`tests/fixtures/v2-compat/`. An existing-YAML compat cert loads those
projects and allows only the temporal `group_by` warning as a new finding.

Supported existing YAML keeps the same metrics, meaning, and compiled SQL.
The before/after evidence report (pre-V2 `7a7ffc6` vs now) is
[v2-compat-evidence.md](v2-compat-evidence.md) and
`tests/fixtures/v2-compat/pre-v2-compile-evidence.json`.

Unsupported or ambiguous YAML is rejected with an actionable error that
tells the user how to fix it (see validate issue codes such as
`ambiguous_relationship` and `unsupported_additive_none`).

`grane setup --import` and `grane validate` never write `.grane/active.json`
and never overwrite the user's original YAML.

Import/validate corpora include hand-built representative provider shapes
plus pinned Apache-2.0 public projects (`dbt-labs/jaffle_shop` /
jaffle-shop-classic, and dbt-labs/metricflow `simple_manifest`). MetricFlow
import is not general-purpose: `simple_manifest` imports 2 of 112 metrics.
See [Real-world corpora](#real-world-corpora) and
[metricflow-support.md](metricflow-support.md).

## Real-world corpora

Import/validate compat uses two kinds of tree.

**Hand-built representative shapes** (not upstream checkouts; used for
MetricFlow/Cube/LookML/Malloy/Ossie parser coverage):

| Tree | Kind | Source |
| --- | --- | --- |
| `example/analytics`, `example/analytics-duckdb`, `demo/analytics` | Multi-entity Grane YAML | Shipped shop (orders, customers, products, payments, refunds). Byte-identical to pre-V2 `7a7ffc6`. |
| `example/analytics-from-dbt`, `example/dbt-shop` | dbt / MetricFlow | Example dbt shop imported via `providers:`. |
| `tests/fixtures/dbt-shop`, `tests/fixtures/dbt-saas` | dbt / MetricFlow | Realistic MetricFlow shop and SaaS shapes (`semantic-fidelity.test.ts`). |
| `tests/fixtures/cube-shop`, `tests/fixtures/cube-js-shop` | Cube | YAML cubes and `cube.js` (parsed, never eval'd). |
| `tests/fixtures/lookml-shop` | LookML | Looker-style view. |
| `tests/fixtures/malloy-shop` | Malloy | `source` / `measure` / `dimension`. |
| `tests/fixtures/ossie-shop` | Ossie | Semantic-model datasets. |

**Pinned public project** (source + license credited; fixed commit):

| Tree | Kind | Source |
| --- | --- | --- |
| `tests/fixtures/jaffle_shop`, `tests/fixtures/jaffle_shop-import` | dbt | [dbt-labs/jaffle-shop-classic](https://github.com/dbt-labs/jaffle-shop-classic) `@ fd7bfacae4f497ff044a6a0275268676bf1b64c3` (Apache-2.0). Historical URL: `dbt-labs/jaffle_shop`. Classic jaffle has no MetricFlow `semantic_models`; import detects `dbt` and yields the empty-graph warning. The Grane wrapper at `jaffle_shop-import` loads that path via `providers:` and `validate` stays clean. |
| `tests/fixtures/metricflow-simple`, `tests/fixtures/metricflow-simple-import` | dbt / MetricFlow | [dbt-labs/metricflow](https://github.com/dbt-labs/metricflow) `simple_manifest` `@ fe4b8c1ccb72a8ca77494b345777eff20a714119` (Apache-2.0). Imports **2 of 112** metrics (`largest_listing`, `smallest_listing`). Tests assert that exact count and the imported metric, entity, and dimension names. A compile test checks `largest_listing` SQL. |
| `tests/fixtures/metricflow-expr-time` | dbt / MetricFlow | Apache-2.0 derivative of the same `simple_manifest` `listings_latest.yaml` @ `fe4b8c1c…`, with `ds.expr` changed to `cast(created_at as DATE)`. Tests assert the metric skip reason names that unsupported expression (not "not a declared time dimension"). |

## Warehouse categories

Docs use three categories that match `WAREHOUSE_CERTIFICATION` 1:1. No cloud
warehouse is runtime-certified.

| Category | Map state | Engines |
| --- | --- | --- |
| runtime-certified | `certified` | PostgreSQL 16, MySQL 8, DuckDB 1.5, ClickHouse 24 |
| compile-supported | `self_certifiable` | Snowflake, BigQuery, Redshift, Databricks |
| not yet certified | `compile_only` | none today |

## Cloud certify (release step)

`.github/workflows/certify-cloud.yml` is dormant. Snowflake, BigQuery,
Databricks, and Redshift are `self_certifiable`, **not certified**
(compile-supported / not runtime-certified). A pending or skipped dispatch does
not change that. Do not write that a cloud warehouse is certified until a
**credentialed `certify-cloud` run has actually passed** and
`WAREHOUSE_CERTIFICATION` in `src/connectors/certification.ts` is updated to
match. Docs and README must keep the map exactly (`certified` vs
`self_certifiable`).

**Pending release step:** Kieran adds `GRANE_CERT_*` and runs `certify-cloud`
once before the V2 tag. See [certify.md](certify.md) and
[release-checklist.md](release-checklist.md). Do not run that workflow with
real secrets from a public PR. npm publish stays on hold.
