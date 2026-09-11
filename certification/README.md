# Certification corpus

Workstream 1 of the multi-engine certification plan. The analytical scenarios
are the #36 corpus; this directory holds engine-agnostic plumbing.

| Path | Role |
| --- | --- |
| `tests/certification/data.ts` | Shared seed arrays |
| `tests/certification/ddl.ts` | `ddl(dialect)` from the column-type map |
| `tests/certification/gold.ts` | TypeScript reductions (never SQL on the engine under test) |
| `tests/certification/corpus.test.ts` | `describe.each(engines)` |
| `tests/helpers/cert-engine.ts` | `CertEngine` adapter |
| `tests/helpers/engines/` | Postgres + DuckDB (real); MySQL / ClickHouse (stubs until WS3/WS4) |

## Running

`npm run test:unit` loads the suite through
`tests/unit/postgres-live-certification.test.ts` (thin alias). Vitest does **not**
collect `tests/certification/*.test.ts` directly, so `npm test` does not double-run
the corpus.

Postgres runs when `GRANE_PG_WRITE_URL` / `GRANE_PG_READ_URL` resolve (GitHub
Actions `postgres:16`). DuckDB runs whenever `@duckdb/node-api` is installed
(devDependency). MySQL and ClickHouse adapters exist as stubs and are not
enrolled until those workstreams add CI services.

## Report artifact

Each available engine writes `certification/<engine>.json` at the end of the
suite (gitignored JSON; this README is kept):

- engine version and session settings
- capability flags
- scenario pass/fail
- connector safety probes (SELECT-only SQL, no `__grane_` leak, UTC session)

CI uploads `certification/*.json` as the `certification-reports` artifact.
Locally the files appear in the repo root `certification/` directory after
`npm run test:unit`.
