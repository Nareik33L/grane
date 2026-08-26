/**
 * Benchmark plumbing: the DuckDB example shop, a UTC-pinned Grane kernel, and
 * the three path runners (A: naive SQL, B: SKILL.md SQL, C: Grane Query Model).
 */

process.env.TZ = "UTC";

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { GraneError } from "../../src/errors.js";
import { DuckDbConnector } from "../../src/connectors/duckdb.js";
import { addDays, formatDate, resolveRelativeRange, type DateRange } from "../../src/query/time.js";
import type { SemanticQueryInput, TrustLevel } from "../../src/query/model.js";
import type { LimitsConfig } from "../../src/config/schema.js";
import { analyzeSql, type SqlAnalysis } from "./sql.js";

const here = dirname(fileURLToPath(import.meta.url));
export const EXAMPLE_DIR = join(here, "../../example/analytics-duckdb");
export const WAREHOUSE_PATH = join(EXAMPLE_DIR, "warehouse.duckdb");

export async function duckdbAvailable(): Promise<boolean> {
  if (!existsSync(WAREHOUSE_PATH)) return false;
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}

const LIMITS: LimitsConfig = { max_rows: 10000, default_rows: 1000, timeout_ms: 30000 };

/** Raw SQL executor for gold / path A / path B fixtures. */
export function rawWarehouse(): {
  run: (sql: string) => Promise<Record<string, unknown>[]>;
  close: () => Promise<void>;
} {
  const connector = new DuckDbConnector({
    type: "duckdb",
    path: WAREHOUSE_PATH,
    schema: "main",
  } as never);
  return {
    async run(sql: string) {
      const result = await connector.query(sql, [], LIMITS);
      return result.rows;
    },
    close: () => connector.close(),
  };
}

/** The example shop kernel, with the project timezone pinned to UTC for scoring. */
export function benchmarkKernel(): GraneKernel {
  const { config, projectDir } = loadConfig(EXAMPLE_DIR);
  config.project.timezone = "UTC";
  return new GraneKernel(config, { projectDir });
}

// ---------------------------------------------------------------------------
// Time windows
// ---------------------------------------------------------------------------

export interface BenchTime {
  /** The "today" the whole run is anchored to. */
  anchor: string;
  lastMonth: DateRange;
  last30d: DateRange;
  last6m: DateRange;
}

/** Inclusive end date -> exclusive upper bound, matching Grane's compiler. */
export function exclusiveEnd(date: string): string {
  return formatDate(
    addDays(
      {
        year: Number(date.slice(0, 4)),
        month: Number(date.slice(5, 7)),
        day: Number(date.slice(8, 10)),
      },
      1,
    ),
  );
}

/**
 * Anchor relative periods to the newest timestamp in the warehouse rather than
 * wall-clock now. The example database is seeded relative to its build time, so
 * anchoring to the data keeps the benchmark repeatable and keeps "last month"
 * populated however long after the build it runs.
 */
export async function resolveBenchTime(
  run: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<BenchTime> {
  const rows = await run(
    `SELECT max(greatest(created_at, coalesce(completed_at, created_at))) AS newest FROM orders`,
  );
  const newest = rows[0]?.["newest"];
  const now = newest instanceof Date ? newest : new Date(String(newest));
  return {
    anchor: formatDate({
      year: now.getUTCFullYear(),
      month: now.getUTCMonth() + 1,
      day: now.getUTCDate(),
    }),
    lastMonth: resolveRelativeRange("last_month", "UTC", now),
    last30d: resolveRelativeRange("30d", "UTC", now),
    last6m: resolveRelativeRange("6m", "UTC", now),
  };
}

// ---------------------------------------------------------------------------
// Result values
// ---------------------------------------------------------------------------

export type Cell = string | number | boolean | null;

/** Rows reduced to positional cells, so paths may alias columns differently. */
export type Table = Cell[][];

function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object" && "toString" in value) {
    const text = String(value);
    const asNumber = Number(text);
    return Number.isFinite(asNumber) && text.trim() !== "" ? asNumber : text;
  }
  return String(value);
}

export function toTable(rows: Record<string, unknown>[]): Table {
  return rows.map((row) => Object.values(row).map(normalizeCell));
}

function rowKey(row: Cell[]): string {
  return JSON.stringify(row.map((c) => (typeof c === "number" ? c.toFixed(4) : c)));
}

/** Order-insensitive comparison; money is compared to the penny. */
export function tablesMatch(actual: Table, expected: Table, tolerance = 0.005): boolean {
  if (actual.length !== expected.length) return false;
  const sortedActual = [...actual].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  const sortedExpected = [...expected].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
  for (let i = 0; i < sortedActual.length; i += 1) {
    const a = sortedActual[i]!;
    const e = sortedExpected[i]!;
    if (a.length !== e.length) return false;
    for (let j = 0; j < a.length; j += 1) {
      const left = a[j];
      const right = e[j];
      if (typeof left === "number" && typeof right === "number") {
        const scale = Math.max(1, Math.abs(right));
        if (Math.abs(left - right) > Math.max(tolerance, scale * 1e-9)) return false;
      } else if (left !== right) {
        return false;
      }
    }
  }
  return true;
}

export function formatTable(table: Table, max = 3): string {
  const shown = table.slice(0, max).map((row) => row.map((c) => (c === null ? "NULL" : String(c))).join(" | "));
  const suffix = table.length > max ? ` (+${table.length - max} more rows)` : "";
  return `${shown.join(" ; ")}${suffix}`;
}

// ---------------------------------------------------------------------------
// Path execution
// ---------------------------------------------------------------------------

export type Outcome =
  | { kind: "answered"; table: Table; analysis: SqlAnalysis; trust?: TrustLevel }
  | { kind: "refused"; status: string; message: string }
  | { kind: "error"; message: string };

/** Run a handwritten SQL fixture (path A or path B). */
export async function runSqlPath(
  run: (sql: string) => Promise<Record<string, unknown>[]>,
  sql: string,
): Promise<Outcome> {
  try {
    const rows = await run(sql);
    return { kind: "answered", table: toTable(rows), analysis: analyzeSql(sql) };
  } catch (err) {
    return { kind: "error", message: (err as Error).message };
  }
}

/** Run a Grane Query Model v1 request (path C). */
export async function runGranePath(
  kernel: GraneKernel,
  query: SemanticQueryInput,
): Promise<Outcome> {
  try {
    const result = await kernel.query(query);
    return {
      kind: "answered",
      table: toTable(result.rows),
      analysis: analyzeSql(result.provenance.generated_sql, result.provenance.params),
      trust: result.trust,
    };
  } catch (err) {
    if (err instanceof GraneError) {
      return { kind: "refused", status: err.refusal.status, message: err.refusal.message };
    }
    return { kind: "error", message: (err as Error).message };
  }
}

export { GraneError };
