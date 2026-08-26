# First week on your own Postgres

This is the path from an empty directory to five governed metrics on **your**
warehouse. Postgres is the default. DuckDB is an optional extra, not the
starting point.

You will: create a read-only database user → `grane init` → `discover` →
define about five metrics → `validate`. Then connect an agent.

## 0. Install

```bash
npm install -g grane-analytics
# CLI command is still `grane`. Node 20+.
```

## 1. Read-only database user

Grane compiles SQL and wraps it in a `READ ONLY` transaction, but the warehouse
user is the real security boundary. Do not use a migration or superuser role.

```sql
CREATE ROLE grane_readonly LOGIN PASSWORD '...choose a secret...';
GRANT CONNECT ON DATABASE your_db TO grane_readonly;
GRANT USAGE ON SCHEMA public TO grane_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grane_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO grane_readonly;
```

```bash
export DATABASE_URL='postgres://grane_readonly:...@db.internal:5432/your_db'
```

## 2. Scaffold a project

```bash
mkdir analytics && cd analytics
grane init
```

`grane.yml` already points at Postgres via `${DATABASE_URL}`. Query audit is
on by default (`.grane/audit.jsonl`, gitignored).

## 3. Discover the schema

```bash
grane discover
grane discover --write-relationships   # merge inferred FKs; never overwrites existing keys
```

Use the table list to fill `entities:` in `grane.yml` (one entity per grain you
will count at — usually an order-like fact and a customer-like dimension).

`--write-relationships` creates or updates `relationships.yml` from foreign
keys. Keys and `from → to` pairs you already defined are left alone.

## 4. Define about five metrics

Start small. Open `metrics.yml` and `dimensions.yml`. A useful first week:

| Metric | Typical type | Why |
| --- | --- | --- |
| `revenue` | `sum` | The number leadership will ask for |
| `orders` | `count` | Denominator for rates |
| `customers` | `count` | Second grain, proves joins |
| `average_order_value` | `ratio` of revenue / orders | Compiler, not the agent, does the division |
| `refunded_amount` (or a second fact) | `sum` | Forces a join-safety check |

Rename tables and columns to match `grane discover`. The init file comments
show this set. Add two or three dimensions (`country`, `channel`, a status).

If the company already defines these in dbt, Cube, Looker, Ossie, or Malloy,
point `providers:` at that project instead of copying YAML. See
[providers.md](providers.md).

## 5. Validate

```bash
grane validate
```

Fix every `ERROR`. Live schema checks confirm `${table.column}` references
exist. Fan-out across `one_to_many` joins is either pre-aggregated or refused.

Then run one query yourself:

```bash
grane query revenue -d country --last 30d
```

The CLI prints a **trust headline** first. `trust: governed` means every field
came from an approved definition.

## 6. Connect an agent (local)

```bash
grane mcp doctor
grane mcp connect cursor    # also: claude, gemini, vscode, …
```

Desktop clients use **stdio**. Cursor should launch `grane serve --stdio`, not
an HTTP URL on `:8080`.

Full agent matrix: [connect-an-agent.md](connect-an-agent.md).

## 7. Production HTTP (when you leave the laptop)

Same project, in your VPC, behind TLS, with `auth.agents` bearer tokens. See
[production.md](production.md). Query audit stays on.

## DuckDB (optional)

Only if you want a file-backed warehouse without Postgres:

```bash
npm install @duckdb/node-api
# connection.type: duckdb and connection.path: ./warehouse.duckdb
```

The repo's `example/analytics-duckdb` is a demo shop, not the default install.
