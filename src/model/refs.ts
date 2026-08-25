/**
 * Column references in Grane configuration use the form `${table.column}`.
 * A bare `table.column` is also accepted where a reference is expected.
 */

export interface ColumnRef {
  table: string;
  column: string;
}

const WRAPPED = /^\$\{\s*([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}$/;
const BARE = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/;

export function parseColumnRef(input: string): ColumnRef | null {
  const trimmed = input.trim();
  const match = WRAPPED.exec(trimmed) ?? BARE.exec(trimmed);
  if (!match) return null;
  return { table: match[1]!, column: match[2]! };
}

export function formatColumnRef(ref: ColumnRef): string {
  return `${ref.table}.${ref.column}`;
}
