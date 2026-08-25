/**
 * Structured errors returned by the Grane kernel.
 *
 * Grane prefers explicit, machine-readable refusals over plausible but
 * ungoverned answers ("Refusal is a trust feature").
 */

export type RefusalStatus =
  | "undefined_metric"
  | "undefined_dimension"
  | "invalid_query"
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

export function undefinedDimension(requested: string, similar: string[]): GraneError {
  return new GraneError({
    status: "undefined_dimension",
    message: `"${requested}" is not a defined dimension in the Grane semantic model.`,
    requested,
    similar,
  });
}

export function invalidQuery(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "invalid_query", message, details });
}

export function unsafeQuery(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "unsafe_query", message, details });
}

export function configError(message: string, details?: unknown): GraneError {
  return new GraneError({ status: "config_error", message, details });
}
