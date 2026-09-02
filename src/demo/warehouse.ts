import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { demoDuckdbSql } from "./paths.js";
import { loadDuckDbModule, splitSqlStatements } from "./duckdb.js";

const DEMO_TABLES = [
  "customers",
  "products",
  "orders",
  "order_items",
  "payments",
  "refunds",
  "subscriptions",
  "checkout_events",
  "support_tickets",
] as const;

export interface BuildWarehouseOptions {
  sqlPath?: string;
  /** When set, also export Parquet copies for Databricks / warehouse upload. */
  parquetDir?: string;
}

export interface BuildWarehouseResult {
  path: string;
  statements: number;
  parquetDir?: string;
}

export async function duckdbDriverAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}

/**
 * Materialise the demo shop into a DuckDB file. The connector opens warehouse
 * files read-only, so this uses a writable instance just for the load.
 *
 * Pass a destination path, or omit it to write a temp file (tests).
 */
export async function buildDemoWarehouse(
  destPath?: string,
  options: BuildWarehouseOptions = {},
): Promise<BuildWarehouseResult> {
  const sqlPath = options.sqlPath ?? demoDuckdbSql();
  const sql = readFileSync(sqlPath, "utf8");
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error(`Demo seed ${sqlPath} did not contain any SQL statements.`);
  }

  let path = destPath;
  if (!path) {
    const dir = mkdtempSync(join(tmpdir(), "grane-demo-"));
    path = join(dir, "warehouse.duckdb");
  }

  mkdirSync(dirname(path), { recursive: true });
  for (const leftover of [path, `${path}.wal`]) {
    if (existsSync(leftover)) rmSync(leftover, { force: true });
  }

  const mod = await loadDuckDbModule();
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    for (const statement of statements) {
      await conn.runAndReadAll(statement);
    }
    if (options.parquetDir) {
      mkdirSync(options.parquetDir, { recursive: true });
      for (const table of DEMO_TABLES) {
        const parquet = join(options.parquetDir, `${table}.parquet`).replaceAll("'", "''");
        await conn.runAndReadAll(`COPY ${table} TO '${parquet}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      }
    }
  } finally {
    conn.closeSync?.();
    conn.disconnectSync?.();
  }

  return { path, statements: statements.length, parquetDir: options.parquetDir };
}
