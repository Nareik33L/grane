import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { ResolvedLaunch } from "./types.js";

/**
 * Prefer launching the same Grane binary the user just ran (node + CLI script)
 * so desktop agents do not depend on `grane` being on PATH.
 */
export function resolveGraneLaunch(opts: {
  argv?: string[];
  execPath?: string;
  overrideCommand?: string;
} = {}): ResolvedLaunch {
  if (opts.overrideCommand) {
    return { command: opts.overrideCommand, prefixArgs: [], source: "override" };
  }

  const argv = opts.argv ?? process.argv;
  const execPath = opts.execPath ?? process.execPath;
  const script = argv[1];
  if (!script) {
    return { command: "grane", prefixArgs: [], source: "path" };
  }

  const resolved = resolve(script);
  const distFromSrc = distCliFromSource(resolved);
  if (distFromSrc && existsSync(distFromSrc)) {
    return { command: execPath, prefixArgs: [distFromSrc], source: "dist" };
  }

  if (existsSync(resolved) && isJsEntry(resolved)) {
    return { command: execPath, prefixArgs: [resolved], source: "argv" };
  }

  if (existsSync(resolved) && resolved.endsWith(".ts")) {
    return { command: execPath, prefixArgs: [resolved], source: "argv" };
  }

  return { command: "grane", prefixArgs: [], source: "path" };
}

function distCliFromSource(script: string): string | null {
  const normalized = script.replaceAll("\\", "/");
  if (!normalized.endsWith("src/cli/index.ts")) return null;
  return resolve(join(dirname(script), "..", "..", "dist", "cli", "index.js"));
}

function isJsEntry(path: string): boolean {
  return path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs");
}

export function stdioArgs(launch: ResolvedLaunch, projectDir: string): string[] {
  return [...launch.prefixArgs, "-p", resolve(projectDir), "serve", "--stdio"];
}

export function connectionEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of [
    "DATABASE_URL",
    "GRANE_EXAMPLE_DATABASE_URL",
    "GRANE_TEST_DATABASE_URL",
    "PGHOST",
    "PGPORT",
    "PGUSER",
    "PGPASSWORD",
    "PGDATABASE",
  ]) {
    const value = env[key];
    if (value) out[key] = value;
  }
  return out;
}

export function looksLikeSecret(value: string): boolean {
  return /:\/\/[^/\s]+:[^/\s]+@/.test(value);
}

export function childEnv(extra?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) out[key] = value;
  }
  return extra ? { ...out, ...extra } : out;
}
