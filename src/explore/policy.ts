import type { ExplorationConfig, GraneConfig } from "../config/schema.js";
import { parseColumnRef, formatColumnRef } from "../model/refs.js";
import type { DatabaseSchema } from "../connectors/types.js";

export interface ExplorationPolicy {
  enabled: boolean;
  /** Lowercased schema names agents may read. Empty = any introspected schema. */
  schemas: string[];
  /** Lowercased table.column denylist. */
  exclude: Set<string>;
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
    schemas: schemas.map((s) => s.toLowerCase()),
    exclude: new Set(exploration.exclude.map(normaliseRef)),
  };
}

export function normaliseRef(input: string): string {
  const ref = parseColumnRef(input);
  return (ref ? formatColumnRef(ref) : input.trim()).toLowerCase();
}

export function isExcluded(policy: ExplorationPolicy, table: string, column: string): boolean {
  return policy.exclude.has(`${table}.${column}`.toLowerCase());
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
