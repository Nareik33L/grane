# Least-privilege certification accounts

Grants for the four cloud `grane certify` warehouses. Kieran uses this to
stand up the gate-5 accounts; QA uses the **same recipe** with a **different**
principal for gate 8. Do not run either gate from this PR.

This certification account is **not** the runtime read-only user.

| Account | Used by | Privileges |
| --- | --- | --- |
| Runtime read-only user | `grane serve` / MCP against adopter tables | `SELECT` (or equivalent) on existing schemas. See [warehouses.md](warehouses.md) and [first-week.md](first-week.md). **Never** `CREATE SCHEMA`. |
| Certification account | `grane certify` / `certify-cloud` / QA RC cert | Create, seed, query, and drop **only objects it created inside the isolated parent**. **Never** pointed at production data or at the runtime user. |

`grane certify` creates `grane_cert_<runid>`, runs `CREATE TABLE` + `INSERT` +
corpus `SELECT`s, then `DROP … CASCADE` (BigQuery: delete dataset). Existing
adopter tables are never the seed target. Env vars: [certify.md](certify.md).

None of these four engines is runtime-certified until a credentialed
`certify-cloud` run has actually passed and `WAREHOUSE_CERTIFICATION` is
updated. They stay `self_certifiable`.

## Shared constraints

Vendors cannot grant “create objects whose name starts with `grane_cert_`”.
`CREATE SCHEMA` / `bigquery.datasets.create` is on the **parent**
(database, catalog, or project). Least privilege therefore means:

1. Put the cert principal in an **empty isolated container** (Snowflake
   database, Unity Catalog catalog, GCP project, Redshift database) that
   holds no adopter schemas, datasets, or tables.
2. Grant only the privileges below on that container plus compute
   (`USAGE` / `CAN USE` / `jobs.create`).
3. Do not grant account-admin, workspace-admin, project Editor/Owner, or
   database superuser. Do not grant `SELECT` on other schemas.

After `CREATE SCHEMA` / `createDataset`, the cert principal **owns** the
new `grane_cert_*` object, so it can create tables, run DML/SQL, and drop
that object without extra grants on it.

## Gate 5 and gate 8 (separate credentials)

[release-checklist.md](release-checklist.md) keeps two credentialed runs:

- **Gate 5.** Kieran’s `GRANE_CERT_*` GitHub secrets and a
  `certify-cloud` dispatch on the exact RC commit.
- **Gate 8.** QA independent RC certification of that **same** commit,
  with a **separate credential set** — different Snowflake user, BigQuery
  service account, Databricks token / service principal, and Redshift user
  than gate 5. Same grants, same isolated containers are fine (each run
  picks a unique `grane_cert_<runid>`). Sharing passwords, keys, or PATs
  is not.

A green public OSS CI job is neither gate.

---

## Snowflake

Run the setup as `USERADMIN` / `SECURITYADMIN` (or a custom role with
`CREATE USER` / `CREATE ROLE` / `MANAGE GRANTS`). **Do not** grant
`ACCOUNTADMIN` or `SYSADMIN` to the cert role.

**Sign-in:** password-only sign-in is being phased out. `CREATE USER`
without `TYPE` creates a `PERSON` user; a user with no `TYPE` counts as
human and needs MFA, so an **automated certify run will fail**. Create
`TYPE=SERVICE` and use **key-pair** auth. Do not use `LEGACY_SERVICE`
(password without MFA; that type is being deprecated).

Generate a 2048-bit PKCS8 key (optional passphrase) and assign the public
key. Replace `CERT_DB`, `CERT_WH`, `GRANE_CERT`, and the public-key body
(no `BEGIN`/`END` lines).

```bash
openssl genrsa 2048 | openssl pkcs8 -topk8 -inform PEM -out rsa_key.p8 -nocrypt
openssl rsa -in rsa_key.p8 -pubout -out rsa_key.pub
```

