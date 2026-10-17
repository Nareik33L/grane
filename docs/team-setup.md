# Team setup

How a team shares one Grane project: one GitHub repo, branch protection that
**GitHub** enforces, each person with their own read-only warehouse access,
then the approve / pull flow.

Grane does **not** change branch protection on any repository. `grane doctor`
and `grane setup` only **GET** the GitHub API (classic protection + rulesets).
They never PUT, PATCH, POST, or DELETE settings.

## 1. Create the shared repo

1. Create an empty GitHub repository (default branch `main`). This is the
   **customer's** analytics repo — not the Grane product repo.
2. Push the project YAML (`grane.yml`, `metrics.yml`, `dimensions.yml`,
   `relationships.yml`) and, after the first approval, `grane.pin.json`.
3. Set `origin` to that repo. `grane doctor` / `grane setup` read
   `git remote get-url origin` and check **that** repository.

## 2. Turn on branch protection

On the default branch (usually `main`), enable **all** of the following.
Rulesets or classic protection both count; `grane doctor` reads both.

| Enable | Why |
| --- | --- |
| **PR required with >=1 approval** | A human review before merge |
| **CODEOWNERS review for metric YAML and grane.pin.json** | Metric definitions and the pin need a named owner |
| **dismiss stale approvals** | A later push drops the old approve |
| **require approval of most recent push** | The tip of the PR is what was reviewed |
| **required status checks** | CI must pass |
| **branch up to date** | The PR is current with the base |
| **no force-push/deletion** | History on the base cannot be rewritten or removed |
| **no bypass** | Admins and ruleset bypass actors cannot skip the rules |

Example `CODEOWNERS` (path is `.github/CODEOWNERS` or `CODEOWNERS`):

```
# Metric YAML and the shared pin — require a review from the analytics owners.
grane.yml @your-org/analytics
metrics.yml @your-org/analytics
dimensions.yml @your-org/analytics
relationships.yml @your-org/analytics
*.yml @your-org/analytics
grane.pin.json @your-org/analytics
```

`grane doctor` can see that CODEOWNERS **reviews** are required. It does not
read the CODEOWNERS file itself, so put the paths above in GitHub — Grane
will not invent that coverage.

`grane doctor` and `grane setup` warn once per missing setting with exactly
what to enable. They never turn the settings on.

If there is no token (`GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`), a
403, a 404, a network error, `--offline`, a non-GitHub remote, a partial
ruleset (list without readable details), unknown bypass actors, or any
setting the GitHub API did not actually return, the check reports
**couldn't verify** or **missing** — never that the branch is protected.
`ok` means the API returned every required setting as on. The doctor exit
code still follows production lint, not this check.

## 3. Invite people

Add collaborators under **Settings → Collaborators**.

- Approvers need **Write** and permission to merge.
- Verifiers need at least **Read** (Write if they also open PRs).

Do not share warehouse passwords or agent tokens through the repo.

## 4. Each person connects their own read-only data access

Everyone clones the shared repo. Each person sets **their own** read-only
warehouse credentials (`DATABASE_URL` or `connection.url` in a local env —
not committed). That role is the real data-access control. See
[first-week.md](first-week.md) and [production.md](production.md).

Then:

```bash
grane validate
grane doctor          # production lint + pin health + read-only protection check
grane mcp connect cursor
```

## 5. Approve / pull flow

Authoring only opens a proposal PR. A human merges it. `grane proposals approve`
pins the merged commit on a `grane/pin/*` branch and prints `gh pr create` —
it does not merge or push `main`. A human merges the pin PR. Everyone else
`git pull` and runs `grane doctor --json` / `grane serve`.

The two-person evidence run is [two-person-test.md](two-person-test.md).

## 6. Org-wide rollout (shared MCP config, no secrets)

The AI client's MCP config (the `grane` command plus warehouse **host / port /
database / user**) can be the same for everyone. Distribute it with MDM, a
dotfiles repo, or a committed template (for Cursor: `~/.cursor/mcp.json` or
`.cursor/mcp.json`). Generate a secret-free snippet with
`grane mcp print-config cursor --no-env --command grane` so a live DSN is
not copied out of the operator's shell.

