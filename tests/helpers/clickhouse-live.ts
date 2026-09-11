/**
 * Shared live-ClickHouse helpers for the certification corpus.
 *
 * URL: GRANE_CLICKHOUSE_URL, then default:grane at 127.0.0.1:8123.
 */
import { clickhouseQuerySettings } from "../../src/connectors/clickhouse.js";
import { executedRowsFromClickHouseJson } from "../../src/connectors/result-meta.js";
import type { ExecutedRows } from "../../src/connectors/types.js";

const WRITE_CANDIDATES = [
  process.env.GRANE_CLICKHOUSE_URL,
  process.env.GRANE_CLICKHOUSE_WRITE_URL,
  "http://default:grane@127.0.0.1:8123",
  "http://grane:grane@127.0.0.1:8123",
  "http://127.0.0.1:8123",
].filter((u): u is string => Boolean(u));

export interface ClickHouseLiveEnv {
  url: string;
  version: string;
  timezone: string;
}

let cached: ClickHouseLiveEnv | null = null;
let probeFailed = false;

type ChClient = {
  query: (opts: Record<string, unknown>) => Promise<{ json: <T = unknown>() => Promise<T> }>;
  command: (opts: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
};

type ChMod = {
  createClient: (opts: Record<string, unknown>) => ChClient;
};

async function loadClickHouse(): Promise<ChMod | null> {
  try {
    return (await import("@clickhouse/client")) as unknown as ChMod;
  } catch {
    return null;
  }
}

export function newClickhouseCertDatabase(): string {
  return `chcert_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function createClickHouseClient(url: string, database?: string): Promise<ChClient> {
  const mod = await loadClickHouse();
  if (!mod) throw new Error("@clickhouse/client is required for the ClickHouse certification adapter");
  return mod.createClient({
    url,
    database,
    request_timeout: 30_000,
    clickhouse_settings: {
      session_timezone: "UTC",
    },
  });
}

export async function clickhouseLiveEnv(): Promise<ClickHouseLiveEnv | null> {
  if (cached) return cached;
  if (probeFailed) return null;
  const mod = await loadClickHouse();
  if (!mod) {
    probeFailed = true;
    return null;
  }
  for (const url of WRITE_CANDIDATES) {
    const client = mod.createClient({ url, request_timeout: 2000 });
    try {
      const result = await client.query({
        query: "SELECT version() AS version, timezone() AS tz",
        format: "JSON",
      });
      const payload = await result.json<{ data?: { version: string; tz: string }[] }>();
      const row = payload.data?.[0];
      if (!row) continue;
      cached = { url, version: row.version, timezone: row.tz };
      return cached;
    } catch {
      // try next candidate
    } finally {
      await client.close().catch(() => undefined);
    }
  }
  probeFailed = true;
  return null;
}

export async function clickhouseExec(
  client: ChClient,
  sql: string,
  params?: unknown[],
  settings?: Record<string, string | number>,
): Promise<ExecutedRows> {
  const query_params: Record<string, unknown> = {};
  (params ?? []).forEach((value, i) => {
    query_params[`p${i + 1}`] = value;
  });
  const result = await client.query({
    query: sql,
    query_params,
    format: "JSON",
    clickhouse_settings: settings,
  });
  const payload = await result.json<unknown>();
  return executedRowsFromClickHouseJson(payload, 100_000);
}

export const CLICKHOUSE_WRITE_SETTINGS: Record<string, string | number> = {
  mutations_sync: "1",
  session_timezone: "UTC",
  join_use_nulls: "1",
};

export function clickhouseReadSettings(timeoutMs = 30_000): Record<string, string | number> {
  return clickhouseQuerySettings(timeoutMs);
}
