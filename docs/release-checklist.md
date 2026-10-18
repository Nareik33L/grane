# Release checklist

Release-only steps. **Do not run credentialed certify-cloud, QA cert, npm
publish, git tag, or git push from a public PR.** npm publish stays on hold
until Kieran takes it off hold.

PRs may run the **dry-run** below. It pins every step to an exact RC SHA,
names the owner, checks the npm tarball file list, and runs a read-only
package-name lookup. It does not publish, tag, or push.

**Who does each step:** the **AI prepares**, **QA certifies**, **Kieran
publishes**.

## Cut the RC from main (owner: AI)

The RC is **to be cut from main after #110 merges**. Release 1 includes
the team setup guide (`docs/team-setup.md`) and the read-only
branch-protection check, which land in
[#110](https://github.com/Nareik33L/grane/pull/110) (T2). That PR is
**not merged yet**, so do not pin an RC SHA from today's `main`.

When #110 is on `main`, the AI prepares by cutting the tip of `main` —
never a feature branch — and pinning every later command to that
40-character SHA:

```bash
git fetch origin main
RC=$(git rev-parse origin/main)   # full 40-character SHA
git checkout "$RC"
npx tsx src/release/dry-run.ts --sha "$RC"
# or: npm run release:dry-run -- --sha "$RC"
```

Every later command uses that SHA (`--ref` / `git checkout`), not a moving
branch tip.

| Step | Owner | Role | Dry-run |
| --- | --- | --- | --- |
| Cut RC from `main` | AI | prepares | Verifies `--sha` is 40 hex (rejects 7-char short SHAs), `HEAD` is that SHA, and the tree is clean |
| 5. Credentialed `certify-cloud` | QA | certifies | Prints `gh workflow run certify-cloud.yml --ref <SHA>` — `execute: print-only`, not dispatched |
| 8. QA independent RC certification | QA | certifies | Prints `git checkout <SHA>` + `grane certify` for each cloud engine — `execute: print-only`, not run |
| `npm pack --dry-run --ignore-scripts` file-list | AI | prepares | **Runs** after refusing pack-time scripts (`prepare` / `prepack` / `postpack` / `prepublish*` — npm 10 still runs `prepare` even with `--ignore-scripts`; `prepublishOnly` is publish-only). Demo/example paths are an **exact** allowlist (not a glob). `package.json` `files` has `!dist/**/*.map`. Fails if README, `dist/index.js`, or the bin target (`dist/cli/index.js`) are missing. Forbidden-name check rejects `tests/`, `fixtures/`, `.env`, `transcripts/`, `demo/creds.yml`, `demo/.env.yml`, `example/.secrets.yaml`, `example/aws_credentials.sql`, `demo/deploy-key.sh`, `demo/fixtures/a.sql`, `dist/tests/x.js`, `tests/consistency/ai-runs/transcripts/a.json`, `demo/secrets.json`, `demo/id_ed25519`, `example/notes.txt`, and dist `*.js.map`. Packed `dist/` files that `tsc` would not emit are refused. Unit test: `tests/unit/release-dry-run.test.ts` live pack list vs allowlist |
| `npm view grane-analytics` | AI | prepares | **Runs, read-only.** Confirms the package name is owned (or unpublished / 404). No token. 404 is OK while npm is on hold |
| `npm publish` / `npm version` / `npm dist-tag` / `git tag` / `git push` / `gh release` | Kieran | publishes | On hold. Tag-driven `.github/workflows/publish-npm.yml` is the path when Kieran publishes; this dry-run refuses `--publish` / `--tag` / `--push` and never executes `npm publish`, `npm version`, `npm dist-tag`, `git tag`, `git push`, `gh workflow run`, `gh release`, or `gh api` |

## Warehouse categories (must match the certified matrix)

| Category | Map state | Who |
| --- | --- | --- |
| runtime-certified | `certified` | PostgreSQL 16, MySQL 8, DuckDB 1.5, ClickHouse 24 (CI corpus) |
| compile-supported | `self_certifiable` | Snowflake, BigQuery, Redshift, Databricks — not yet tested / not certified (no credentialed run) |
| not yet certified | `compile_only` | none today |

No cloud warehouse is runtime-certified until the credentialed certify-cloud
step below has actually passed **and** `WAREHOUSE_CERTIFICATION` is updated.

## Do not attempt from this PR

### 5. Credentialed `certify-cloud` on the exact RC commit (owner: QA)

QA certifies. Add `GRANE_CERT_*` secrets (least-privilege accounts — not the
runtime read-only user — in [certify-grants.md](certify-grants.md)) and
dispatch `.github/workflows/certify-cloud.yml` against the exact
release-candidate commit (not a later tip):

```bash
gh workflow run certify-cloud.yml --ref "$RC" -f engine=all
```

A pending or skipped dispatch does not change the matrix. See
[certify.md](certify.md). The dry-run only prints this command.

### 8. QA independent RC certification (owner: QA)

QA certifies that same RC commit with a **separate credential set** from
step 5 (different Snowflake user, BigQuery service account, Databricks
token / service principal, and Redshift user — same grants, never the same
passwords/keys/PATs). Recipe: [certify-grants.md](certify-grants.md). A
green public OSS CI run is not this step.

```bash
git checkout "$RC"
npx tsx src/cli/index.ts certify --engine snowflake
npx tsx src/cli/index.ts certify --engine bigquery
npx tsx src/cli/index.ts certify --engine databricks
npx tsx src/cli/index.ts certify --engine redshift
```

The dry-run only prints these commands.

## Tag-driven npm publish (cannot publish yet)

`.github/workflows/publish-npm.yml` runs on a `v*` tag or
`workflow_dispatch`. It uses the protected GitHub environment
`npm-publish` (manual approval). **This PR does not create that
environment, add a token, change branch protection, or change repo
settings.** When a human creates `npm-publish`, its deployment rule
should allow `v*` tags only (not branches), so a dispatch from a branch
cannot deploy. The workflow also fails closed unless `GITHUB_REF` is
`refs/tags/v*` and `${GITHUB_REF_NAME#v}` equals the `version` in
`package.json`. The workflow references the environment's npm publish
secret by name only (no value is stored in-repo). If that secret is
missing, the job fails closed with a clear message and does not publish.

Order: `npm ci --ignore-scripts` → build → unit tests → `npm pack
--dry-run` file-list check (`npx tsx src/release/check-pack.ts`) →
require `refs/tags/v*` → tag version equals `package.json` → fail-closed
token check → `npm publish --provenance`. Permissions: `contents: read`,
`id-token: write`. Checkout and setup-node are pinned to commit SHAs.
The publish job does not use the npm cache.

Do not tag, push tags, or dispatch this workflow from a public PR.

## Also on hold

- `npm publish` / `npm version` / `npm dist-tag` of the V2 package
- `git tag` / `git push` of the release tag
- `gh release`

No npm or GitHub tokens are stored in-repo for this checklist. `npm view
grane-analytics` is unauthenticated. The dry-run does not publish, tag, or
push.

## After those pass (owner: Kieran)

1. Update `WAREHOUSE_CERTIFICATION` only for engines the credentialed run
   actually certified.
2. Retarget docs so the three categories still match the map 1:1.
3. Tag the RC and publish when npm is taken off hold (Kieran publishes).
