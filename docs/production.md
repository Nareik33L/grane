# Production HTTP in your VPC

Grane is self-hosted. This page is the production path: a published Docker
image (or `docker run` from this repo), a read-only warehouse user, TLS in
front, and per-agent bearer tokens. There is no SSO and no hosted control plane.

Local desktop agents should keep using **stdio** (`grane mcp connect cursor`).
Use HTTP when an agent in another process or network needs MCP.

## Image

Pushes of `v*` tags publish to GitHub Container Registry:

```text
ghcr.io/nareik33l/grane:0.6.5
ghcr.io/nareik33l/grane:latest
```

Build locally if you prefer:

```bash
docker build -t grane .
```

The image expects your project at `/project` and listens on `0.0.0.0:8080`
so published ports work. The CLI itself defaults to `127.0.0.1`. Unauthenticated
HTTP on a non-loopback address is refused unless you pass `--allow-anonymous`
(the demo compose file does; this production path should set `auth.agents`
instead). `/health` is public. `/mcp` is the MCP endpoint.

## One-page `docker run`

```bash
export DATABASE_URL='postgres://grane_readonly:...@db.internal:5432/your_db'
export FINANCE_AGENT_TOKEN='...'      # matches auth.agents in grane.yml

docker run --rm \
  -p 8080:8080 \
  -e DATABASE_URL \
  -e FINANCE_AGENT_TOKEN \
  -e GRANE_AUDIT_PATH=/var/log/grane/audit.jsonl \
  -v /path/to/analytics:/project:ro \
  -v grane-audit:/var/log/grane \
  ghcr.io/nareik33l/grane:0.6.5
```

Or from this repo, against **your** warehouse (not the demo shop):

```bash
export DATABASE_URL='postgres://grane_readonly:...@db.internal:5432/your_db'
docker compose -f docker-compose.prod.yml up -d --build
```

The compose file mounts `./analytics` read-only and writes audit JSONL to a
named volume. The default `docker-compose.yml` is the self-contained demo.

## Read-only database user

Create a SELECT-only role (see [first-week.md](first-week.md)). Grane refuses
non-SELECT SQL on every warehouse. Postgres and Redshift also open a `READ ONLY`
transaction with a statement timeout; DuckDB files use `access_mode: READ_ONLY`;
MySQL sets `SESSION TRANSACTION READ ONLY`; ClickHouse sends `readonly=1`.
Leaked credentials should still be unable to write.

## Per-agent tokens (required on HTTP)

When `auth.agents` is non-empty, `/mcp` requires `Authorization: Bearer <token>`.
`/health` stays public for load balancers.

```yaml
# grane.yml
auth:
  agents:
    - id: finance
      token_sha256: ${FINANCE_AGENT_TOKEN_SHA256}   # printf '%s' "$TOKEN" | sha256sum
      metrics: [revenue, orders]
      dimensions: [country]
      exploration: false
    - id: analyst
      token: ${ANALYST_AGENT_TOKEN}                 # plaintext alternative; set exactly one
      # omit metrics/dimensions to grant the full governed catalog
      # exploration defaults to false; set true (and enable it globally) for raw columns
      # exploration_exclude: [customers.*]   # extra deny globs for this agent
```

`token_sha256` is a 64-character hex digest of the bearer token. The config
file then holds no secret even if it is committed. `token:` still works.
Each agent sets exactly one of the two.

stdio (Cursor, Claude Desktop launching `grane serve --stdio`) does not use
these tokens — the agent is a local child process.

There is no SSO, OIDC, or SAML in this release. Rotate tokens in the
environment and in `grane.yml`.

## Exploration allowlist

Default exploration is a **denylist**: every column except `exploration.exclude`.
Production HTTP should use **allowlist** mode so only named columns are
explorable. Wildcards work on `include`, `exclude`, and per-agent
`exploration_exclude`: `customers.*`, `*.email`, `*_ssn`.

```yaml
exploration:
  enabled: true
  mode: allowlist
  include:
    - orders.discount_code
    - payments.failure_code
  exclude:
    - "*.email"
    - "*_ssn"
```

An empty `include` list in allowlist mode permits nothing.

## TLS in front

Grane speaks plain HTTP. Put a reverse proxy on 443 in the same VPC (or on
Cloud Run / an internal ALB). ChatGPT and other web agents need a **public**
HTTPS URL; internal agents can stay on a private hostname.

Caddy example:

```caddy
analytics.example.com {
  reverse_proxy grane:8080
}
```

nginx example:

```nginx
server {
  listen 443 ssl;
  server_name analytics.example.com;
  ssl_certificate     /etc/ssl/certs/fullchain.pem;
  ssl_certificate_key /etc/ssl/private/privkey.pem;
  location / {
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    proxy_set_header X-Request-Id $http_x_request_id;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_pass http://grane:8080;
  }
}
```

Point the agent at `https://analytics.example.com/mcp`.

## HTTP perimeter

The MCP server is Node `http`, not a framework. Production-relevant defaults:

