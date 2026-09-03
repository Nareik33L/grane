# MCP tool reference

Grane exposes four MCP tools. For the full agent connection guide (ChatGPT,
Claude, Gemini, database setup, HTTPS vs stdio), see
[connect-an-agent.md](connect-an-agent.md).

## Connect from the CLI

```bash
grane mcp doctor
grane mcp connect claude     # also: cursor, gemini, vscode, chatgpt, windsurf, claude-code
grane mcp print-config cursor
grane mcp list
```

`connect` merges a Grane server entry into the client's config file (Claude
Desktop, Cursor, Gemini CLI, VS Code, Windsurf, Claude Code, or a generic
`.mcp.json`). ChatGPT has no file — the command prints HTTPS connector steps.

## Transports

- **stdio** — `grane serve --stdio` (agent launches Grane as a subprocess)
- **Streamable HTTP** — `grane serve` → `http://host:8080/mcp`

## Config patterns

Replace `/path/to/analytics` with your Grane project directory (contains
`grane.yml`). Set `DATABASE_URL` in `env` unless already in `grane.yml`.

### stdio (Claude Desktop, Cursor, Gemini CLI)

```json
{
  "mcpServers": {
    "grane": {
      "command": "grane",
      "args": ["-p", "/path/to/analytics", "serve", "--stdio"],
      "env": {
        "DATABASE_URL": "postgres://readonly:...@host:5432/db"
      }
    }
  }
}
```

Config file locations:

| Client | Config file |
| --- | --- |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) |
| Cursor | `~/.cursor/mcp.json` or `.cursor/mcp.json` |
| Gemini CLI | `~/.gemini/settings.json` |

### HTTP (running server, ChatGPT, remote agents)

```json
{
  "mcpServers": {
    "grane": {
      "url": "https://grane.yourcompany.com/mcp"
    }
  }
}
```

ChatGPT requires a **public HTTPS URL** and Developer Mode (paid plan). Local
`localhost` only works for clients on the same machine. VPC / Docker / TLS /
agent tokens: [production.md](production.md).

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `catalog` | `{ search? }` | metrics, dimensions, entities, explorable columns, server capabilities, `warnings` (upstream definitions Grane could not import; empty for allow-listed agents) |
| `query` | `{ query: QueryModelV1 }` | trust headline, then rows + `trust` + provenance |
| `validate` | `{ query: QueryModelV1 }` | dry-run with trust headline and SQL, or structured refusal |
| `explain` | `{ query: QueryModelV1 }` | trust headline, definitions, join plan, SQL (no execution) |

Query Model v1 accepts governed `metrics` / `dimensions` and, when exploration
is enabled, `raw_dimensions` (`table.column`) and `raw_metrics`
(`{ field, type, alias? }`). Relative windows use `time.period` (`last_month`,
`30d`, `this_year`, …) resolved in the project timezone; `from`/`to` still work.
Grane compiles the SQL either way. Do not present `trust: mixed` or
`trust: exploratory` results as approved business truth. Agents must open the
reply with the trust headline and put it in any chart title.

## Per-agent HTTP auth

When `auth.agents` is set in `grane.yml`, `/mcp` requires
`Authorization: Bearer <token>`. `/health` stays public. stdio is local-process
trusted and does not require a bearer token.

```yaml
auth:
  agents:
    - id: finance
      token: ${FINANCE_AGENT_TOKEN}
      metrics: [revenue, orders]
      exploration: false
    - id: analyst
      token: ${ANALYST_AGENT_TOKEN}
```

Omit `metrics` / `dimensions` to grant the full governed catalog. Allow-lists
apply to the catalog (including each metric's `available_dimensions`), grouping
dimensions, governed filters, and `time.dimension`. Unknown names suggest only
granted fields. An agent's `exploration: false` cannot turn exploration on if
it is globally disabled.

Queries, refusals, and HTTP authentication denials are appended to
`.grane/audit.jsonl` (see [production.md](production.md#audit-log)).

## Example database

```bash
npx grane-analytics demo
grane -p demo/analytics mcp connect cursor
```

Ask: *"Why did revenue fall last month?"* See [demo/README.md](../demo/README.md).

Postgres (optional):

```bash
docker compose up -d postgres --wait
npx grane-analytics demo --postgres
```
