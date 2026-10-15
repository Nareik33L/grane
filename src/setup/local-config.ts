import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

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

/** Read `~/.grane/config.json`. Missing or invalid files are ignored. */
export function readLocalGraneConfig(homeDir: string): LocalGraneConfig {
  const file = localGraneConfigPath(homeDir);
  if (!existsSync(file)) return {};
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
 */
export function writeSetupTone(homeDir: string, tone: SetupTone): void {
  const file = localGraneConfigPath(homeDir);
  mkdirSync(dirname(file), { recursive: true });
  const next: LocalGraneConfig = { ...readLocalGraneConfig(homeDir), setup_tone: tone };
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
}
