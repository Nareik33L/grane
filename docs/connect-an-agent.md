# Connect an AI agent to Grane

Grane is the analytics runtime between **your AI agent** and **your warehouse**.
This guide is client-agnostic: it applies to ChatGPT, Claude, Gemini, Cursor,
or any MCP-compatible agent.

## Who needs what keys?

```text
YOU (the human)
  |
  |  Your ChatGPT / Claude / Gemini subscription or API key
  v
AI AGENT  ──reasoning, chat, presentation──►  uses YOUR keys
  |
  |  MCP (no LLM key required on this hop)
  v
GRANE  ──metrics, validation, SQL compilation──►  no OpenAI/Anthropic/Google key
  |
  |  SQL (read-only)
  v
YOUR POSTGRES  ──your data──►  DATABASE_URL / read-only DB user
```

| Component | Needs an LLM API key? | What it needs |
| --- | --- | --- |
| ChatGPT, Claude, Gemini, Cursor | **Yes** — your account or API key | Normal sign-in / API billing on the agent side |
| Grane | **No** | A read-only warehouse connection and semantic definitions — your existing dbt / Cube / LookML / Malloy / Ossie project, or Grane YAML |
| Your database | **No** | A read-only Postgres user Grane can query |

Grane never calls OpenAI, Anthropic, or Google. You pay for inference on the
agent; you pay for warehouse compute on your database. Grane itself is just
deterministic infrastructure in the middle.

---

## Fast path

**First time?** Run the bundled shop, then connect a local desktop client:

```bash
npx grane-analytics demo
npx grane-analytics -p demo/analytics mcp connect cursor
```

Ask: *Why did revenue fall last month?* Script: [demo/README.md](../demo/README.md).
ChatGPT (HTTPS only) is not this path.

After `grane validate` succeeds on your own project, register Grane with
whichever MCP client you use. The command is the same shape for every agent;
only the last-mile config file (or UI) changes.

```bash
grane mcp doctor                 # project + optional MCP handshake
grane mcp clients                # claude, cursor, gemini, vscode, chatgpt, …
grane mcp connect claude         # or cursor, gemini, vscode, chatgpt, windsurf, claude-code
```

| Command | What it does |
| --- | --- |
| `grane mcp connect <client>` | Merge a Grane server entry into that client's config (stdio by default for desktop/CLI agents) |
| `grane mcp print-config <client>` | Print the JSON snippet without writing |
| `grane mcp list` | Show Grane entries across known client config files |
| `grane mcp remove <client>` | Remove the Grane entry |
| `grane mcp doctor` | Validate the project and probe MCP |

Useful flags: `--transport http --url https://your-host/mcp`, `--global` (user
config instead of project), `--dry-run`, `--no-env`, `--command grane`.

ChatGPT has no config file — `grane mcp connect chatgpt` prints the HTTPS
connector steps. Manual JSON for every client is still below if you prefer
to edit files yourself.

---

## Before you connect any agent

Do these three steps once, regardless of which chat product you use.

### 1. Install Grane

```bash
npm install -g grane-analytics
# or from a clone: npm install && npm run build
# try the bundled shop first: npx grane-analytics demo
```

The CLI command is `grane`. Node 20+. Or run the published Docker image if
you prefer containers.

### 2. Point Grane at your database

Create a Grane project (`grane init`) or use the demo shop under `demo/analytics/`.

In `grane.yml`:

```yaml
connection:
  type: postgres
  url: ${DATABASE_URL}          # postgres://readonly:...@host:5432/yourdb
  schema: public
```

Use a **read-only** database user. Grane also wraps every query in a
`READ ONLY` transaction, but the database remains the final security boundary.

Define your metrics in `metrics.yml`, dimensions in `dimensions.yml`, and
relationships in `relationships.yml` — or, if the company already defines them
in dbt, Cube, LookML, Malloy, or Ossie, point `providers:` at that project
instead ([providers.md](providers.md)). Then:

```bash
grane validate
grane query revenue --dimension country --last 30d   # sanity check from CLI
```

If the CLI query works, Grane and the database are wired correctly. Connecting
an agent is the next step:

```bash
grane mcp doctor
grane mcp connect <client>    # claude, cursor, gemini, vscode, chatgpt, …
```

### 3. Expose Grane over MCP

Prefer `grane mcp connect <client>` (see **Fast path**). Grane speaks MCP in
two transports:

