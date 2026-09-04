import { configError, invalidQuery } from "../errors.js";

/**
 * Prefix of every Grane-generated SQL identifier (hidden result columns,
 * cardinality wrappers, population CTEs, reach CTEs). User-controlled
 * analytical names must not use it. Matching is ASCII case-insensitive so
 * quoted-identifier warehouses and case-folding warehouses agree.
 */
export const INTERNAL_IDENT_PREFIX = "__grane_";

export function isReservedInternalIdent(name: string): boolean {
  return name.toLowerCase().startsWith(INTERNAL_IDENT_PREFIX);
}

export function reservedInternalMessage(kind: string, name: string): string {
  return (
    `${kind} "${name}" uses Grane's reserved "${INTERNAL_IDENT_PREFIX}" prefix, ` +
    `which is reserved for internal execution identifiers.`
  );
}

export function refuseReservedInternalIdent(kind: string, name: string, via: "config" | "query"): void {
  if (!isReservedInternalIdent(name)) return;
  const message = reservedInternalMessage(kind, name);
  const details = { identifier: name, prefix: INTERNAL_IDENT_PREFIX };
  if (via === "config") throw configError(message, details);
  throw invalidQuery(message, details);
}

/** Result columns in this prefix are internals and must be stripped. */
export function isInternalResultColumn(name: string): boolean {
  return isReservedInternalIdent(name);
}
