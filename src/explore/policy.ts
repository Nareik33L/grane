import type { ExplorationConfig, ExplorationMode, GraneConfig } from "../config/schema.js";
import { parseColumnRef, formatColumnRef } from "../model/refs.js";
import type { DatabaseSchema } from "../connectors/types.js";

export interface ExplorationPolicy {
  enabled: boolean;
  mode: ExplorationMode;
  /** Lowercased schema names agents may read. Empty = any introspected schema. */
  schemas: string[];
  /** Include patterns (allowlist mode). Lowercased. */
  include: string[];
  /** Exclude patterns (global + per-agent). Lowercased. Always applied. */
  exclude: string[];
}

export function explorationPolicy(config: GraneConfig): ExplorationPolicy {
  const exploration: ExplorationConfig = config.exploration;
  const connectionSchema = config.connection.schema;
  const schemas =
    exploration.schemas.length > 0
      ? exploration.schemas
      : connectionSchema
        ? [connectionSchema]
        : [];
  return {
    enabled: exploration.enabled,
    mode: exploration.mode,
    schemas: schemas.map((s) => s.toLowerCase()),
    include: exploration.include.map(normalisePattern),
    exclude: exploration.exclude.map(normalisePattern),
  };
}

export function normaliseRef(input: string): string {
  const ref = parseColumnRef(input);
  return (ref ? formatColumnRef(ref) : input.trim()).toLowerCase();
}

export function normalisePattern(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * `customers.*`, `*.email`, `*_ssn`. A pattern with a dot is table.column;
 * otherwise it matches the column name on any table.
 */
export function matchColumnPattern(pattern: string, table: string, column: string): boolean {
  const p = normalisePattern(pattern);
  if (!p) return false;
  const t = table.toLowerCase();
  const c = column.toLowerCase();
  const dot = p.indexOf(".");
  if (dot === -1) {
    return globMatch(p, c);
  }
  return globMatch(p.slice(0, dot), t) && globMatch(p.slice(dot + 1), c);
}

export function matchesAnyPattern(patterns: string[], table: string, column: string): boolean {
  return patterns.some((pattern) => matchColumnPattern(pattern, table, column));
}

/** Whether a config entry is an exact table.column or a supported glob. */
export function isExplorationPattern(entry: string): boolean {
  const trimmed = entry.trim();
  if (!trimmed) return false;
  if (parseColumnRef(trimmed)) return true;
  if (/^[A-Za-z0-9_*]+\.[A-Za-z0-9_*]+$/.test(trimmed)) return true;
  return /^[A-Za-z0-9_*]*\*[A-Za-z0-9_*]*$/.test(trimmed);
}

/**
 * A column is explorable when it is not excluded, and in allowlist mode when
 * it also matches include. Empty include in allowlist mode matches nothing.
 */
export function isExplorable(policy: ExplorationPolicy, table: string, column: string): boolean {
  if (matchesAnyPattern(policy.exclude, table, column)) return false;
  if (policy.mode === "allowlist") {
    return policy.include.length > 0 && matchesAnyPattern(policy.include, table, column);
  }
  return true;
}

export function isExcluded(policy: ExplorationPolicy, table: string, column: string): boolean {
  return !isExplorable(policy, table, column);
}

export function isSchemaAllowed(policy: ExplorationPolicy, schemaName: string | null | undefined): boolean {
  if (policy.schemas.length === 0) return true;
  if (!schemaName) return true;
  return policy.schemas.includes(schemaName.toLowerCase());
}

export function tableSchemaName(schema: DatabaseSchema, table: string): string | null {
  const match = schema.tables.find((t) => t.name === table);
  return match?.schema ?? null;
}

function globMatch(glob: string, value: string): boolean {
  if (!glob.includes("*")) return glob === value;
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}
