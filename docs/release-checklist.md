# Release checklist

Release-only steps. **Do not run credentialed certify-cloud, QA cert, npm
publish, git tag, or git push from a public PR.** npm publish stays on hold.

PRs may run the **dry-run** below. It pins every step to an exact RC SHA,
names the owner, checks the npm tarball file list, and runs a read-only
package-name lookup. It does not publish, tag, or push.

## Cut the RC from main (owner: Lead)

The RC is the tip of `main` at cut time — never a feature branch.

```bash
git fetch origin main
RC=$(git rev-parse origin/main)   # full 40-character SHA
git checkout "$RC"
npx tsx src/release/dry-run.ts --sha "$RC"
# or: npm run release:dry-run -- --sha "$RC"
```

Every later command uses that SHA (`--ref` / `git checkout`), not a moving
branch tip.

| Step | Owner | Dry-run |
| --- | --- | --- |
| Cut RC from `main` | Lead | Verifies `--sha` is 40 hex (rejects 7-char short SHAs), `HEAD` is that SHA, and the tree is clean |
| 5. Credentialed `certify-cloud` | Kieran | Prints `gh workflow run certify-cloud.yml --ref <SHA>` — `execute: print-only`, not dispatched |
| 8. QA independent RC certification | QA | Prints `git checkout <SHA>` + `grane certify` for each cloud engine — `execute: print-only`, not run |
| `npm pack --dry-run --ignore-scripts` file-list | Lead | **Runs** after refusing pack-time scripts (`prepare` / `prepack` / `postpack` / `prepublish*` — npm 10 still runs `prepare` even with `--ignore-scripts`; `prepublishOnly` is publish-only). Demo/example paths are an **exact** allowlist (not a glob). `package.json` `files` has `!dist/**/*.map`. Fails if README, `dist/index.js`, or the bin target (`dist/cli/index.js`) are missing. Forbidden-name check rejects `demo/creds.yml`, `demo/.env.yml`, `example/.secrets.yaml`, `example/aws_credentials.sql`, `demo/deploy-key.sh`, `demo/fixtures/a.sql`, `dist/tests/x.js`, `demo/secrets.json`, `demo/id_ed25519`, `example/notes.txt`, and dist `*.js.map`. Packed `dist/` files that `tsc` would not emit are refused |
| `npm view grane-analytics` | Lead | **Runs, read-only.** No token. 404 (unpublished) is OK while npm is on hold |
| `npm publish` / `npm version` / `npm dist-tag` / `git tag` / `git push` / `gh release` | Lead | On hold. The dry-run refuses `--publish` / `--tag` / `--push` and never executes `npm publish`, `npm version`, `npm dist-tag`, `git tag`, `git push`, `gh workflow run`, `gh release`, or `gh api` |

## Warehouse categories (must match the certified matrix)

| Category | Map state | Who |
| --- | --- | --- |
| runtime-certified | `certified` | PostgreSQL 16, MySQL 8, DuckDB 1.5, ClickHouse 24 (CI corpus) |
| compile-supported | `self_certifiable` | Snowflake, BigQuery, Redshift, Databricks |
| not yet certified | `compile_only` | none today |

No cloud warehouse is runtime-certified until the credentialed certify-cloud
step below has actually passed **and** `WAREHOUSE_CERTIFICATION` is updated.

## Do not attempt from this PR

### 5. Credentialed `certify-cloud` on the exact RC commit (owner: Kieran)

Kieran adds `GRANE_CERT_*` secrets (least-privilege accounts — not the
runtime read-only user — in [certify-grants.md](certify-grants.md)) and
dispatches `.github/workflows/certify-cloud.yml` against the exact
release-candidate commit (not a later tip):

```bash
gh workflow run certify-cloud.yml --ref "$RC" -f engine=all
```

A pending or skipped dispatch does not change the matrix. See
[certify.md](certify.md). The dry-run only prints this command.

### 8. QA independent RC certification (owner: QA)

QA runs an independent certification of that same RC commit with a
**separate credential set** from step 5 (different Snowflake user, BigQuery
service account, Databricks token / service principal, and Redshift user —
same grants, never the same passwords/keys/PATs). Recipe:
[certify-grants.md](certify-grants.md). A green public OSS CI run is not
this step.

```bash
git checkout "$RC"
npx tsx src/cli/index.ts certify --engine snowflake
npx tsx src/cli/index.ts certify --engine bigquery
npx tsx src/cli/index.ts certify --engine databricks
npx tsx src/cli/index.ts certify --engine redshift
```

The dry-run only prints these commands.

## Also on hold

- `npm publish` / `npm version` / `npm dist-tag` of the V2 package
- `git tag` / `git push` of the release tag
- `gh release`

No npm or GitHub tokens are stored in-repo for this checklist. `npm view
grane-analytics` is unauthenticated. The dry-run does not publish, tag, or
push.

## After those pass (owner: Lead)

1. Update `WAREHOUSE_CERTIFICATION` only for engines the credentialed run
   actually certified.
2. Retarget docs so the three categories still match the map 1:1.
3. Tag the RC and publish when npm is taken off hold.
