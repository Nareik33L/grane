import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoDuckdbSql } from "./paths.js";

type DuckDbConnection = {
  run?: (sql: string) => Promise<unknown>;
  runAndReadAll?: (sql: string) => Promise<unknown>;
  closeSync?: () => void;
  disconnectSync?: () => void;
};

type DuckDbInstance = {
  connect: () => Promise<DuckDbConnection>;
};

type DuckDbMod = {
  DuckDBInstance: {
    create: (path?: string) => Promise<DuckDbInstance>;
  };
};

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
 */
export async function buildDemoWarehouse(sqlPath = demoDuckdbSql()): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as DuckDbMod;
  const dir = mkdtempSync(join(tmpdir(), "grane-demo-"));
  const path = join(dir, "warehouse.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  try {
    const sql = readFileSync(sqlPath, "utf8");
    if (typeof conn.run === "function") {
      await conn.run(sql);
    } else if (typeof conn.runAndReadAll === "function") {
      await conn.runAndReadAll(sql);
    } else {
      throw new Error("DuckDB connection cannot execute SQL.");
    }
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  } finally {
    conn.closeSync?.();
    conn.disconnectSync?.();
  }
  return path;
}