```sql
-- USERADMIN
CREATE USER IF NOT EXISTS GRANE_CERT
  TYPE = SERVICE
  DEFAULT_ROLE = GRANE_CERT
  DEFAULT_WAREHOUSE = CERT_WH
  DEFAULT_NAMESPACE = CERT_DB
  RSA_PUBLIC_KEY = '<rsa_key.pub body>'
  COMMENT = 'grane certify only; not the runtime read-only user';

-- SECURITYADMIN
CREATE ROLE IF NOT EXISTS GRANE_CERT
  COMMENT = 'Create/drop objects this role created in CERT_DB; use CERT_WH';

GRANT ROLE GRANE_CERT TO USER GRANE_CERT;

GRANT USAGE ON WAREHOUSE CERT_WH TO ROLE GRANE_CERT;
GRANT USAGE ON DATABASE CERT_DB TO ROLE GRANE_CERT;
GRANT CREATE SCHEMA ON DATABASE CERT_DB TO ROLE GRANE_CERT;
```

Set `GRANE_CERT_SNOWFLAKE_PRIVATE_KEY` to the path of `rsa_key.p8` (or
the PEM body). Encrypted keys also need
`GRANE_CERT_SNOWFLAKE_PRIVATE_KEY_PASSPHRASE`. In `certify-cloud` the
GitHub secret is the PEM document; the workflow writes a `0600` `mktemp`
file under `$RUNNER_TEMP` and deletes it on every exit (including
failures). Never echo, log, or upload that file; forked-PR workflows do
not receive the secret.

### Alternative: programmatic access token + network policy

`TYPE=SERVICE` can use a programmatic access token (PAT) instead of
key-pair. Generating or using a PAT for a service user **requires an
active network policy** (account- or user-level) that allows the
runner’s egress IPs. Put the token in `GRANE_CERT_SNOWFLAKE_PASSWORD`
(the Node driver uses the password field). Prefer key-pair; password/PAT
auth prints a warning.

```sql
CREATE NETWORK POLICY grane_cert_net ALLOWED_IP_LIST = ('<ci-or-qa-egress-cidr>');
ALTER USER GRANE_CERT SET NETWORK_POLICY = grane_cert_net;
ALTER USER GRANE_CERT ADD PROGRAMMATIC ACCESS TOKEN grane_cert_pat
  ROLE_RESTRICTION = 'GRANE_CERT'
  DAYS_TO_EXPIRY = 90;
```

Password-only `PERSON` users remain supported in the client for
backward compatibility and warn at certify time. Do not create those for
new cert accounts.

`CERT_DB` must contain no adopter schemas. Do **not** grant `USAGE` on
`CERT_DB.PUBLIC` or on any other database. Do **not** grant
`CREATE TABLE ON ALL SCHEMAS IN DATABASE CERT_DB` (that would cover
schemas the cert role does not own). Do **not** grant `OPERATE` /
`MODIFY` / `OWNERSHIP` on the warehouse, `CREATE WAREHOUSE`, or
`CREATE DATABASE`.

What the cert role can then do, without further GRANTs:

- `CREATE SCHEMA grane_cert_<runid>` — requires `CREATE SCHEMA` on the
  database. The creating role automatically receives `OWNERSHIP` on that
  schema (`OWNERSHIP` is “full control”, including `CREATE TABLE`,
  `INSERT`, `SELECT`, and `DROP SCHEMA CASCADE`).
- `USAGE` on `CERT_WH` submits queries; if the warehouse auto-resumes, it
  resumes on the statement. No `OPERATE` needed.

Set `GRANE_CERT_SNOWFLAKE_ROLE=GRANE_CERT` so the session uses this role.

### Official docs

