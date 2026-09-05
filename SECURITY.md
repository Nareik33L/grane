# Security

Grane is an early 0.x public alpha. Please report vulnerabilities so they can be fixed before they are widely known.

## Reporting

This repository does **not** currently enable GitHub private vulnerability reporting, and there is no dedicated security mailbox.

Do **not** open a public issue that includes a working exploit, credentials, connection strings, or customer data.

Instead:

1. Open a GitHub issue titled `Security report` with a short non-technical summary (affected version, impact class) and a way to reach you.
2. Wait for a maintainer to reply before sharing reproduction details.

If private vulnerability reporting is later enabled on the repository, use that form instead of a public issue.

Issues: https://github.com/Nareik33L/grane/issues

## Supported versions

Fixes target the current published 0.x release and the default branch. Older 0.x versions are not separately maintained.

## Useful reports

- Grane version (`grane --version`) and how it was installed (`npx`, global, or a clone)
- Warehouse type (omit secrets, URLs with passwords, and tokens)
- Steps to reproduce
- Observed vs expected behaviour
- Whether the issue bypasses a refusal, leaks data, or is reachable without intended credentials
