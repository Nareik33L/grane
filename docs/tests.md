# Adopter test suites

`grane test` runs YAML scenarios you write against **your** warehouse. It is
not the internal gauntlet. The scenario shape is the gauntlet's
`query` + `expectation` + `disposition`, without the hostile-warehouse
harness.

```bash
grane test                 # grane-tests.yml or grane-tests/*.yml
grane test path/to/suite.yml
grane test path/to/dir
```

Exit 0 when every scenario matches. Exit 1 on a mismatch. Exit 2 when no
files are found.

```yaml
# grane-tests.yml
scenarios:
  - id: revenue-last-month
    query:
      metrics: [revenue]
      time: { period: last_month }
    disposition: execute
    expectation:
      trust: governed
      gold: 184230            # or { kind: scalar, value: 184230, column: revenue, tolerance: 0.01 }

  - id: unknown-metric
    query:
      metrics: [not_a_metric]
    disposition: refuse
    expectation:
      status: undefined_metric

  - id: empty-window
    query:
      metrics: [revenue]
      time: { from: "1999-01-01", to: "1999-01-31" }
    disposition: execute
    expectation:
      gold: { kind: empty }
```

`disposition` may be `execute`, `explore`, or `refuse` (uppercase gauntlet
names such as `EXECUTE` / `REFUSE_SAFETY` are accepted). `expectation.kind`
is used when `disposition` is omitted. `expectation.statuses` is a list of
acceptable refusal statuses. Optional `agent:` is an `auth.agents` id.
Optional `now:` is an ISO timestamp that pins relative periods.

A file may be a single scenario, a YAML list, or `{ scenarios: [...] }`.
