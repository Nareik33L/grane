import { randomBytes } from "node:crypto";
import type { Scalar, LimitsConfig } from "../config/schema.js";
import type { CompiledQuery } from "../compile/compiler.js";
import type { WarehouseConnector } from "../connectors/types.js";
import { unsafeQuery } from "../errors.js";
import type { TrustLevel } from "../query/model.js";

export interface Provenance {
  query_id: string;
  trust: TrustLevel;
  query_model: "v1";
  governed: string[];
  ungoverned: string[];
  warning: string | null;
  metrics: Record<string, { definition_version: string; source?: { provider: string; path?: string } }>;
  generated_sql: string;
  params: Scalar[];
  executed_at: string;
  row_count: number;
  duration_ms: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  trust: TrustLevel;
  governed: string[];
  ungoverned: string[];
  warning: string | null;
  provenance: Provenance;
}

const WRITE_KEYWORDS =
  /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do)\b/i;

/**
 * Read-only execution policy. Mutation tests flip `refuseWrites` to prove
 * the Gauntlet detects a disabled write guard. Production code must leave
 * this `true`.
 */
export const executionPolicy = {
  refuseWrites: true,
};

export function isWriteSql(sql: string): boolean {
  return WRITE_KEYWORDS.test(sql);
}

export function newQueryId(): string {
  return `q_${randomBytes(6).toString("hex")}`;
}

export async function executeCompiled(
  connector: WarehouseConnector,
  compiled: CompiledQuery,
  limits: LimitsConfig,
): Promise<QueryResult> {
  if (executionPolicy.refuseWrites && isWriteSql(compiled.sql)) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
  const startedAt = Date.now();
  const result = await connector.query(compiled.sql, compiled.params, limits);
  const rows = result.rows.slice(0, limits.max_rows);
  const provenance: Provenance = {
    query_id: newQueryId(),
    trust: compiled.trust,
    query_model: "v1",
    governed: compiled.governed,
    ungoverned: compiled.ungoverned,
    warning: compiled.warning,
    metrics: Object.fromEntries(
      Object.entries(compiled.metricVersions).map(([name, version]) => [
        name,
        {
          definition_version: version,
          ...(compiled.metricSources[name] ? { source: compiled.metricSources[name] } : {}),
        },
      ]),
    ),
    generated_sql: compiled.sql,
    params: compiled.params,
    executed_at: new Date(startedAt).toISOString(),
    row_count: rows.length,
    duration_ms: Date.now() - startedAt,
  };
  return {
    columns: result.columns,
    rows,
    trust: compiled.trust,
    governed: compiled.governed,
    ungoverned: compiled.ungoverned,
    warning: compiled.warning,
    provenance,
  };
}
