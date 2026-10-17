/** Order-insensitive numeric comparison of Grane rows vs independent SQL rows. */

export type Cell = string | number | boolean | null;
export type Table = Cell[][];

function asFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(trimmed)) return null;
    const n = Number(trimmed);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof value === "object" && value !== null && "toString" in value) {
    return asFiniteNumber(String(value));
  }
  return null;
}

export function normalizeCell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const n = asFiniteNumber(value);
  if (n !== null) return n;
  if (typeof value === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
    return value;
  }
  return String(value);
}

export function toTable(rows: Record<string, unknown>[]): Table {
  return rows.map((row) => Object.values(row).map(normalizeCell));
}

function rowKey(row: Cell[]): string {
  return JSON.stringify(row.map((c) => (typeof c === "number" ? c.toFixed(4) : c)));
}

/** Order-insensitive; money compared to the penny. */
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

/** Stable row order for previews (same key as tablesMatch). */
export function orderTable(table: Table): Table {
  return [...table].sort((a, b) => rowKey(a).localeCompare(rowKey(b)));
}

export function formatTable(table: Table, max = 8): string {
  const shown = orderTable(table)
    .slice(0, max)
    .map((row) => row.map((c) => (c === null ? "NULL" : String(c))).join(" | "));
  const suffix = table.length > max ? ` (+${table.length - max} more rows)` : "";
  return `${shown.join(" ; ")}${suffix}`;
}

export function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replaceAll('"', '""')}"`;
  return value;
}

export function tableNonEmpty(table: Table | undefined): boolean {
  return Boolean(table && table.length > 0);
}

/** True when at least one cell is a non-null, non-zero, non-empty value. */
export function tableNonTrivial(table: Table | undefined): boolean {
  if (!tableNonEmpty(table)) return false;
  return table!.some((row) =>
    row.some((c) => {
      if (c === null || c === false || c === "") return false;
      if (typeof c === "number") return c !== 0;
      return true;
    }),
  );
}