- Privileges (`CREATE SCHEMA` on a database; warehouse `USAGE`; schema
  `OWNERSHIP` = full control; `OWNERSHIP` auto-granted to the creator):
  [Access control privileges](https://docs.snowflake.com/en/user-guide/security-access-control-privileges)
- Custom roles / least privilege:
  [Configuring access control](https://docs.snowflake.com/en/user-guide/security-access-control-configure)
- `CREATE SCHEMA` required privilege:
  [CREATE SCHEMA](https://docs.snowflake.com/en/sql-reference/sql/create-schema)
- `GRANT`:
  [GRANT privileges](https://docs.snowflake.com/en/sql-reference/sql/grant-privilege)
- Ownership model (creator owns the object):
  [Overview of access control](https://docs.snowflake.com/en/user-guide/security-access-control-overview)
- `TYPE=SERVICE` (omit `TYPE` → `PERSON`); `RSA_PUBLIC_KEY`:
  [CREATE USER](https://docs.snowflake.com/en/sql-reference/sql/create-user)
- Password-only / MFA rollout (the failure an automated run hits):
  [MFA rollout](https://docs.snowflake.com/en/user-guide/security-mfa-rollout)
- Key-pair (openssl + assign public key):
  [Key-pair authentication](https://docs.snowflake.com/en/user-guide/key-pair-auth),
  [Node.js key-pair](https://docs.snowflake.com/en/developer-guide/node-js/nodejs-driver-authenticate)
- PAT requires a network policy for service users:
  [Programmatic access tokens](https://docs.snowflake.com/en/user-guide/programmatic-access-tokens),
  [ALTER USER … ADD PAT](https://docs.snowflake.com/en/sql-reference/sql/alter-user-add-programmatic-access-token),
  [Network policies](https://docs.snowflake.com/en/user-guide/network-policies)

---

## BigQuery

`bigquery.datasets.create` and `bigquery.jobs.create` are **project**
permissions. A custom role with only those two, on an **empty cert
project**, is the least-privilege setup. Do **not** grant
`roles/bigquery.admin`, `roles/editor`, or `roles/owner`. Do **not**
grant `roles/bigquery.dataEditor` at project scope (that edits every
dataset in the project).

The creator of a dataset is automatically granted BigQuery Data Owner
(`roles/bigquery.dataOwner`) **on that dataset**, which includes
`bigquery.datasets.delete` and table create/DML/`getData`. That is how
the cert account drops `grane_cert_*` without a project-wide delete
grant.

Replace `PROJECT_ID`.

```bash
gcloud iam service-accounts create grane-cert \
  --project=PROJECT_ID \
  --display-name="grane certify (not the runtime read-only user)"

gcloud iam roles create graneCert \
  --project=PROJECT_ID \
  --title="Grane certify" \
  --description="Create cert datasets and run jobs; owner of datasets this SA creates" \
  --stage=GA \
  --permissions=bigquery.datasets.create,bigquery.jobs.create

gcloud projects add-iam-policy-binding PROJECT_ID \
  --member="serviceAccount:grane-cert@PROJECT_ID.iam.gserviceaccount.com" \
  --role="projects/PROJECT_ID/roles/graneCert"

gcloud iam service-accounts keys create /path/to/grane-cert.json \
  --iam-account="grane-cert@PROJECT_ID.iam.gserviceaccount.com"
```

An organization policy can **block service-account key creation**
(`constraints/iam.disableServiceAccountKeyCreation` / managed
`constraints/iam.managed.disableServiceAccountKeyCreation`; enforced by
default on organizations created on or after 3 May 2024). If
`gcloud iam service-accounts keys create` fails with key creation not
allowed, use ADC / workload identity, or an org-policy exception on the
cert project — do not fall back to a user key. See
[Restrict service accounts](https://cloud.google.com/organization-policy/restrict-service-accounts)
and
[Troubleshoot org policies](https://cloud.google.com/iam/docs/troubleshoot-org-policies).

`GRANE_CERT_BIGQUERY_PROJECT=PROJECT_ID`.
Locally `GRANE_CERT_BIGQUERY_CREDENTIALS` is a **path** to that JSON key
(or ADC) — the Node client uses `keyFilename`, not the JSON body.
In `certify-cloud` the GitHub secret is the JSON document; the workflow
writes a `0600` `mktemp` file under `$RUNNER_TEMP` (`printf`, never
`echo`) and deletes it on every exit (`trap EXIT` plus the shared
`always()` step before upload). Never echo, log, or upload that file;
forked-PR workflows do not receive the secret.
Gate 8 uses a second service account with the same custom role, not this
key.

Do **not** grant `bigquery.datasets.delete` at project scope. Do **not**
bind this SA to production projects.

### Official docs

- Dataset create permission is on the project; dataset-level roles cannot
  create datasets:
  [Control access with IAM](https://cloud.google.com/bigquery/docs/control-access-to-resources-iam)
- Creator is automatically `roles/bigquery.dataOwner` on the new dataset
  (and can therefore delete it):
  [Create datasets](https://cloud.google.com/bigquery/docs/datasets)
- Table create in a dataset you created does not need extra project
  grants:
  [Create and use tables](https://cloud.google.com/bigquery/docs/tables)
  (“If you have the `bigquery.datasets.create` permission, you can create
  tables in the datasets that you create.”)
- Jobs: `bigquery.jobs.create` on the billing/job project:
  [Data definition language](https://cloud.google.com/bigquery/docs/reference/standard-sql/data-definition-language)
- Custom roles:
  [Create and manage custom roles](https://cloud.google.com/iam/docs/creating-custom-roles),
  [`gcloud iam roles create`](https://cloud.google.com/sdk/gcloud/reference/iam/roles/create)
- Predefined role inventory (what **not** to use at project scope):
  [BigQuery IAM roles and permissions](https://cloud.google.com/bigquery/docs/access-control)

---

## Databricks (Unity Catalog)

Two layers: Unity Catalog privileges on an **isolated catalog**, and
workspace **CAN USE** on the SQL warehouse. Do **not** make the cert
principal a workspace admin. Do **not** grant `CREATE TABLE` /
`USE SCHEMA` at catalog scope (that would apply to every current and
future schema in the catalog, including ones the cert principal does not
own). The schema **owner** can add tables and `DROP SCHEMA … CASCADE`.

**Set `GRANE_CERT_DATABRICKS_CATALOG`** to a dedicated catalog. If it is
unset, certify **falls back to `main`**, where every workspace user has
`USE CATALOG` by default — do not leave it blank.

Replace `grane_cert` (catalog), the managed-storage URI, and the
service-principal application ID. If the metastore has no managed
storage, `MANAGED LOCATION` is required.

```sql
-- Metastore admin / catalog owner. Isolated catalog, no adopter schemas.
CREATE CATALOG IF NOT EXISTS grane_cert
  MANAGED LOCATION 's3://<external-location-path>/grane_cert';
-- Azure: abfss://…  GCP: gs://…
GRANT USE CATALOG ON CATALOG grane_cert TO `<service-principal-application-id>`;
GRANT CREATE SCHEMA ON CATALOG grane_cert TO `<service-principal-application-id>`;
```

The creator needs `CREATE MANAGED STORAGE` on that external location.
Also assign the workspace **Databricks SQL access** entitlement
(`databricks-sql-access`) to the service principal so it can use SQL
warehouses (CAN USE is not enough without the entitlement). Do **not**
grant Allow unrestricted cluster creation.

Do **not** grant `ALL PRIVILEGES`, `MANAGE`, `CREATE CATALOG`, or
`USE SCHEMA` / `CREATE TABLE` / `SELECT` / `MODIFY` on `CATALOG
grane_cert`. Do **not** grant anything on other catalogs.

What the principal can then do as owner of `grane_cert.grane_cert_<runid>`:

- `CREATE SCHEMA` requires `USE CATALOG` + `CREATE SCHEMA` on the catalog.
- Owner may `CREATE TABLE`, `INSERT`, `SELECT`, and
  `DROP SCHEMA … CASCADE`.

SQL warehouse (workspace ACL, not Unity Catalog SQL): assign **CAN USE**
on the warehouse whose HTTP path is `GRANE_CERT_DATABRICKS_HTTP_PATH`.
CAN USE can start the warehouse and run queries. Do **not** assign
CAN MANAGE / IS OWNER (edit, delete, change permissions).

### Official docs

- `CREATE SCHEMA` needs `USE CATALOG` + `CREATE SCHEMA` on the catalog;
  `CREATE TABLE` at catalog level applies to every schema (avoid that);
  owners have all privileges on the object:
  [Unity Catalog privileges reference](https://docs.databricks.com/aws/en/data-governance/unity-catalog/access-control/privileges-reference),
  [Permissions model concepts](https://docs.databricks.com/aws/en/data-governance/unity-catalog/access-control/permissions-concepts)
- `GRANT` syntax (backticks around service-principal ids):
  [GRANT](https://docs.databricks.com/aws/en/sql/language-manual/security-grant),
  [Manage privileges](https://docs.databricks.com/aws/en/data-governance/unity-catalog/manage-privileges/)
- Schema owner can add tables; drop requires owner (or `MANAGE`) plus
  `USE CATALOG`:
  [Manage schemas](https://docs.databricks.com/aws/en/schemas/manage-schema),
  [DROP SCHEMA](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-ddl-drop-schema)
- SQL warehouse CAN USE (run queries; not manage):
  [SQL warehouse ACLs](https://docs.databricks.com/aws/en/security/auth/access-control/#sql-warehouse-acls),
  [Create a SQL warehouse](https://docs.databricks.com/aws/en/compute/sql-warehouse/create)
- `MANAGED LOCATION` / `CREATE MANAGED STORAGE`:
  [Create catalogs](https://docs.databricks.com/aws/en/catalogs/create-catalog),
  [Managed storage](https://docs.databricks.com/aws/en/connect/unity-catalog/cloud-storage/managed-storage),
  [CREATE CATALOG](https://docs.databricks.com/aws/en/sql/language-manual/sql-ref-syntax-ddl-create-catalog)
- Databricks SQL access entitlement (`databricks-sql-access`):
  [Manage entitlements](https://docs.databricks.com/aws/en/security/auth/entitlements)

Azure/GCP workspaces use the same Unity Catalog privilege names.

---

## Redshift

`CREATE` on a **database** allows creating schemas in that database. The
user who creates a schema owns it and can create tables, query them, and
`DROP SCHEMA … CASCADE`. Isolate an empty database. Default Redshift
databases give every user `CREATE` and `USAGE` on `PUBLIC` — revoke that
so the cert user cannot write adopter objects in `public`.

Replace `cert_db` and `grane_cert`. **`CREATE USER` needs a superuser or
a role with the `CREATE USER` privilege** — not the database owner (the
database owner can `GRANT CREATE ON DATABASE` after the user exists).
The cert user is `NOCREATEDB` `NOCREATEUSER` (the `CREATE USER`
defaults).

```sql
CREATE USER grane_cert PASSWORD '<rotate>' NOCREATEDB NOCREATEUSER
  CONNECTION LIMIT 4;

GRANT CREATE ON DATABASE cert_db TO grane_cert;

-- Default: every user has CREATE + USAGE on PUBLIC. Take that away.
REVOKE CREATE, USAGE ON SCHEMA public FROM PUBLIC;
REVOKE CREATE, USAGE ON SCHEMA public FROM grane_cert;
```

Connect as `grane_cert` to `cert_db` (`GRANE_CERT_REDSHIFT_URL`). Do
**not** grant `CREATEDB`, `CREATEUSER` / superuser, `SYSLOG ACCESS
UNRESTRICTED`, or `CREATE`/`USAGE` on any other schema. Do **not**
`GRANT SELECT ON ALL TABLES IN SCHEMA …` for adopter schemas.

`TEMPORARY` on the database is not required (the corpus does not create
temp tables). **`TEMP` is still granted to `PUBLIC` by default** on the
database; that is a Redshift default, not a cert grant. Revoking
`TEMP ON DATABASE … FROM PUBLIC` is optional and not required for this
setup.

### Official docs

- `GRANT CREATE ON DATABASE` = create schemas in that database;
  `GRANT` syntax:
  [GRANT](https://docs.aws.amazon.com/redshift/latest/dg/r_GRANT.html)
- `CREATE SCHEMA` allowed for superuser or users with that privilege;
  `AUTHORIZATION` sets owner:
  [CREATE SCHEMA](https://docs.aws.amazon.com/redshift/latest/dg/r_CREATE_SCHEMA.html)
- “Any user can create schemas and alter or drop schemas they own”:
  [Creating, altering, and deleting schemas](https://docs.aws.amazon.com/redshift/latest/dg/r_Schemas_and_tables-creating-altering-and-deleting-schemas.html)
- Schema owner / `DROP SCHEMA` privilege:
  [System permissions](https://docs.aws.amazon.com/redshift/latest/dg/r_roles-system-privileges.html),
  [DROP SCHEMA](https://docs.aws.amazon.com/redshift/latest/dg/r_DROP_SCHEMA.html)
- Owner-only modify/destroy; revoke `PUBLIC` schema defaults:
  [Default database user permissions](https://docs.aws.amazon.com/redshift/latest/dg/r_Privileges.html)
- `CREATE USER` defaults (`NOCREATEDB`, `NOCREATEUSER`):
  [CREATE USER](https://docs.aws.amazon.com/redshift/latest/dg/r_CREATE_USER.html)

---

## Checklist

For **each** of gate 5 and gate 8, four principals, eight if both gates
share no identities:

1. Isolated empty parent (database / catalog / project).
2. Grants copied from the engine section above — nothing broader.
3. Confirm the principal **cannot** `SELECT` adopter tables and **cannot**
   drop anything except **objects it created inside the isolated parent**.
4. Store gate-5 values in GitHub `GRANE_CERT_*` secrets. Keep gate-8
   credentials out of that store.
5. Do not dispatch `certify-cloud` or run QA RC cert from a public PR.
   npm publish stays on hold.
