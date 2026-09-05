import { GraneError, publicErrorMessage, type Refusal } from "../errors.js";

export interface JsonFailure {
  ok: false;
  status: Refusal["status"] | "error";
  message: string;
  requested?: string;
  similar?: string[];
  details?: unknown;
}

export function wantsJson(argv: string[] = process.argv): boolean {
  return argv.includes("--json");
}

export function formatHumanFailure(err: unknown): string[] {
  if (err instanceof GraneError) {
    const lines = [`ERROR (${err.refusal.status}): ${err.refusal.message}`];
    if (err.refusal.similar?.length) {
      lines.push(`Similar: ${err.refusal.similar.join(", ")}`);
    }
    return lines;
  }
  return [`ERROR: ${publicErrorMessage(err)}`];
}

export function formatJsonFailure(err: unknown): JsonFailure {
  if (err instanceof GraneError) {
    const body: JsonFailure = {
      ok: false,
      status: err.refusal.status,
      message: err.refusal.message,
    };
    if (err.refusal.requested !== undefined) body.requested = err.refusal.requested;
    if (err.refusal.similar?.length) body.similar = err.refusal.similar;
    if (err.refusal.details !== undefined) body.details = err.refusal.details;
    return body;
  }
  return {
    ok: false,
    status: "error",
    message: publicErrorMessage(err),
  };
}

export function fail(err: unknown, argv: string[] = process.argv): never {
  if (wantsJson(argv)) {
    console.log(JSON.stringify(formatJsonFailure(err), null, 2));
  } else {
    for (const line of formatHumanFailure(err)) console.error(line);
  }
  process.exit(1);
}
