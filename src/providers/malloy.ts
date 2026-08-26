import { relative } from "node:path";
import { configError } from "../errors.js";
import type { SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import { isDir, isFile, readText, simpleColumn, specRoot, sqlRef, tableName, walkFiles } from "./helpers.js";

/**
 * A Malloy subset Grane can compile: `source: name is table('t') extend { … }`
 * with simple dimensions, sum/count/avg/min/max measures, and `join_one`.
 * Unsupported Malloy (SQL blocks, nested queries, arbitrary expressions) is
 * skipped with a warning — Grane still compiles SQL itself.
 */

const AGG: Record<string, "sum" | "count" | "count_distinct" | "avg" | "min" | "max"> = {
  sum: "sum",
  count: "count",
  avg: "avg",
  average: "avg",
  min: "min",
  max: "max",
  count_distinct: "count_distinct",
};

function extractBrace(text: string, openAt: number): string | null {
  if (text[openAt] !== "{") return null;
  let depth = 1;
  let i = openAt + 1;
  while (i < text.length && depth > 0) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") depth -= 1;
    i += 1;
  }
  return text.slice(openAt + 1, i - 1);
}

interface MalloySource {
  name: string;
  table: string;
  body: string;
}

function parseSources(text: string): MalloySource[] {
  const sources: MalloySource[] = [];
  const re =
    /source:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(?:[A-Za-z_][\w.]*\.)?table\s*\(\s*['"]([^'"]+)['"]\s*\)\s+extend\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const openAt = match.index + match[0].length - 1;
    const body = extractBrace(text, openAt);
    if (body === null) continue;
    sources.push({ name: match[1]!, table: tableName(match[2], match[1]!), body });
  }
  return sources;
}

export function loadMalloyProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root) throw configError(`Malloy connector needs path/project pointing at a .malloy file or folder.`);
  const out = emptyContribution();
  const files = isFile(root) ? [root] : walkFiles(root, (name) => /\.malloy$/i.test(name));
  const tables = new Map<string, string>();
  const pks = new Map<string, string>();

  const parsedFiles: { rel: string; sources: MalloySource[] }[] = [];
  for (const file of files) {
    const rel = isDir(root) ? relative(root, file) : file;
    const text = readText(file);
    const sources = parseSources(text);
    if (sources.length === 0 && /\bsource\s*:/.test(text)) {
      out.warnings.push(
        `Malloy file ${rel} has source: blocks Grane could not bind to table('…') extend { … }. ` +
          `Export Ossie, Cube YAML, or Grane fragment maps for richer Malloy.`,
      );
    }
    parsedFiles.push({ rel, sources });
    for (const src of sources) {
      const pkMatch = src.body.match(/primary_key:\s*([A-Za-z_][A-Za-z0-9_]*)/);
      const pk = pkMatch?.[1] ?? "id";
      tables.set(src.name, src.table);
      pks.set(src.name, pk);
      out.entities[src.name] = withSource(
        { table: src.table, primary_key: pk },
        { provider: "malloy", path: rel },
      );
    }
  }

  for (const { rel, sources } of parsedFiles) {
    const source = { provider: "malloy" as const, path: rel };
    for (const src of sources) {
      const pk = pks.get(src.name) ?? "id";

      const dimRe = /dimension:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      let dim: RegExpExecArray | null;
      while ((dim = dimRe.exec(src.body))) {
        const dimName = dim[1]!;
        const column = simpleColumn(dim[2], dimName);
        if (!column || column === pk) continue;
        let published = dimName;
        if (published in out.dimensions) published = `${src.name}_${dimName}`;
        out.dimensions[published] = withSource(
          { entity: src.name, sql: sqlRef(src.table, column) },
          source,
        );
      }

      const measureRe =
        /measure:\s*([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(?:([A-Za-z_][A-Za-z0-9_]*)\.(sum|count|avg|average|min|max|count_distinct)\(\s*\)|(sum|count|avg|average|min|max|count_distinct)\(\s*([A-Za-z_][A-Za-z0-9_*]*)?\s*\)|count\(\s*\))/gi;
      let measure: RegExpExecArray | null;
      while ((measure = measureRe.exec(src.body))) {
        const name = measure[1]!;
        const dottedCol = measure[2];
        const dottedAgg = measure[3];
        const fnAgg = measure[4];
        const fnCol = measure[5];
        const aggRaw = (dottedAgg ?? fnAgg ?? "count").toLowerCase();
        const agg = AGG[aggRaw];
        if (!agg) {
          out.warnings.push(`Skipping Malloy measure "${src.name}.${name}": aggregation "${aggRaw}" is not supported.`);
          continue;
        }
        const column =
          simpleColumn(dottedCol ?? (fnCol && fnCol !== "*" ? fnCol : undefined), agg === "count" ? pk : name) ??
          (agg === "count" ? pk : null);
        if (!column) {
          out.warnings.push(`Skipping Malloy measure "${src.name}.${name}": not a simple column aggregate.`);
          continue;
        }
        let published = name;
        if (published in out.metrics) published = `${src.name}_${name}`;
        out.metrics[published] = withSource(
          { entity: src.name, type: agg, sql: sqlRef(src.table, column), status: "approved" as const, synonyms: [] },
          source,
        );
      }

      const joinRe =
        /join_one:\s*([A-Za-z_][A-Za-z0-9_]*)(?:\s+is\s+([A-Za-z_][A-Za-z0-9_]*))?\s+on\s+([A-Za-z_][A-Za-z0-9_]*)/g;
      let join: RegExpExecArray | null;
      while ((join = joinRe.exec(src.body))) {
        const toName = join[2] ?? join[1]!;
        const fromCol = join[3]!;
        const toTable = tables.get(toName) ?? toName;
        const toPk = pks.get(toName) ?? "id";
        const key = `${src.table}_to_${toTable}`;
        if (key in out.relationships) continue;
        out.relationships[key] = withSource(
          { from: `${src.table}.${fromCol}`, to: `${toTable}.${toPk}`, type: "many_to_one" },
          source,
        );
      }
    }
  }

  if (Object.keys(out.entities).length === 0) {
    out.warnings.push(`Malloy connector found no table() sources under ${spec.path ?? spec.project ?? root}.`);
  }
  return out;
}
