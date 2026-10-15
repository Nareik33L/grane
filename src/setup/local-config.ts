import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configError } from "../errors.js";

/** User-local UI preference. Not project YAML, not `.grane/active.json`. */
export type SetupTone = "technical" | "plain";

export const LOCAL_GRANE_CONFIG_REL = ".grane/config.json";

export interface LocalGraneConfig {
  /** Wording/verbosity for setup and later MCP authoring (V2-18). */
  setup_tone?: SetupTone;
}

export function localGraneConfigPath(homeDir: string): string {
  return join(homeDir, LOCAL_GRANE_CONFIG_REL);
}

export function isSetupTone(value: unknown): value is SetupTone {
  return value === "technical" || value === "plain";
}

function lstatOrNull(path: string) {
  try {
    return lstatSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function assertRegularUserGraneDir(dir: string): void {
  const st = lstatOrNull(dir);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw configError(
      `Refusing ${dir}: must be a regular directory, not a symlink or special file.`,
    );
  }
}

function assertRegularUserConfigFile(file: string): void {
  const st = lstatOrNull(file);
  if (!st) return;
  if (st.isSymbolicLink() || !st.isFile()) {
    throw configError(
      `Refusing ${file}: must be a regular file, not a symlink or special file.`,
    );
  }
}

/**
 * Parse an existing user-local config for a merge. Missing file → `{}`.
 * Invalid JSON / non-object is a hard refuse so we never overwrite it.
 */
function parseExistingLocalConfig(file: string): LocalGraneConfig {
  if (!lstatOrNull(file)) return {};
  assertRegularUserConfigFile(file);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw configError(
      `Refusing to overwrite ${file}: it is not valid JSON. Fix that file or delete it, then run setup again.`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw configError(
      `Refusing to overwrite ${file}: expected a JSON object. Fix that file or delete it, then run setup again.`,
    );
  }
  const parsed = raw as Record<string, unknown>;
  const out: LocalGraneConfig = { ...parsed };
  if (!isSetupTone(parsed.setup_tone)) delete out.setup_tone;
  return out;
}

/** lstat `~/.grane` and `config.json`; refuse symlinks and invalid JSON. */
export function assertLocalGraneConfigWritable(homeDir: string): void {
  const file = localGraneConfigPath(homeDir);
  const dir = dirname(file);
  assertRegularUserGraneDir(dir);
  assertRegularUserConfigFile(file);
  parseExistingLocalConfig(file);
}

/** Read `~/.grane/config.json`. Missing, invalid, or symlink files are ignored. */
export function readLocalGraneConfig(homeDir: string): LocalGraneConfig {
  const file = localGraneConfigPath(homeDir);
  const dir = dirname(file);
  const dirSt = lstatOrNull(dir);
  if (dirSt?.isSymbolicLink() || (dirSt && !dirSt.isDirectory())) return {};
  const fileSt = lstatOrNull(file);
  if (!fileSt || fileSt.isSymbolicLink() || !fileSt.isFile()) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const raw = parsed as Record<string, unknown>;
    const out: LocalGraneConfig = { ...raw };
    if (!isSetupTone(raw.setup_tone)) delete out.setup_tone;
    return out;
  } catch {
    return {};
  }
}

export function readSetupTone(homeDir: string): SetupTone | null {
  return readLocalGraneConfig(homeDir).setup_tone ?? null;
}

/**
 * Merge `setup_tone` into the user-local config. Never writes project YAML
 * or the active pin. Safe to call from setup and from MCP authoring (V2-18).
 * Refuses a symlinked `~/.grane` or `config.json`, and will not overwrite
 * invalid JSON. Write is temp-file + rename, mode `0600`.
 */
export function writeSetupTone(homeDir: string, tone: SetupTone): void {
  const file = localGraneConfigPath(homeDir);
  const dir = dirname(file);
  assertRegularUserGraneDir(dir);
  if (!lstatOrNull(dir)) mkdirSync(dir, { recursive: true });
  assertRegularUserGraneDir(dir);
  assertRegularUserConfigFile(file);
  const next: LocalGraneConfig = { ...parseExistingLocalConfig(file), setup_tone: tone };
  const body = `${JSON.stringify(next, null, 2)}\n`;
  const tmp = join(
    dir,
    `.config-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.json.tmp`,
  );
  try {
    writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
