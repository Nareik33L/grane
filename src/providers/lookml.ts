import { relative } from "node:path";
import { configError } from "../errors.js";
import type { SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import { isDir, isFile, readText, simpleColumn, specRoot, sqlRef, tableName, walkFiles } from "./helpers.js";

const LOOKML_AGG: Record<string, "sum" | "count" | "count_distinct" | "avg" | "min" | "max"> = {
  sum: "sum",
  count: "count",
  count_distinct: "count_distinct",
  average: "avg",
  avg: "avg",
  min: "min",
  max: "max",
};

interface LookmlDim {
  name: string;
  sql: string;
  type?: string;
  primaryKey: boolean;
}

interface View {
  name: string;
  table: string;
  path: string;
  dimensions: LookmlDim[];
  measures: { name: string; type: string; sql?: string; filters?: string }[];
}

function extractBlocks(text: string, keyword: string): { name: string; body: string }[] {
  const results: { name: string; body: string }[] = [];
  const re = new RegExp(`${keyword}:\\s*([A-Za-z0-9_]+)\\s*\\{`, "g");
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const start = match.index + match[0].length;
    let depth = 1;
    let i = start;
    while (i < text.length && depth > 0) {
      if (text[i] === "{") depth += 1;
      else if (text[i] === "}") depth -= 1;
      i += 1;
    }
    results.push({ name: match[1]!, body: text.slice(start, i - 1) });
  }
  return results;
}

function parseLookml(text: string): { views: View[]; joins: { from: string; to: string; sqlOn: string; relationship: string }[] } {
  const views: View[] = [];
  const joins: { from: string; to: string; sqlOn: string; relationship: string }[] = [];
  for (const block of extractBlocks(text, "view")) {
    const tableMatch = block.body.match(/sql_table_name:\s*([^\s;]+)/);
    const table = tableName(tableMatch?.[1], block.name);
    const dimensions: View["dimensions"] = [];
    for (const dim of [...extractBlocks(block.body, "dimension"), ...extractBlocks(block.body, "dimension_group")]) {
      const sql = dim.body.match(/sql:\s*([^;]+);;/)?.[1]?.trim();
      const type = dim.body.match(/type:\s*([A-Za-z0-9_]+)/)?.[1];
      const primaryKey = /primary_key:\s*yes\b/i.test(dim.body);
      if (sql) dimensions.push({ name: dim.name, sql, type, primaryKey });
    }
    const measures: View["measures"] = [];
    for (const measure of extractBlocks(block.body, "measure")) {
      const type = measure.body.match(/type:\s*([A-Za-z0-9_]+)/)?.[1] ?? "count";
      const sql = measure.body.match(/sql:\s*([^;]+);;/)?.[1]?.trim();
      const filters = measure.body.match(/filters:\s*\[([^\]]+)\]/)?.[1];
      measures.push({ name: measure.name, type, sql, filters });
    }
    views.push({ name: block.name, table, path: "", dimensions, measures });
  }
  for (const block of extractBlocks(text, "explore")) {
    for (const join of extractBlocks(block.body, "join")) {
      const sqlOn = join.body.match(/sql_on:\s*([^;]+);;/)?.[1]?.trim() ?? "";
      const relationship = join.body.match(/relationship:\s*([A-Za-z0-9_]+)/)?.[1] ?? "many_to_one";
      joins.push({ from: block.name, to: join.name, sqlOn, relationship });
    }
  }
  return { views, joins };
}