| Transport | Best for | How |
| --- | --- | --- |
| **stdio** | Desktop apps that launch local servers (Claude Desktop, Cursor, Gemini CLI) | Agent runs `grane serve --stdio` as a child process |
| **Streamable HTTP** | Remote agents, ChatGPT, shared/team deployments | Run `grane serve` and connect to `https://your-host/mcp` |

**Local HTTP (development):**

```bash
grane serve
# MCP endpoint: http://localhost:8080/mcp
# Health check: http://localhost:8080/health
```

**Production HTTP:** deploy Grane in your VPC behind HTTPS. Use the published
image `ghcr.io/nareik33l/grane`, a read-only database user, and
`auth.agents` bearer tokens. ChatGPT and most web agents require a **public
HTTPS URL**. Step-by-step: **[production.md](production.md)**.

Local desktop clients should keep **stdio** (`grane mcp connect cursor`).

---

## Connect Claude

Claude is available as **Claude Desktop** (app) and **Claude on the web**. MCP
setup differs slightly.

### Claude Desktop — local (stdio, recommended for self-hosted Grane)

1. Open **Settings → Developer → Edit Config** (creates/opens the config file).
2. Add Grane under `mcpServers`:

```json
{
  "mcpServers": {
    "grane": {
      "command": "grane",
      "args": [
        "-p", "/path/to/your/analytics",
        "serve", "--stdio"
      ],
      "env": {
        "DATABASE_URL": "postgres://readonly:...@localhost:5432/yourdb"
      }
    }
  }
}
```

Use the full path to `grane` (or `node /path/to/grane/dist/cli/index.js`) if
`grane` is not on your PATH. Set `DATABASE_URL` unless it is already in
`grane.yml`.

3. **Fully quit and restart** Claude Desktop (config loads at startup).
4. Start a new chat. You should see Grane tools (`catalog`, `query`, `validate`,
   `explain`) available.

Config file locations:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

### Claude Desktop — remote HTTP server

If Grane runs on a server with HTTPS:

1. **Settings → Connectors → Add custom connector**
2. Enter your MCP URL, e.g. `https://grane.yourcompany.com/mcp`
3. Complete OAuth or token auth if you have protected the endpoint

### Using Claude

Ask in natural language, for example:

> Why did revenue fall last month?
> What metrics are defined in Grane?
> What was revenue by country last month?

Claude calls `catalog()` to discover approved metrics (and explorable columns
when exploration is enabled), then `query()` with a semantic request. Results
include a `trust` level (`governed`, `mixed`, or `exploratory`) and provenance.

---

## Connect ChatGPT

ChatGPT connects to MCP servers as **custom connectors** over **HTTPS only**.
It cannot launch a local stdio process the way Claude Desktop or Cursor can.

**Requirements (as of 2026):**

- A paid ChatGPT plan (Plus, Pro, Business, Enterprise, or Edu)
- **Developer Mode** enabled in Settings
- Grane reachable at a **public HTTPS URL** (e.g. deployed in your cloud, or
  exposed temporarily via a secure tunnel for testing)

### Steps

1. Deploy Grane with HTTP transport:

   ```bash
   grane serve --port 8080
   ```

   Put it behind HTTPS (load balancer, Cloud Run, Fly.io, etc.). The MCP
   endpoint must be `https://your-host/mcp`.

2. In ChatGPT: **Settings → Apps & Connectors** (or **Connectors**), enable
   **Developer Mode** if prompted.

3. **Create** a new connector:

   | Field | Value |
   | --- | --- |
   | Name | Grane |
   | URL | `https://your-host/mcp` |
   | Authentication | None, OAuth, or Bearer token — however you secured Grane |

4. Enable the connector in a chat.

5. Ask analytical questions. ChatGPT discovers Grane's four tools and calls
   them instead of writing raw SQL.

**Local development:** ChatGPT on the public internet cannot hit
`http://localhost:8080`. For a quick test you must either deploy Grane
somewhere reachable, or use a tunnel to your machine. For day-to-day self-hosted
use, Claude Desktop (stdio) or Gemini CLI is often simpler than ChatGPT.

---

## Connect Gemini

"Gemini" can mean the **Gemini web app**, **Gemini CLI**, or **API-based
agents**. For self-hosted Grane, **Gemini CLI** is the most direct MCP client
today.

### Gemini CLI (stdio or HTTP)

