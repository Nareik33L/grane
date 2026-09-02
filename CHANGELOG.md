# Changelog

## Unreleased

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
