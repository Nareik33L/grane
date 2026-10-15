# Set up Grane example transcript (V2-18)

Spoken lines below are **abridged**. Tool request/response payloads are **verbatim**
output from the authoring tools against the unit-test shop schema
(`orders.net_amount` / `invoices.gross_amount`). Session ids are replaced
with `<session>` and SHA-256 snapshot hashes with `<hash>`. This setup
does not enable exploration, so `profile_column` returns `exploration_disabled`.

---

**Agent:** What metrics are important to you?

**User:** Revenue — completed orders.

**Agent:** I see two amount columns. Which one is governed revenue?

1. `orders.net_amount`
2. `invoices.gross_amount`

Also: do you want refunds taken out of revenue?

**User:** 1 — net amount, refunds already out.

**Agent:** Playing back the proposal (must match `propose_definitions` exactly):

```
revenue: table/column ${orders.net_amount}; calculation sum; filters none; grain orders; description Completed order revenue.
```

These stay experimental until a pull request is merged. They are not live.

---

### authoring_start (verbatim)

```json
{
  "session": {
    "version": 1,
    "id": "<session>",
    "created_at": "2026-10-15T10:18:14.094Z",
    "updated_at": "2026-10-15T10:18:14.094Z",
    "warehouse_ref": {
      "type": "postgres",
      "locator": "postgres"
    },
    "discovered_snapshot_hash": null,
    "glossary_answers": [],
    "open_ambiguities": [],
    "resolved_ambiguities": [],
    "draft_yaml": {},
    "draft_source_hash": null
  }
}
```

### discover_schema (verbatim)

```json
{
  "session_id": "<session>",
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
            "name": "created_at",
            "dataType": "timestamp",
            "nullable": true
          },
          {
            "name": "completed_at",
            "dataType": "timestamp",
            "nullable": true
          }
        ]
      },
      {
        "schema": "public",
        "name": "invoices",
        "columns": [
          {
            "name": "id",
            "dataType": "integer",
            "nullable": false
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
  },
  "relationships": {},
  "snapshot_hash": "<hash>",
  "open_ambiguities": [
    {
      "id": "amb-revenue-like",
      "kind": "revenue_like_columns",
      "question": "Which column is governed revenue? Several tables have a single revenue-like column. Grane will not guess.",
      "candidates": [
        "invoices.gross_amount",
        "orders.net_amount"
      ]
    },
    {
      "id": "amb-date-orders",
      "kind": "date_columns",
      "question": "Which column on \"orders\" is the time dimension for this entity? Several date/time columns exist. Grane will not pick one.",
      "candidates": [
        "orders.created_at",
        "orders.completed_at"
      ]
    }
  ]
}
```

### profile_column (verbatim)

```json
{
  "status": "exploration_disabled",
  "message": "Raw warehouse field \"orders.net_amount\" was requested, but exploration is disabled. Enable exploration in grane.yml, or use a governed metric or dimension.",
  "requested": "orders.net_amount"
}
```

### record_term (verbatim)

```json
{
  "version": 1,
  "id": "<session>",
  "created_at": "2026-10-15T10:18:14.094Z",
  "updated_at": "2026-10-15T10:18:14.103Z",
  "warehouse_ref": {
    "type": "postgres",
    "locator": "postgres"
  },
  "discovered_snapshot_hash": "<hash>",
  "glossary_answers": [
    {
      "term": "revenue",
      "answer": "Completed order revenue."
    }
  ],
  "open_ambiguities": [
    {
      "id": "amb-revenue-like",
      "kind": "revenue_like_columns",
      "question": "Which column is governed revenue? Several tables have a single revenue-like column. Grane will not guess.",
      "candidates": [
        "invoices.gross_amount",
        "orders.net_amount"
      ]
    },
    {
      "id": "amb-date-orders",
      "kind": "date_columns",
      "question": "Which column on \"orders\" is the time dimension for this entity? Several date/time columns exist. Grane will not pick one.",
      "candidates": [
        "orders.created_at",
        "orders.completed_at"
      ]
    }
  ],
  "resolved_ambiguities": [],
  "draft_yaml": {},
  "draft_source_hash": null
}
```

### list_ambiguities (verbatim, before the user picked)

```json
[
  {
    "id": "amb-revenue-like",
    "kind": "revenue_like_columns",
    "question": "Which column is governed revenue? Several tables have a single revenue-like column. Grane will not guess.",
    "candidates": [
      "invoices.gross_amount",
      "orders.net_amount"
    ]
  },
  {
    "id": "amb-date-orders",
    "kind": "date_columns",
    "question": "Which column on \"orders\" is the time dimension for this entity? Several date/time columns exist. Grane will not pick one.",
    "candidates": [
      "orders.created_at",
      "orders.completed_at"
    ]
  }
]
```

### propose_definitions (verbatim playback + metrics.yml)

playback:

```
revenue: table/column ${orders.net_amount}; calculation sum; filters none; grain orders; description Completed order revenue.
```

metrics.yml:

```yaml
metrics:
  revenue:
    entity: orders
    type: sum
    sql: ${orders.net_amount}
    status: experimental
    time_dimension: ${orders.created_at}
    description: Completed order revenue.

```

unresolved: false

### preview_yaml (trimmed — validation flags only)

validation.ok: true
unresolved: false

### submit_proposal (verbatim)

```json
{
  "proposal": {
    "id": "20261015-completed-order-revenue",
    "branch": "grane/proposal/20261015-completed-order-revenue",
    "commit": "1b2f99b6653ee88c3e2dbe910763e7fefa8b2a76",
    "base_branch": "main",
    "base_commit": "f8c0284ce1c8bc81583ae06a9c35ae92877587df",
    "title": "Grane authoring proposal from session <session>"
  },
  "github": {
    "title": "Grane proposal: 20261015-completed-order-revenue",
    "body": "Proposal `20261015-completed-order-revenue` on `grane/proposal/20261015-completed-order-revenue`.\n\nApproval is merging this GitHub PR. Anyone with merge rights on the repository can merge it.\nAI-generated metrics in this PR are **experimental** until merge; the merge marks them **governed**.\n\nGrane-Proposal: 20261015-completed-order-revenue\nGrane-Base: main\nGrane-Base-Commit: f8c0284ce1c8bc81583ae06a9c35ae92877587df",
    "head": "grane/proposal/20261015-completed-order-revenue",
    "base": "main",
    "repo": null,
    "command": "gh pr create --base main --head grane/proposal/20261015-completed-order-revenue --title \"Grane proposal: 20261015-completed-order-revenue\" --body \"Proposal `20261015-completed-order-revenue` on `grane/proposal/20261015-completed-order-revenue`.\\n\\nApproval is merging this GitHub PR. Anyone with merge rights on the repository can merge it.\\nAI-generated metrics in this PR are **experimental** until merge; the merge marks them **governed**.\\n\\nGrane-Proposal: 20261015-completed-order-revenue\\nGrane-Base: main\\nGrane-Base-Commit: f8c0284ce1c8bc81583ae06a9c35ae92877587df\""
  }
}
```

**Agent:** A teammate with merge rights should review the pull request. Until it
merges, the new metrics stay experimental. I will not approve, pin, skip
review, or say they are live.
