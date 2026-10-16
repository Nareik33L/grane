# Release checklist

Release-only steps. **Do not run these from a public PR or this V2-15 branch.**
npm publish stays on hold.

## Warehouse categories (must match the certified matrix)

| Category | Map state | Who |
| --- | --- | --- |
| runtime-certified | `certified` | PostgreSQL 16, MySQL 8, DuckDB 1.5, ClickHouse 24 (CI corpus) |
| compile-supported | `self_certifiable` | Snowflake, BigQuery, Redshift, Databricks |
| not yet certified | `compile_only` | none today |

No cloud warehouse is runtime-certified until the credentialed certify-cloud
step below has actually passed **and** `WAREHOUSE_CERTIFICATION` is updated.

## Do not attempt from this PR

### 5. Credentialed `certify-cloud` on the exact RC commit

Kieran adds `GRANE_CERT_*` secrets (least-privilege accounts — not the
runtime read-only user — in [certify-grants.md](certify-grants.md)) and
dispatches `.github/workflows/certify-cloud.yml` against the exact
release-candidate commit (not a later tip). A pending or skipped dispatch
does not change the matrix. See [certify.md](certify.md).

### 8. QA independent RC certification

QA runs an independent certification of that same RC commit with a
**separate credential set** from step 5 (different Snowflake user, BigQuery
service account, Databricks token / service principal, and Redshift user —
same grants, never the same passwords/keys/PATs). Recipe:
[certify-grants.md](certify-grants.md). A green public OSS CI run is not
this step.

## Also on hold

- `npm publish` of the V2 package

## After those pass (release owner)

1. Update `WAREHOUSE_CERTIFICATION` only for engines the credentialed run
   actually certified.
2. Retarget docs so the three categories still match the map 1:1.
3. Tag the RC and publish when npm is taken off hold.
