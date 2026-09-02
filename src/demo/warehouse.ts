import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { bundledDuckdbSeed } from "./paths.js";
import { loadDuckDbModule, splitSqlStatements } from "./duckdb.js";

const DEMO_TABLES = ["customers", "products", "orders", "order_items", "payments", "refunds"] as const;

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

/** Recreate a file-backed DuckDB warehouse from the bundled demo seed SQL. */
export async function buildDemoWarehouse(
  destPath: string,
  options: BuildWarehouseOptions | string = {},
): Promise<BuildWarehouseResult> {
  const opts: BuildWarehouseOptions = typeof options === "string" ? { sqlPath: options } : options;
  const sqlPath = opts.sqlPath ?? bundledDuckdbSeed();
  const sql = readFileSync(sqlPath, "utf8");
  const statements = splitSqlStatements(sql);
  if (statements.length === 0) {
    throw new Error(`Demo seed ${sqlPath} did not contain any SQL statements.`);
  }

  mkdirSync(dirname(destPath), { recursive: true });
  for (const leftover of [destPath, `${destPath}.wal`]) {
    if (existsSync(leftover)) rmSync(leftover, { force: true });
  }

  const mod = await loadDuckDbModule();
  const instance = await mod.DuckDBInstance.create(destPath);
  const conn = await instance.connect();
  try {
    for (const statement of statements) {
      await conn.runAndReadAll(statement);
    }
    if (opts.parquetDir) {
      mkdirSync(opts.parquetDir, { recursive: true });
      for (const table of DEMO_TABLES) {
        const parquet = join(opts.parquetDir, `${table}.parquet`).replaceAll("'", "''");
        await conn.runAndReadAll(`COPY ${table} TO '${parquet}' (FORMAT PARQUET, COMPRESSION ZSTD)`);
      }
    }
  } finally {
    conn.closeSync?.();
    conn.disconnectSync?.();
  }

  return { path: destPath, statements: statements.length, parquetDir: opts.parquetDir };
}
