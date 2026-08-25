import { randomBytes } from "node:crypto";
import type pg from "pg";
import type { Scalar, LimitsConfig } from "../config/schema.js";
import type { CompiledQuery } from "../compile/compiler.js";
import { unsafeQuery } from "../errors.js";

/**
 * Read-only execution with provenance.
 *
 * Every statement runs inside a READ ONLY transaction with a statement
 * timeout and a pinned UTC session timezone, so results are deterministic and
 * the database itself rejects any write. The connected database user should
 * additionally be granted SELECT only — the database remains the final
 * security boundary.
 */

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
  pool: pg.Pool,
  compiled: CompiledQuery,
  limits: LimitsConfig,
): Promise<QueryResult> {
  if (WRITE_KEYWORDS.test(compiled.sql)) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }

  const client = await pool.connect();
  const startedAt = Date.now();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query(`SET LOCAL statement_timeout = ${Math.floor(limits.timeout_ms)}`);
    await client.query("SET LOCAL TIME ZONE 'UTC'");
    const result = await client.query<Record<string, unknown>>(compiled.sql, compiled.params);
    await client.query("COMMIT");

    const rows = result.rows.slice(0, limits.max_rows) as Record<string, unknown>[];
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
    return {
      columns: result.fields.map((f) => f.name),
      rows,
      provenance,
    };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Connection may already be unusable; releasing below is sufficient.
    }
    throw err;
  } finally {
    client.release();
  }
}