- Request bodies over **1 MiB** are rejected with `413`.
- `requestTimeout` / `headersTimeout` are set from `limits.timeout_ms`.
- In-flight `/mcp` requests are capped at `limits.max_concurrency` (default **2 × `connection.pool_size`**). Excess requests get **503** instead of queueing on a 5-connection warehouse pool. `/health` is not counted.
- Optional process-wide token bucket: `limits.rate_limit_rps`. When set, excess `/mcp` requests get **429**. Per-agent quotas are not in this release.
- `SIGTERM` / `SIGINT` stop accepting, drain in-flight requests, then `connector.close()`.
- Postgres and MySQL honour `connection.pool_size` (default 5). Raise it on a shared server.

```yaml
connection:
  pool_size: 16
limits:
  timeout_ms: 30000
  max_concurrency: 32
  rate_limit_rps: 20
```

## Audit log

Every `query` (and every `explain`/`query` refusal) appends one JSON line.
`kind: "query"` and `kind: "refusal"` always include the semantic `query`
object — that field is not optional on those lines.

HTTP-originated events (query, refusal, and auth denials) also carry
`request_id`, `client_ip`, and `user_agent`. `request_id` honours incoming
`X-Request-Id` when present, otherwise Grane generates one and echoes it on
the response. `client_ip` is the first `X-Forwarded-For` hop when the reverse
proxy sets that header, otherwise the TCP peer.

```json
{
  "ts": "2026-08-26T12:00:00.000Z",
  "kind": "query",
  "operation": "query",
  "agent": "finance",
  "trust": "governed",
  "query": { "metrics": ["revenue"], "dimensions": ["country"], "time": { "period": "last_month" } },
  "query_id": "q_1faea438cc34",
  "sql": "/* grane query_id=q_1faea438cc34 agent=finance */\nSELECT ...",
  "row_count": 12,
  "duration_ms": 18,
  "request_id": "req-from-proxy",
  "client_ip": "203.0.113.10",
  "user_agent": "Cursor/1.0"
}
```

Every compiled statement sent to the warehouse is prefixed with
`/* grane query_id=q_… agent=finance */` so `pg_stat_statements`, Snowflake
`QUERY_HISTORY`, BigQuery jobs, and the rest show the same ids without
reading this file. stdio / unbound agents use `agent=-`.

Refusals use `"kind": "refusal"` with `refusal.status` / `message` / `requested`.

When `auth.agents` is configured, a missing or invalid HTTP bearer token also
appends one line. Discriminate on `kind`: auth events have no `query` field
and never include the token.

```json
{
  "ts": "2026-09-03T00:00:00.000Z",
  "kind": "auth",
  "operation": "http",
  "agent": null,
  "reason": "missing",
  "request_id": "req-from-proxy",
  "client_ip": "203.0.113.10",
  "user_agent": "Cursor/1.0"
}
```

`reason` is `"missing"` (no token) or `"invalid"` (token did not match any
agent). Row payloads and agent tokens are never written. Compiled SQL uses
placeholders; bind values are not logged.

Defaults: `audit.enabled: true`, path `.grane/audit.jsonl`,
`audit.fail_closed: false` (a full disk does not take the query path down).
Set `audit.fail_closed: true` (or `GRANE_AUDIT_FAIL_CLOSED=1`) so a failed
append refuses the query with `config_error`. The warehouse statement may
already have run; the client does not receive those rows. On a read-only
project mount, set `GRANE_AUDIT_PATH` (or `audit.path`) to a writable volume.
`audit.stdout: true` (or `GRANE_AUDIT_STDOUT=1`) also writes JSON lines to
**stderr**, which Docker collects without corrupting MCP stdio.

## Health

`GET /health` returns `{ "status": "ok", "name": "grane", "version": "..." }`.
The image HEALTHCHECK hits that URL on port 8080.

## Production lint

`grane validate --production` and `grane doctor --production` fail the process
on fail-open production conditions:

- no `auth.agents` (unauthenticated HTTP)
- any agent with `exploration: true`
- `connection.ssl` on and `ssl_verify: false`
- `audit.path` not writable (or `audit.enabled: false`)
- `limits.max_rows` / `default_rows` / `timeout_ms` / `max_concurrency` above
  10000 / 1000 / 30000 / 32
- any metric with `status: experimental`

Equal to those ceilings is allowed. `grane validate --production` also prints a
one-line `WARNING` when `connection.type` is not `certified` (it does not fail
the process for that). `grane mcp doctor` is the MCP handshake check; this lint
is the hardening checklist.

## Adopter test suites

`grane test` runs YAML scenarios against your warehouse (query + expected
disposition / refusal status / gold value). Default files:
`grane-tests.yml` or `grane-tests/` in the project. See
[tests.md](tests.md).

## Supply chain

`v*` tags publish to GHCR with BuildKit provenance and an SBOM attached.
The image is built `FROM node:22-alpine` pinned by digest. Dependabot
updates npm, GitHub Actions, and that Docker digest weekly. Security
reports: [SECURITY.md](../SECURITY.md).
