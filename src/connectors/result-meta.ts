import type { ExecutedRows } from "./types.js";

/**
 * ClickHouse `FORMAT JSON` envelope. `JSONEachRow` has no column metadata
 * when `data` is empty; the envelope's `meta` still lists selected columns.
 */
export function executedRowsFromClickHouseJson(payload: unknown, maxRows: number): ExecutedRows {
  if (Array.isArray(payload)) {
    const rows = (payload as Record<string, unknown>[]).slice(0, maxRows);
    return { columns: Object.keys(rows[0] ?? {}), rows };
  }
  const envelope = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const data = Array.isArray(envelope.data) ? (envelope.data as Record<string, unknown>[]) : [];
  const rows = data.slice(0, maxRows);
  const meta = Array.isArray(envelope.meta) ? envelope.meta : [];
  const columns = meta
    .map((col) => {
      if (!col || typeof col !== "object") return "";
      return String((col as { name?: unknown }).name ?? "");
    })
    .filter(Boolean);
  return {
    columns: columns.length > 0 ? columns : Object.keys(rows[0] ?? {}),
    rows,
  };
}

/**
 * Databricks `IOperation.getSchema()` (Hive `TTableSchema`). Column names
 * survive an empty `fetchAll()`.
 */
export function columnsFromDatabricksSchema(schema: unknown): string[] {
  if (!schema || typeof schema !== "object") return [];
  const columns = (schema as { columns?: unknown }).columns;
  if (!Array.isArray(columns)) return [];
  return columns
    .map((col) => {
      if (!col || typeof col !== "object") return "";
      const rec = col as Record<string, unknown>;
      const name = rec.columnName ?? rec.name ?? rec.COLUMN_NAME;
      return name == null ? "" : String(name);
    })
    .filter(Boolean);
}

export function executedRowsFromDatabricks(
  rows: Record<string, unknown>[],
  schema: unknown,
  maxRows: number,
): ExecutedRows {
  const sliced = rows.slice(0, maxRows);
  const columns = columnsFromDatabricksSchema(schema);
  return {
    columns: columns.length > 0 ? columns : Object.keys(sliced[0] ?? {}),
    rows: sliced,
  };
}