**That shared file must contain no secrets.** Each person's read-only
password or key stays on their machine. Grane does **not** parse the MCP
JSON; the client launches `grane` and copies `env` onto the process. Grane
then expands `${VAR}` in `grane.yml` `connection.*` only (not metric SQL
or other keys). Expansion is a single pass: a substituted value that
itself contains `${…}` is not expanded again, and **env values are never
treated as templates**.

Encoding is one predictable rule, never a guess about “already encoded”:

- `${VAR}` fragments that sit in a **YAML URL's userinfo** (the
  `user:password` before `@`) are always `encodeURIComponent`'d from the
  raw env/default bytes. A password `100%40off` becomes `100%2540off`;
  `p%40ss` becomes `p%2540ss`. Grane does not decode first.
- A **complete DSN** substituted for `url: ${DATABASE_URL}` is the
  opt-out: inserted as-is, so an already-encoded password in that DSN is
  not encoded again.

If you previously pre-encoded passwords in a YAML URL template, store
the raw value instead, or move to `url: ${DATABASE_URL}` with a fully
encoded DSN.

Unset `${VAR}` is left in the loaded config so `grane validate --offline`,
`grane doctor --json`, and `grane mcp doctor` can run. Connecting (or any
live warehouse path) refuses with an error that names only that variable.

Put the URL **template in YAML**, not in MCP `env`. Committed `grane.yml`:

```yaml
connection:
  type: postgres
  url: postgres://grane_ro:${GRANE_DB_PASSWORD}@warehouse.example.com:5432/analytics
```

Shared MCP config — command and args only; no DSN, no password:

```json
{
  "mcpServers": {
    "grane": {
      "command": "grane",
      "args": ["-p", "/opt/analytics", "serve", "--stdio"]
    }
  }
}
```

Each person sets only the secret locally (login env, OS keychain helper, or
MDM user secret) — not in the shared file:

```bash
export GRANE_DB_PASSWORD='…their own read-only password…'
```

The MCP client inherits that environment. Grane substitutes `${GRANE_DB_PASSWORD}`
from YAML and URL-encodes the raw password. It does not re-scan the
password or any other substituted value.

Also supported: keep `url: ${DATABASE_URL}` in `grane.yml` (the `grane init`
default) and have each person export a **complete** `DATABASE_URL` on their
machine. That DSN is inserted as-is (the encoding opt-out). Discrete
`connection.password: ${GRANE_DB_PASSWORD}` (with shared host / user /
database in YAML) interpolates the password as a raw field, not URL-encoded.

Do **not** put `postgres://…:${GRANE_DB_PASSWORD}@…` in MCP `env` and expect
Grane to expand it — env values stay literal. Do **not** run
`grane mcp connect` without `--no-env` when building the template — that
copies the current process `DATABASE_URL` as a literal and will bake a
password into the file.

## What Grane enforces vs what GitHub enforces

**Grane** (local / pin / YAML):

- `grane serve` serves only the pinned commit (`grane.pin.json`, else legacy
  `.grane/active.json`)
- the pin must be on the configured base branch
- YAML is validated before approve writes a pin
- no symlinks or history tricks (replace refs, grafts, symlink pin / `.grane/`)
- AI / MCP tools cannot approve or write the pin
- approve and rollback only prepare pin PRs; they do not merge the base

**GitHub** (the shared repo):

- who can merge
- who must review
- which checks must pass
- whether anyone can push straight to `main`

Docs here do not claim GitHub is enforcing a setting unless that setting is
actually on. `grane doctor` saying **couldn't verify** means it did not see
a complete API response (including partial rulesets or unreadable
settings) — it is not a pass.

**Known limit:** identical YAML committed straight to `main` (no PR) matches
as if squash-merged. That is closed only when GitHub blocks direct pushes
(this page) and T2 reports the gap. Without those GitHub settings, Grane
cannot tell a squash merge from a direct push of the same YAML.
