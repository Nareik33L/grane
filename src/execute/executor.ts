import { randomBytes } from "node:crypto";
import type { Scalar, LimitsConfig } from "../config/schema.js";
import { GUARD_PREFIX, type CompiledQuery } from "../compile/compiler.js";
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

export function newQueryId(): string {
  return `q_${randomBytes(6).toString("hex")}`;
}

/**
 * A many_to_one relationship promises that the joined key is unique. The
 * compiled statement measures that promise against the data it actually read;
 * a duplicated key would have multiplied every fact that matched it, so the
 * result is refused instead of returned — Grane does not deduplicate or pick a
 * row on the warehouse's behalf.
 */
function assertCardinality(compiled: CompiledQuery, rows: Record<string, unknown>[]): void {
  if (compiled.guards.length === 0 || rows.length === 0) return;
  const first = rows[0]!;
  for (const guard of compiled.guards) {
    const observed = Number(first[guard.column] ?? 1);
    if (Number.isFinite(observed) && observed > 1) {
      throw unsafeQuery(
        `Relationship "${guard.relationship}" declares "${guard.keyColumn}" as the one side of a many_to_one join, ` +
          `but the warehouse holds up to ${observed} rows for a single "${guard.keyColumn}" value. ` +
          `Joining "${guard.table}" would multiply the facts that match those keys, so the result is refused. ` +
          `Fix the data or the relationship declaration; Grane will not deduplicate rows or pick one of them.`,
        { relationship: guard.relationship, table: guard.table, key_column: guard.keyColumn, max_rows_per_key: observed },
      );
    }
  }
}

export async function executeCompiled(
  connector: WarehouseConnector,
  compiled: CompiledQuery,
  limits: LimitsConfig,
): Promise<QueryResult> {
  if (WRITE_KEYWORDS.test(compiled.sql)) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
  const startedAt = Date.now();
  const result = await connector.query(compiled.sql, compiled.params, limits);
  const rows = result.rows.slice(0, limits.max_rows);
  assertCardinality(compiled, rows);
  const hidden = result.columns.filter((name) => name.startsWith(GUARD_PREFIX));
  const columns = result.columns.filter((name) => !name.startsWith(GUARD_PREFIX));
  for (const row of rows) {
    for (const name of hidden) delete row[name];
  }
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
    columns,
    rows,
    trust: compiled.trust,
    governed: compiled.governed,
    ungoverned: compiled.ungoverned,
    warning: compiled.warning,
    provenance,
  };
}
