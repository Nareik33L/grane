# Security

## Reporting a vulnerability

Do not open a public GitHub issue for security reports.

Use GitHub's private vulnerability reporting on this repository:

https://github.com/Nareik33L/grane/security/advisories/new

Include the affected version (`grane-analytics` on npm, or the GHCR image tag),
a reproduction, and the impact.

We will acknowledge the report and work on a fix before any public disclosure.

## Scope

In scope: the Grane kernel, HTTP MCP server, Docker image, and first-party
GitHub Actions in this repository.

Out of scope: a warehouse role that is not read-only; production config that
leaves fail-open defaults in place (`auth.agents` empty, `--allow-anonymous`,
`ssl_verify: false`, `audit.fail_closed` unset). Run `grane doctor --production`
to lint those.
