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
`localhost` only works for clients on the same machine.

## Tools

| Tool | Input | Returns |
| --- | --- | --- |
| `catalog` | `{ search? }` | metrics, dimensions, entities, explorable columns, server capabilities |
| `query` | `{ query: QueryModelV1 }` | rows + `trust` (`governed` \| `mixed` \| `exploratory`) + provenance |
| `validate` | `{ query: QueryModelV1 }` | dry-run with SQL, or structured refusal |
| `explain` | `{ query: QueryModelV1 }` | definitions, trust, join plan, SQL (no execution) |

Query Model v1 accepts governed `metrics` / `dimensions` and, when exploration
is enabled, `raw_dimensions` (`table.column`) and `raw_metrics`
(`{ field, type, alias? }`). Grane compiles the SQL either way. Do not present
`trust: mixed` or `trust: exploratory` results as approved business truth.

## Example database

```bash
docker compose -f example/docker-compose.yml up -d --wait
grane -p example/analytics serve
```

Then connect your agent and ask: *"What was revenue by country last month?"*
