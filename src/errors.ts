/**
 * Structured errors returned by the Grane kernel.
 *
 * Grane prefers explicit, machine-readable refusals over plausible but
 * ungoverned answers ("Refusal is a trust feature").
 */

export type RefusalStatus =
  | "undefined_metric"
  | "undefined_dimension"
  | "undefined_column"
  | "exploration_disabled"
  | "column_not_permitted"
  | "invalid_query"
  | "ambiguous_query"
  | "unsafe_query"
  | "config_error";

export interface Refusal {
  status: RefusalStatus;
  message: string;
  requested?: string;
  similar?: string[];
  details?: unknown;
}

export class GraneError extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "GraneError";
    this.refusal = refusal;
  }
}

export function undefinedMetric(requested: string, similar: string[]): GraneError {
  return new GraneError({
    status: "undefined_metric",
    message: `"${requested}" is not a defined metric in the Grane semantic model.`,
    requested,
    similar,
  });
}

/**
 * The name exists upstream (dbt, Cube, …) but the provider deliberately did
 * not import it. Same status as an unknown metric so agents keep one refusal
 * contract; the message and details say why it is missing.
 */
export function unsupportedMetric(
  requested: string,
  skipped: { provider: string; path?: string; reason: string },
  similar: string[],
): GraneError {
  return new GraneError({
    status: "undefined_metric",
    message:
      `"${requested}" is defined in the ${skipped.provider} project but Grane did not import it: ${skipped.reason} ` +
      `It is listed under catalog.unsupported. Do not approximate it with other metrics.`,
    requested,
    similar,
    details: { unsupported: { provider: skipped.provider, path: skipped.path, reason: skipped.reason } },
  });
}

export function unsupportedDimension(
  requested: string,
  skipped: { provider: string; path?: string; reason: string },
  similar: string[],
): GraneError {
  return new GraneError({
    status: "undefined_dimension",
    message:
      `"${requested}" is declared in the ${skipped.provider} project but Grane did not import it under that name: ${skipped.reason} ` +
      `It is listed under catalog.unsupported. Do not guess which meaning was intended.`,
    requested,
    similar,
    details: { unsupported: { provider: skipped.provider, path: skipped.path, reason: skipped.reason } },
  });
}

export function undefinedDimension(requested: string, similar: string[]): GraneError {
  return new GraneError({
    status: "undefined_dimension",
    message: `"${requested}" is not a defined dimension in the Grane semantic model.`,
    requested,
    similar,
  });
}

export function undefinedColumn(requested: string, similar: string[]): GraneError {
  return new GraneError({
    status: "undefined_column",
    message: `"${requested}" is not a column in the connected warehouse.`,
    requested,
    similar,
  });
}

export function explorationDisabled(requested: string): GraneError {
  return new GraneError({
    status: "exploration_disabled",
    message:
      `Raw warehouse field "${requested}" was requested, but exploration is disabled. ` +
      `Enable exploration in grane.yml, or use a governed metric or dimension.`,
    requested,
  });
}

export function columnNotPermitted(requested: string): GraneError {
  return new GraneError({
    status: "column_not_permitted",
    message: `"${requested}" is excluded from exploration by company policy.`,
    requested,
  });
}

export function invalidQuery(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "invalid_query", message, details });
}

export function ambiguousQuery(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "ambiguous_query", message, details });
}

export function unsafeQuery(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "unsafe_query", message, details });
}

export function configError(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "config_error", message, details });
}