1. Install [Gemini CLI](https://github.com/google-gemini/gemini-cli) and sign in
   with your Google account (your Gemini/API billing applies here, not in Grane).

2. Add Grane to `~/.gemini/settings.json` (global) or `.gemini/settings.json`
   (project):

**Local stdio:**

```json
{
  "mcpServers": {
    "grane": {
      "command": "grane",
      "args": [
        "-p", "/path/to/your/analytics",
        "serve", "--stdio"
      ],
      "env": {
        "DATABASE_URL": "postgres://readonly:...@localhost:5432/yourdb"
      }
    }
  }
}
```

**Remote HTTP:**

```json
{
  "mcpServers": {
    "grane": {
      "httpUrl": "https://grane.yourcompany.com/mcp"
    }
  }
}
```

Or use the CLI helper:

```bash
gemini mcp add grane --transport stdio -- grane -p /path/to/analytics serve --stdio
gemini mcp list
```

3. Restart Gemini CLI and run `/mcp list` to confirm Grane is connected.

4. Ask: *"Use Grane to show revenue by country for last month."*

### Gemini web / other Google surfaces

Google publishes many **Google-managed** MCP servers for GCP products. Connecting
a **custom self-hosted** server like Grane to the consumer Gemini web UI follows
the same pattern as other remote MCP clients: you need a **remote HTTPS MCP
endpoint** and a product that supports custom MCP connectors. When in doubt, use
Gemini CLI or the Gemini API with an MCP-capable agent framework.

---

## Connect Cursor (and other MCP IDEs)

Cursor, VS Code MCP extensions, and similar tools use the same pattern as
Claude Desktop.

**stdio** — in `~/.cursor/mcp.json` or `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "grane": {
      "command": "grane",
      "args": ["-p", "/path/to/analytics", "serve", "--stdio"],
      "env": { "DATABASE_URL": "postgres://..." }
    }
  }
}
```

**HTTP** — if Grane is already running:

```json
{
  "mcpServers": {
    "grane": {
      "url": "http://localhost:8080/mcp"
    }
  }
}
```

Reload MCP in settings, then start a **new chat** so the agent picks up the
tools.

---

## What the agent can do once connected

| Tool | What it does |
| --- | --- |
| `catalog` | List approved metrics, dimensions, entities, synonyms |
| `query` | Run a governed query; Grane compiles SQL and returns data + provenance |
| `validate` | Dry-run a query without executing it |
| `explain` | Show definitions, join plan, and generated SQL |

Agents should **not write SQL** for company metrics. They send semantic intent;
Grane enforces definitions and join safety.

Example query payload the agent sends:

```json
{
  "metrics": ["revenue"],
  "dimensions": ["country"],
  "time": { "from": "2026-07-01", "to": "2026-07-31" }
}
```

Example provenance in the response:

```json
{
  "trust": "governed",
  "query_id": "q_abc123",
  "metrics": { "revenue": { "definition_version": "a82cf1d3" } },
  "generated_sql": "SELECT ..."
}
```

---

## Troubleshooting

| Problem | Likely cause | Fix |
| --- | --- | --- |
| Agent says "can't connect" | Grane not running (HTTP mode) | Run `grane serve` or use stdio so the agent starts Grane |
| `EADDRINUSE :8080` | Server already running | Use the existing server, or `grane serve --port 8081` |
| ChatGPT can't connect | localhost or HTTP-only URL | Deploy Grane with public **HTTPS** |
| Tools don't appear | Config not reloaded | Restart the agent app; open a **new chat** |
| Query fails | Database not reachable | Check `DATABASE_URL`, run `grane validate` |
| "undefined_metric" | Not defined, or defined upstream (dbt/Cube/…) but skipped at load | Check `catalog()` `warnings` or `grane validate`; define it in `metrics.yml` if it is genuinely missing |

---

## Quick reference: which setup should I use?

| You use… | Grane transport | Grane runs where… |
| --- | --- | --- |
| Claude Desktop (local) | stdio | Launched by Claude on your machine |
| Cursor (local) | stdio or local HTTP | Launched by Cursor, or you run `grane serve` |
| Gemini CLI | stdio or HTTP | Launched by Gemini CLI, or remote URL |
| ChatGPT (web) | HTTPS only | Your server / cloud (public URL) |
| Team / production | HTTPS | Docker / K8s / Cloud Run in your VPC |

**The pattern is always the same:** your agent (with your keys) → MCP → Grane
(no LLM keys) → read-only Postgres (your data).
