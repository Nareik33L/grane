# Set up Grane example transcript (V2-18)

Spoken lines below are **abridged**. Tool request/response payloads are **real**
output from the nine authoring tools against the unit-test shop schema
(`orders.net_amount` / `orders.gross_amount`). Session ids in JSON are
replaced with `<session>`.

---

**Agent:** What metrics are important to you?

**User:** Revenue — completed orders.

**Agent:** I see two amount columns on orders. Which one is governed revenue?

1. `orders.net_amount`
2. `orders.gross_amount`

Also: do you want refunds taken out of revenue?

**User:** 1 — net amount, refunds already out.

**Agent:** Playing back the proposal (must match `propose_definitions` exactly):

```
revenue: table/column ${orders.net_amount}; calculation sum; filters none; grain orders
```

These stay experimental until a pull request is merged. They are not live.

---

### authoring_start (real)

```json
{
  "session": {
    "version": 1,
    "id": "<session>",
    "created_at": "2026-10-15T09:59:20.044Z",
    "updated_at": "2026-10-15T09:59:20.044Z",
    "warehouse_ref": {
      "type": "postgres",
      "locator": "postgres"
    },
    "discovered_snapshot_hash": null,
    "glossary_answers": [],
    "open_ambiguities": [],
    "resolved_ambiguities": [],
    "draft_yaml": {}
  }
}
```

### discover_schema (real)

```json
{
  "schema": {
    "schemaName": "public",
    "tables": [
      {
        "schema": "public",
        "name": "orders",
        "columns": [
          {
            "name": "id",
            "dataType": "integer",
            "nullable": false
          },
          {
            "name": "net_amount",
            "dataType": "numeric",
            "nullable": true
          },
          {
            "name": "gross_amount",
            "dataType": "numeric",
            "nullable": true
          },
          {
            "name": "completed_at",
            "dataType": "timestamp",
            "nullable": true
          }
        ]
      }
    ]
  }
}
```

### profile_column (abridged — samples omitted; counts from a real run)

```json
{
  "table": "orders",
  "column": "net_amount",
  "distinct_count": 2,
  "samples_omitted": true
}
```

### record_term (real)

```json
{
  "term": "revenue",
  "answer": "Completed order revenue.",
  "glossary_answers": [
    {
      "term": "revenue",
      "answer": "Completed order revenue."
    }
  ]
}
```

### list_ambiguities (real, before the user picked)

```json
[
  {
    "id": "amb-revenue-like-orders",
    "kind": "revenue_like_columns",
    "candidates": [
      "orders.net_amount",
      "orders.gross_amount"
    ],
    "question": "Which column on \"orders\" is governed revenue? Grane will not guess. Candidates are column names only."
  }
]
```

### propose_definitions (real)

playback:

```
revenue: table/column ${orders.net_amount}; calculation sum; filters none; grain orders
```

metrics.yml:

```yaml
metrics:
  revenue:
    entity: orders
    type: sum
    sql: ${orders.net_amount}
    status: experimental
    time_dimension: ${orders.completed_at}
    description: Completed order revenue.

```

unresolved: false

### preview_yaml (real)

validation.ok: true
unresolved: false

### submit_proposal (real)

```json
{
  "proposal": {
    "branch": "grane/proposal/20261015-completed-order-revenue",
    "id": "20261015-completed-order-revenue"
  },
  "github": {
    "command": "gh pr create --base main --head grane/proposal/20261015-completed-order-revenue --title \"Grane proposal: 20261015-completed-order-revenue\" --body \"Proposal `20261015-completed-order-revenue` on `grane/proposal/20261015-completed-order-revenue`.\\n\\nApproval is merging this GitHub PR. Anyone with merge rights on the repository can merge it.\\nAI-generated metrics in this PR are **experimental** until merge; the merge marks them **governed**.\\n\\nGrane-Proposal: 20261015-completed-order-revenue\\nGrane-Base: main\\nGrane-Base-Commit: ab3edab085891b5da96874188a19d6112102f1d2\""
  }
}
```

**Agent:** A teammate with merge rights should review the pull request. Until it
merges, the new metrics stay experimental. I will not approve, pin, skip
review, or say they are live.
