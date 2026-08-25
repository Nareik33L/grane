import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ColumnUsage {
  count: number;
  last_used: string;
}

export interface UsageStore {
  columns: Record<string, ColumnUsage>;
}

function usagePath(projectDir: string): string {
  return join(projectDir, ".grane", "usage.json");
}

export function readUsage(projectDir: string): UsageStore {
  const path = usagePath(projectDir);
  if (!existsSync(path)) return { columns: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UsageStore;
    if (!parsed || typeof parsed !== "object" || !parsed.columns) return { columns: {} };
    return parsed;
  } catch {
    return { columns: {} };
  }
}

export function recordRawUsage(projectDir: string, columns: string[]): void {
  if (columns.length === 0) return;
  const store = readUsage(projectDir);
  const now = new Date().toISOString();
  for (const column of columns) {
    const existing = store.columns[column];
    store.columns[column] = {
      count: (existing?.count ?? 0) + 1,
      last_used: now,
    };
  }
  const dir = join(projectDir, ".grane");
  mkdirSync(dir, { recursive: true });
  writeFileSync(usagePath(projectDir), JSON.stringify(store, null, 2) + "\n");
}

export function usageRanked(projectDir: string): { column: string; count: number; last_used: string }[] {
  const store = readUsage(projectDir);
  return Object.entries(store.columns)
    .map(([column, usage]) => ({ column, count: usage.count, last_used: usage.last_used }))
    .sort((a, b) => b.count - a.count || a.column.localeCompare(b.column));
}
