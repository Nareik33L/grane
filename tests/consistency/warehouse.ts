/**
 * Demo-shop backends for the consistency suite.
 *
 * DuckDB: the same seed as `npx grane demo` (`demo/seed/duckdb.sql`).
 * Postgres: isolated schema loaded from `demo/seed/01_schema.sql` + `02_data.sql`
 * on the certified CI Postgres (or a reachable local candidate). Never writes
 * into `public`.
 *
 * Path (b) executes SQL through the warehouse driver (`pg` / `@duckdb/node-api`),
 * not through GraneKernel or a Grane connector.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import type { ConnectionConfig } from "../../src/config/schema.js";
import { demoAnalyticsDir } from "../../src/demo/paths.js";
import { buildDemoWarehouse, duckdbDriverAvailable } from "../../src/demo/warehouse.js";
import { loadDuckDbModule } from "../../src/demo/duckdb.js";
import { namedQuarterRange, resolveRelativeRange, todayInTimeZone } from "../../src/query/time.js";
import {
  ensureReadonlyRole,
  grantReadonlyOnSchema,
  postgresLiveEnv,
} from "../helpers/postgres-live.js";
import type { TimeWindows } from "./questions.js";

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../../demo/seed/01_schema.sql", import.meta.url)), "utf8").replace(
  /\nCREATE ROLE[\s\S]*$/,
  "\n",
);

const DATA_SQL = readFileSync(fileURLToPath(new URL("../../demo/seed/02_data.sql", import.meta.url)), "utf8").replace(
  /GRANT SELECT ON ALL TABLES IN SCHEMA public TO grane_readonly;\s*/g,
  "",
);

export type RawExecutor = (sql: string) => Promise<Record<string, unknown>[]>;

export interface ConsistencyBackend {
  engine: "duckdb" | "postgres";
  engineVersion: string;
  kernel: GraneKernel;
  runRaw: RawExecutor;
  close: () => Promise<void>;
}

export async function duckdbAvailable(): Promise<boolean> {
  return duckdbDriverAvailable();
}

export async function postgresAvailable(): Promise<boolean> {
  return (await postgresLiveEnv()) !== null;
}

export function postgresRequired(): boolean {
  const require = (process.env.GRANE_CERT_REQUIRE ?? "").split(",").map((s) => s.trim().toLowerCase());
  if (require.includes("postgres")) return true;
  if (process.env.GRANE_CONSISTENCY_REQUIRE_POSTGRES === "1") return true;
  return Boolean(process.env.CI && process.env.GRANE_PG_WRITE_URL);
}

/**
 * Anchor relative periods to the newest order timestamp in the warehouse,
 * not wall-clock now. The demo seed is CURRENT_DATE-relative, so this keeps
 * last_month populated however long after the build the suite runs.
 */
export async function resolveAnchorTime(run: RawExecutor): Promise<{ now: Date; time: TimeWindows }> {
  const rows = await run(
    `SELECT max(greatest(created_at, coalesce(completed_at, created_at))) AS newest FROM orders`,
  );
  const newest = rows[0]?.["newest"];
  const now = newest instanceof Date ? newest : new Date(String(newest));
  if (Number.isNaN(now.getTime())) {
    throw new Error(`Could not resolve warehouse anchor time from ${String(newest)}`);
  }
  const today = todayInTimeZone("UTC", now);
  return {
    now,
    time: {
      lastMonth: resolveRelativeRange("last_month", "UTC", now),
      last30d: resolveRelativeRange("30d", "UTC", now),
      lastQuarter: resolveRelativeRange("last_quarter", "UTC", now),
      q2: namedQuarterRange(2, today),
    },
  };
}

function demoKernel(connection: ConnectionConfig, now: Date): GraneKernel {
  const { config, projectDir } = loadConfig(demoAnalyticsDir());
  config.project.timezone = "UTC";
  config.connection = connection;
  return new GraneKernel(config, { projectDir, now });
}

export async function openDuckdbBackend(): Promise<ConsistencyBackend> {
  const { path } = await buildDemoWarehouse();
  const mod = await loadDuckDbModule();
  let instance: Awaited<ReturnType<typeof mod.DuckDBInstance.create>>;
  try {
    instance = await mod.DuckDBInstance.create(path, { access_mode: "READ_ONLY", TimeZone: "UTC" });
  } catch {
    instance = await mod.DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
  }
  const conn = await instance.connect();
  try {
    await conn.runAndReadAll("SET TimeZone = 'UTC'");
  } catch {
    // Instance-level TimeZone pin is enough.
  }

  const runRaw: RawExecutor = async (sql) => {
    const reader = (await conn.runAndReadAll(sql)) as {
      getRowObjectsJS?: () => Record<string, unknown>[];
      getRowObjects?: () => Record<string, unknown>[];
    };
    return reader.getRowObjectsJS?.() ?? reader.getRowObjects?.() ?? [];
  };

  const versionRows = await runRaw("SELECT version() AS version");
  const { now } = await resolveAnchorTime(runRaw);
  const kernel = demoKernel({ type: "duckdb", path, schema: "main" }, now);

  return {
    engine: "duckdb",
    engineVersion: String(versionRows[0]?.["version"] ?? "duckdb"),
    kernel,
    runRaw,
    async close() {
      await kernel.close();
      conn.closeSync?.();
      conn.disconnectSync?.();
    },
  };
}

function newConsistencySchema(): string {
  const runid = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  return `grane_cons_${runid}`;
}

export async function openPostgresBackend(): Promise<ConsistencyBackend> {
  const live = await postgresLiveEnv();
  if (!live) throw new Error("PostgreSQL live environment is not available");
  await ensureReadonlyRole(live.writeUrl);
  const schemaName = newConsistencySchema();
  const writePool = new pg.Pool({ connectionString: live.writeUrl });
  const client = await writePool.connect();
  try {
    await client.query(`CREATE SCHEMA ${schemaName}`);
    await client.query(`SET search_path TO ${schemaName}`);
    await client.query("SET TIME ZONE 'UTC'");
    await client.query(SCHEMA_SQL);
    await client.query(DATA_SQL);
  } finally {
    client.release();
  }
  await grantReadonlyOnSchema(writePool, schemaName);

  const readPool = new pg.Pool({ connectionString: live.readUrl });
  const runRaw: RawExecutor = async (sql) => {
    const readClient = await readPool.connect();
    try {
      await readClient.query(`SET search_path TO ${schemaName}`);
      await readClient.query("SET TIME ZONE 'UTC'");
      const result = await readClient.query<Record<string, unknown>>(sql);
      return result.rows;
    } finally {
      readClient.release();
    }
  };

  const versionRows = await runRaw("SELECT version() AS version");
  const { now } = await resolveAnchorTime(runRaw);
  const kernel = demoKernel({ type: "postgres", url: live.readUrl, schema: schemaName }, now);

  return {
    engine: "postgres",
    engineVersion: String(versionRows[0]?.["version"] ?? live.version),
    kernel,
    runRaw,
    async close() {
      await kernel.close();
      await readPool.end().catch(() => undefined);
      await writePool.query(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`).catch(() => undefined);
      await writePool.end().catch(() => undefined);
    },
  };
}
