/** Thrown when the cert connection cannot create an isolated namespace. */
export class CertifyPrivilegeError extends Error {
  readonly engine: string;
  readonly schemaName: string;

  constructor(engine: string, schemaName: string, detail?: string) {
    super(createSchemaRequiredMessage(engine, schemaName, detail));
    this.name = "CertifyPrivilegeError";
    this.engine = engine;
    this.schemaName = schemaName;
  }
}

export function createSchemaRequiredMessage(engine: string, schemaName: string, detail?: string): string {
  return (
    `Refusing to certify ${engine}: the connection cannot CREATE SCHEMA "${schemaName}". ` +
    `grane certify creates and drops its own namespace (grane_cert_<runid>) and never writes to existing adopter tables. ` +
    `Grant CREATE SCHEMA (or equivalent) on a dedicated cert role, not your production read-only user.` +
    (detail ? ` ${detail}` : "")
  );
}

export function looksLikeCreatePrivilegeError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /permission|privileg|denied|not authorized|unauthorized|insufficient|access denied|must be owner|CREATE SCHEMA|create dataset|dataset already|Forbidden/i.test(
    msg,
  );
}

export function rethrowCreateNamespaceFailure(engine: string, schemaName: string, err: unknown): never {
  if (looksLikeCreatePrivilegeError(err)) {
    throw new CertifyPrivilegeError(engine, schemaName, err instanceof Error ? err.message : String(err));
  }
  throw err;
}

export function isCertifyPrivilegeError(err: unknown): err is CertifyPrivilegeError {
  return (
    err instanceof CertifyPrivilegeError ||
    (err instanceof Error && err.name === "CertifyPrivilegeError") ||
    (err instanceof Error && /never writes to existing adopter tables/i.test(err.message))
  );
}
