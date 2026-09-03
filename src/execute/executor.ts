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
 * A many_to_one relationship promises that the joined key is unique in the
 * target table. The compiled statement measures that promise against the keys
 * that actually participate in this execution's analytical population.
 *
 * Guard semantics (post-wrapper):
 *   NULL  → no relevant FK values in the population (empty pop or all NULLs)
 *           → safe; no violation is possible.
 *   1     → every participating key maps to exactly one target row → safe.
 *   > 1   → at least one participating key maps to multiple target rows;
 *           the join would multiply the matching facts → refuse.
 *
 * The wrapper (`__grane_card LEFT JOIN __grane_result ON TRUE`) guarantees
 * that the guard row is present even when the analytical GROUP BY produces
 * zero rows, so we never skip based on rows.length.
 */
function assertCardinality(compiled: CompiledQuery, rows: Record<string, unknown>[]): void {
  if (compiled.guards.length === 0) return;
  // The wrapper always returns at least one row when guards exist.
  // If somehow we get zero rows, treat every guard as unobserved → refuse.
  if (rows.length === 0) {
    const g = compiled.guards[0]!;
    throw unsafeQuery(
      `Cardinality guard for relationship "${g.relationship}" (table "${g.table}") produced no rows — ` +
        `the result cannot be trusted. This is a bug; please report it.`,
      { relationship: g.relationship, table: g.table },
    );
  }
  const first = rows[0]!;
  for (const guard of compiled.guards) {
    const raw = first[guard.column];
    // NULL means no relevant FK values → no violation possible → safe.
    if (raw === null || raw === undefined) continue;
    const observed = Number(raw);
    if (Number.isFinite(observed) && observed > 1) {
      throw unsafeQuery(
        `Relationship "${guard.relationship}" declares "${guard.keyColumn}" as the one side of a many_to_one join, ` +
          `but the warehouse holds up to ${observed} rows for a single "${guard.keyColumn}" value ` +
          `among the keys that participate in this query's analytical population. ` +
          `Joining "${guard.table}" would multiply the matching facts, so the result is refused. ` +
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
  let rows = result.rows.slice(0, limits.max_rows);
  assertCardinality(compiled, rows);
  const hidden = result.columns.filter((name) => name.startsWith(GUARD_PREFIX));
  const columns = result.columns.filter((name) => !name.startsWith(GUARD_PREFIX));
  for (const row of rows) {
    for (const name of hidden) delete row[name];
  }
  // When the wrapper (`__grane_card LEFT JOIN __grane_result ON TRUE`) produced
  // a single null-padding row because the analytical GROUP BY has zero rows,
  // strip it so callers see an empty result. Applies only when the query has
  // at least one dimension (grouped query); scalar queries (no dimensions) may
  // legitimately return a single all-null metrics row (SUM of empty set).
  if (compiled.guards.length > 0) {
    const metricNames = new Set(Object.keys(compiled.metricVersions));
    const dimCols = compiled.plan.columns.filter((c) => !metricNames.has(c));
    if (dimCols.length > 0) {
      // A wrapper-padding row has every analytical column null.
      const analyticalCols = compiled.plan.columns;
      rows = rows.filter((row) =>
        analyticalCols.some((c) => row[c] !== null && row[c] !== undefined),
      );
    }
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
