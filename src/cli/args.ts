import type { QueryFilter } from "../query/model.js";

export type SetupInvocation =
  | { kind: "import"; dir: string }
  | { kind: "yes"; path: "demo" | "own" }
  | { kind: "interactive"; path?: "demo" | "own" };

/**
 * Resolve `grane setup` flags. `--import <dir>` is non-interactive
 * load/validate/inspect and never pins (activation stays TTY-only).
 */
export function resolveSetupInvocation(options: {
  import?: string;
  path?: string;
  yes?: boolean;
  nonInteractive?: boolean;
  activateOffline?: boolean;
}): SetupInvocation {
  const yes = Boolean(options.yes || options.nonInteractive);
  if (options.import !== undefined) {
    const dir = options.import.trim();
    if (!dir) throw new Error("--import requires a directory.");
    if (options.path) {
      throw new Error("--import cannot be combined with --path. Use --import <dir> alone.");
    }
    if (options.activateOffline) {
      throw new Error(
        "--activate-offline cannot be used with --import; non-interactive import never pins. Run `grane setup` from a terminal to activate.",
      );
    }
    return { kind: "import", dir };
  }
  const path = options.path;
  if (path !== undefined && path !== "demo" && path !== "own") {
    throw new Error(`Unknown --path "${path}". Use demo or own.`);
  }
  if (yes) {
    if (path !== "demo" && path !== "own") {
      throw new Error("Non-interactive setup requires --path demo or --path own, or --import <dir>.");
    }
    return { kind: "yes", path };
  }
  return { kind: "interactive", path };
}

/**
 * `--filter` accepts `field=value`, `field!=value` and `field<>value`. The
 * field is everything before the first operator, so a `=`, `!` or `<>` inside
 * the value is kept verbatim (`status=a=b` → field `status`, value `a=b`).
 * Only operators the kernel already compiles are recognised.
 */
export function parseFilterSpec(expr: string): QueryFilter {
  const match = /^([^=!<>]+)(!=|<>|=)(.*)$/s.exec(expr);
  if (!match) {
    throw new Error(`Invalid --filter "${expr}"; use field=value, field!=value or field<>value.`);
  }
  const [, field, op, value] = match as unknown as [string, string, string, string];
  return { field, operator: op === "=" ? "=" : "!=", value };
}
