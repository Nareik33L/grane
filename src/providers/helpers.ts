import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ProviderContext } from "./types.js";

export const SKIP_DIRS = new Set([
  "target",
  "dbt_packages",
  "logs",
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "macros",
  "tests",
  "analyses",
  "snapshots",
  "dist",
  "build",
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function resolveFrom(ctx: ProviderContext, path: string | undefined): string | undefined {
  if (!path) return undefined;
  return isAbsolute(path) ? path : resolve(ctx.projectDir, path);
}

export function isFile(path: string | undefined): path is string {
  return Boolean(path && existsSync(path) && statSync(path).isFile());
}

export function isDir(path: string | undefined): path is string {
  return Boolean(path && existsSync(path) && statSync(path).isDirectory());
}

export function specRoot(
  spec: { path?: string; project?: string; file?: string; semantic_manifest?: string },
  ctx: ProviderContext,
): string | undefined {
  return (
    resolveFrom(ctx, spec.path) ??
    resolveFrom(ctx, spec.project) ??
    resolveFrom(ctx, spec.file) ??
    resolveFrom(ctx, spec.semantic_manifest)
  );
}

/** Last identifier in `schema.table` or `db.schema.table`. */
export function tableName(source: string | undefined, fallback: string): string {
  if (!source) return fallback;
  const cleaned = source.replace(/["'`[\]]/g, "").trim();
  const parts = cleaned.split(".").filter(Boolean);
  return parts[parts.length - 1] ?? fallback;
}

const SIMPLE_COLUMN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function simpleColumn(expr: string | undefined | null, fallback?: string): string | null {
  const value = (expr ?? fallback ?? "").trim();
  if (!value) return null;
  if (value === "1" || value === "*") return fallback && SIMPLE_COLUMN.test(fallback) ? fallback : "id";
  if (SIMPLE_COLUMN.test(value)) return value;
  const qualified = value.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
  return qualified ? qualified[2]! : null;
}

export function sqlRef(table: string, column: string): string {
  return `\${${table}.${column}}`;
}

export interface AggExpr {
  type: "sum" | "count" | "count_distinct" | "avg" | "min" | "max";
  table?: string;
  column: string;
}

export function parseAggExpression(expr: string): AggExpr | null {
  const text = expr.replace(/\s+/g, " ").trim();
  const match = text.match(
    /^(sum|count|avg|average|min|max)\s*\(\s*(distinct\s+)?([^)]+?)\s*\)$/i,
  );
  if (!match) return null;
  const fn = match[1]!.toLowerCase();
  const distinct = Boolean(match[2]);
  const inner = match[3]!.trim();
  let type: AggExpr["type"];
  if (fn === "average") type = "avg";
  else if (fn === "count" && distinct) type = "count_distinct";
  else type = fn as AggExpr["type"];
  if (inner === "*" || inner === "1") {
    return type === "count" || type === "count_distinct" ? { type, column: "id" } : null;
  }
  const qual = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/);
  if (qual) return { type, table: qual[1], column: qual[2]! };
  const col = simpleColumn(inner);
  return col ? { type, column: col } : null;
}

export function walkFiles(root: string, test: (name: string, rel: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        visit(path);
      } else if (entry.isFile() && test(entry.name, rel)) {
        out.push(path);
      }
    }
  };
  if (isFile(root)) return test(root, root) ? [root] : [];
  if (isDir(root)) visit(root);
  return out.sort();
}

export function walkYamlFiles(root: string): string[] {
  return walkFiles(root, (name) => /\.ya?ml$/i.test(name) && name !== "dbt_project.yml");
}

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}
