import { randomBytes } from "node:crypto";
import type { Scalar, LimitsConfig } from "../config/schema.js";
import type { CompiledQuery } from "../compile/compiler.js";
import type { WarehouseConnector } from "../connectors/types.js";
import { unsafeQuery } from "../errors.js";

export interface Provenance {
  query_id: string;
  trust: "governed";
  query_model: "v1";
  metrics: Record<string, { definition_version: string }>;
  generated_sql: string;
  params: Scalar[];
  executed_at: string;
  row_count: number;
  duration_ms: number;
}

export interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  provenance: Provenance;
}

const WRITE_KEYWORDS =
  /^\s*(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do)\b/i;

export function newQueryId(): string {
  return `q_${randomBytes(6).toString("hex")}`;
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
  const provenance: Provenance = {
    query_id: newQueryId(),
    trust: "governed",
    query_model: "v1",
    metrics: Object.fromEntries(
      Object.entries(compiled.metricVersions).map(([name, version]) => [
        name,
        { definition_version: version },
      ]),
    ),
    generated_sql: compiled.sql,
    params: compiled.params,
    executed_at: new Date(startedAt).toISOString(),
    row_count: rows.length,
    duration_ms: Date.now() - startedAt,
  };
  return { columns: result.columns, rows, provenance };
}
