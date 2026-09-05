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

/**
 * Safe one-line message for CLI / doctor / logs. Prefers `message`, then
 * `code`, then `String(err)`. Strips credentials and stack frames.
 */
export function publicErrorMessage(err: unknown): string {
  const raw = rawErrorText(err);
  const redacted = redactSensitive(raw).replace(/\r?\n[\s\S]*$/, "").trim();
  return redacted || "Unknown error";
}

export function warehouseUnreachable(warehouse: string, err: unknown): Error {
  return new Error(`Cannot reach the ${warehouse} warehouse: ${publicErrorMessage(err)}`);
}

export function looksUnreachable(err: unknown): boolean {
  const code = errorCode(err);
  const text = `${code} ${rawErrorText(err)}`.toLowerCase();
  return /econnrefused|enotfound|etimedout|econnreset|eai_again|ehostunreach|epipe|econnaborted|connect e|connection refused|could not connect|remaining connection slots|server closed the connection|no pg_hba|password authentication failed|timeout expired|connection terminated/.test(
    text,
  );
}

export function wrapIfUnreachable(warehouse: string, err: unknown): never {
  if (looksUnreachable(err)) throw warehouseUnreachable(warehouse, err);
  if (err instanceof Error) throw err;
  throw new Error(publicErrorMessage(err));
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && (err as { code?: unknown }).code != null) {
    return String((err as { code: unknown }).code);
  }
  return "";
}

function rawErrorText(err: unknown): string {
  if (err instanceof Error) {
    const msg = err.message?.trim() ?? "";
    const code = errorCode(err);
    if (msg && code && !msg.includes(code)) return `${msg} (${code})`;
    if (msg) return msg;
    if (code) return `${err.name && err.name !== "Error" ? err.name : "Error"} (${code})`;
    if (err.name && err.name !== "Error") return err.name;
    return String(err);
  }
  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    const msg = typeof rec.message === "string" ? rec.message.trim() : "";
    const code = rec.code != null ? String(rec.code) : "";
    if (msg && code && !msg.includes(code)) return `${msg} (${code})`;
    if (msg) return msg;
    if (code) return code;
  }
  const text = String(err).trim();
  return text && text !== "[object Object]" ? text : "";
}

function redactSensitive(text: string): string {
  return text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]+/gi, (url) => {
      try {
        const parsed = new URL(url);
        if (parsed.password || parsed.username) {
          parsed.password = parsed.password ? "***" : "";
          parsed.username = parsed.username ? "***" : parsed.username;
        }
        return parsed.toString();
      } catch {
        return url.replace(/:\/\/[^/@\s]+@/g, "://***@");
      }
    })
    .replace(/\b(password|pwd|secret|token|api[_-]?key|motherduck_token)\s*[=:]\s*\S+/gi, "$1=***");
}