function lookmlSqlColumn(sql: string, table: string): string | null {
  const cleaned = sql.replace(/\$\{TABLE\}/g, table).replace(/\s+/g, " ").trim();
  const tableCol = cleaned.match(/^\$\{?([A-Za-z0-9_]+)\}?\.([A-Za-z0-9_]+)$/);
  if (tableCol) return tableCol[2]!;
  const dotted = cleaned.match(/^([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)$/);
  if (dotted) return dotted[2]!;
  return simpleColumn(cleaned);
}

/** LookML `${view.field}` → warehouse `table.column`. */
function resolveLookmlIdent(views: View[], viewOrTable: string, field: string): string {
  const view = views.find((v) => v.name === viewOrTable || v.table === viewOrTable);
  if (!view) return `${viewOrTable}.${field}`;
  const dim = view.dimensions.find((d) => d.name === field);
  const column = dim ? (lookmlSqlColumn(dim.sql, view.table) ?? field) : field;
  return `${view.table}.${column}`;
}

function parseSqlOn(sqlOn: string, views: View[]): { from: string; to: string } | null {
  const text = sqlOn.replace(/\$\{/g, "").replace(/\}/g, "").replace(/\s+/g, " ");
  const match = text.match(/([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)\s*=\s*([A-Za-z0-9_]+)\.([A-Za-z0-9_]+)/);
  if (!match) return null;
  return {
    from: resolveLookmlIdent(views, match[1]!, match[2]!),
    to: resolveLookmlIdent(views, match[3]!, match[4]!),
  };
}

function viewPrimaryKey(view: View): string {
  const marked = view.dimensions.find((d) => d.primaryKey);
  const named = view.dimensions.find((d) => d.name === "id");
  const chosen = marked ?? named;
  if (!chosen) return "id";
  return lookmlSqlColumn(chosen.sql, view.table) ?? chosen.name;
}

export function loadLookmlProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root) throw configError(`LookML connector needs path/project pointing at a .lkml file or Looker project.`);
  const out = emptyContribution();
  const files = isFile(root)
    ? [root]
    : walkFiles(root, (name) => /\.(lkml|lookml)$/i.test(name));

  const views: View[] = [];
  const joins: { from: string; to: string; sqlOn: string; relationship: string; rel: string }[] = [];

  for (const file of files) {
    const rel = isDir(root) ? relative(root, file) : file;
    const parsed = parseLookml(readText(file));
    for (const view of parsed.views) {
      views.push({ ...view, path: rel });
    }
    for (const join of parsed.joins) {
      joins.push({ ...join, rel });
    }
  }

  for (const view of views) {
    const source = { provider: "lookml" as const, path: view.path };
    const pk = viewPrimaryKey(view);
    out.entities[view.name] = withSource({ table: view.table, primary_key: pk }, source);
    for (const dim of view.dimensions) {
      const column = lookmlSqlColumn(dim.sql, view.table);
      if (!column) {
        out.warnings.push(`Skipping LookML dimension "${view.name}.${dim.name}": sql "${dim.sql}" is not a simple column.`);
        continue;
      }
      if (column === pk || dim.primaryKey) continue;
      let published = dim.name;
      if (published in out.dimensions) published = `${view.name}_${dim.name}`;
      out.dimensions[published] = withSource(
        {
          entity: view.name,
          sql: sqlRef(view.table, column),
          type: dim.type === "time" || dim.type === "date" ? "timestamp" : dim.type === "number" ? "number" : dim.type === "yesno" ? "boolean" : "string",
        },
        source,
      );
    }
    for (const measure of view.measures) {
      const agg = LOOKML_AGG[measure.type];
      if (!agg) {
        out.warnings.push(`Skipping LookML measure "${view.name}.${measure.name}": type "${measure.type}" is not supported.`);
        continue;
      }
      const column = measure.sql ? lookmlSqlColumn(measure.sql, view.table) : pk;
      if (!column) {
        out.warnings.push(`Skipping LookML measure "${view.name}.${measure.name}": sql is not a simple column.`);
        continue;
      }
      let published = measure.name;
      if (published in out.metrics) published = `${view.name}_${measure.name}`;
      const filters: Record<string, string> = {};
      if (measure.filters) {
        for (const part of measure.filters.split(",")) {
          const [field, value] = part.split(":").map((s) => s.trim().replace(/^"+|"+$/g, ""));
          if (field && value) filters[`${view.table}.${field}`] = value;
        }
      }
      out.metrics[published] = withSource(
        {
          entity: view.name,
          type: agg,
          sql: sqlRef(view.table, column),
          filters: Object.keys(filters).length > 0 ? filters : undefined,
          status: "approved" as const,
          synonyms: [],
        },
        source,
      );
    }
  }

  for (const join of joins) {
    const parsedJoin = parseSqlOn(join.sqlOn, views);
    if (!parsedJoin) {
      out.warnings.push(`Skipping LookML join ${join.from} → ${join.to}: could not parse sql_on.`);
      continue;
    }
    const relType =
      join.relationship === "one_to_many" || join.relationship === "one_to_one" || join.relationship === "many_to_one"
        ? join.relationship
        : "many_to_one";
    out.relationships[`${join.from}_to_${join.to}`] = withSource(
      { from: parsedJoin.from, to: parsedJoin.to, type: relType },
      { provider: "lookml", path: join.rel },
    );
  }

  if (Object.keys(out.entities).length === 0) {
    out.warnings.push(`LookML connector found no views under ${spec.path ?? spec.project ?? root}.`);
  }
  return out;
}
