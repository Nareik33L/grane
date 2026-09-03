# Production HTTP in your VPC

Grane is self-hosted. This page is the production path: a published Docker
image (or `docker run` from this repo), a read-only warehouse user, TLS in
front, and per-agent bearer tokens. There is no SSO and no hosted control plane.

Local desktop agents should keep using **stdio** (`grane mcp connect cursor`).
Use HTTP when an agent in another process or network needs MCP.

## Image

Pushes of `v*` tags publish to GitHub Container Registry:

```text
ghcr.io/nareik33l/grane:0.6.4
ghcr.io/nareik33l/grane:latest
```

Build locally if you prefer:

```bash
docker build -t grane .
```

The image expects your project at `/project` and listens on `8080`.
`/health` is public. `/mcp` is the MCP endpoint.

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
  ghcr.io/nareik33l/grane:0.6.4
```

Or from this repo, against **your** warehouse (not the demo shop):

```bash
export DATABASE_URL='postgres://grane_readonly:...@db.internal:5432/your_db'
docker compose -f docker-compose.prod.yml up -d --build
```

The compose file mounts `./analytics` read-only and writes audit JSONL to a
named volume. The default `docker-compose.yml` is the self-contained demo.

## Read-only database user

Create a SELECT-only role (see [first-week.md](first-week.md)). Grane also
refuses non-SELECT SQL and opens a `READ ONLY` transaction, but leaked
credentials should still be unable to write.

## Per-agent tokens (required on HTTP)

When `auth.agents` is non-empty, `/mcp` requires `Authorization: Bearer <token>`.
`/health` stays public for load balancers.

```yaml
# grane.yml
auth:
  agents:
    - id: finance
      token: ${FINANCE_AGENT_TOKEN}
      metrics: [revenue, orders]
      dimensions: [country]
      exploration: false
    - id: analyst
      token: ${ANALYST_AGENT_TOKEN}
      # omit metrics/dimensions to grant the full governed catalog
```

stdio (Cursor, Claude Desktop launching `grane serve --stdio`) does not use
these tokens — the agent is a local child process.

There is no SSO, OIDC, or SAML in this release. Rotate tokens in the
environment and in `grane.yml`.

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
    proxy_pass http://grane:8080;
  }
}
```

Point the agent at `https://analytics.example.com/mcp`.

## Audit log

Every `query` (and every `explain`/`query` refusal) appends one JSON line.
`kind: "query"` and `kind: "refusal"` always include the semantic `query`
object — that field is not optional on those lines.

```json
{
  "ts": "2026-08-26T12:00:00.000Z",
  "kind": "query",
  "operation": "query",
  "agent": "finance",
  "trust": "governed",
  "query": { "metrics": ["revenue"], "dimensions": ["country"], "time": { "period": "last_month" } },
  "query_id": "q_1faea438cc34",
  "sql": "SELECT ...",
  "row_count": 12,
  "duration_ms": 18
}
```

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
  "reason": "missing"
}
```

`reason` is `"missing"` (no token) or `"invalid"` (token did not match any
agent). Row payloads and agent tokens are never written. Compiled SQL uses
placeholders; bind values are not logged.

Defaults: `audit.enabled: true`, path `.grane/audit.jsonl`. On a read-only
project mount, set `GRANE_AUDIT_PATH` (or `audit.path`) to a writable volume.
`audit.stdout: true` (or `GRANE_AUDIT_STDOUT=1`) also writes JSON lines to
**stderr**, which Docker collects without corrupting MCP stdio.

## Health

`GET /health` returns `{ "status": "ok", "name": "grane", "version": "..." }`.
The image HEALTHCHECK hits that URL on port 8080.
