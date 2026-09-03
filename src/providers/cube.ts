import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { configError } from "../errors.js";
import type { MetricFilterItem, SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import {
  asArray,
  bool,
  isDir,
  isFile,
  isRecord,
  metricFilters,
  parseAggExpression,
  parseLiteral,
  readText,
  simpleColumn,
  specRoot,
  sqlRef,
  str,
  tableName,
  walkFiles,
  walkYamlFiles,
} from "./helpers.js";

/** `{CUBE}.col`, `{CUBE.col}`, `{other}.col`, `{other.col}` → cube + column. */
function cubeIdent(raw: string, cubeName: string): { cube: string; column: string } | null {
  const cubeField = raw.match(/^\{\s*CUBE\.(\w+)\s*\}$/i);
  if (cubeField) return { cube: cubeName, column: cubeField[1]! };
  const cubeDot = raw.match(/^\{\s*CUBE\s*\}\.(\w+)$/i);
  if (cubeDot) return { cube: cubeName, column: cubeDot[1]! };
  const otherField = raw.match(/^\{\s*(\w+)\.(\w+)\s*\}$/);
  if (otherField) return { cube: otherField[1]!, column: otherField[2]! };
  const otherDot = raw.match(/^\{\s*(\w+)\s*\}\.(\w+)$/);
  if (otherDot) return { cube: otherDot[1]!, column: otherDot[2]! };
  return null;
}

function parseJoinSql(
  sql: string,
  cubeName: string,
  cubeTable: string,
): { from: string; to: string } | null {
  const text = sql.replace(/\s+/g, " ").trim();
  const parts = text.split(/\s*=\s*/);
  if (parts.length !== 2) return null;
  const left = cubeIdent(parts[0]!.trim(), cubeName);
  const right = cubeIdent(parts[1]!.trim(), cubeName);
  if (!left || !right) return null;
  const leftTable = left.cube === cubeName ? cubeTable : left.cube;
  const rightTable = right.cube === cubeName ? cubeTable : right.cube;
  return { from: `${leftTable}.${left.column}`, to: `${rightTable}.${right.column}` };
}

/**
 * Cube measure `filters: [{ sql: "{CUBE}.status = 'completed'" }]` → Grane
 * metric filters. Only same-cube `=` / `!=` / `<>` against a literal, joined
 * by `and`, is translated; anything else returns null so the measure is
 * skipped rather than imported without its filter.
 */
function parseCubeFilterSql(sql: string, cubeName: string, cubeTable: string): MetricFilterItem[] | null {
  const text = sql.replace(/\s+/g, " ").trim();
  if (!text || /\bor\b/i.test(text)) return null;
  const items: MetricFilterItem[] = [];
  for (const part of text.split(/\s+and\s+/i)) {
    const match = part.trim().match(/^(.+?)\s*(!=|<>|=)\s*(.+)$/);
    if (!match) return null;
    const ident = cubeIdent(match[1]!.trim(), cubeName);
    if (!ident || ident.cube !== cubeName) return null;
    const value = parseLiteral(match[3]!);
    if (value === undefined) return null;
    items.push({ field: `${cubeTable}.${ident.column}`, operator: match[2] === "=" ? "=" : "!=", value });
  }
  return items;
}

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

function jsField(body: string, key: string): string | undefined {
  const match = body.match(new RegExp(`${key}\\s*:\\s*[\`'"]([^\\\`'"]*)[\`'"]`));
  return match?.[1];
}

function jsBool(body: string, key: string): boolean {
  return new RegExp(`${key}\\s*:\\s*true\\b`).test(body);
}

/** `filters: [{ sql: \`${CUBE}.status = 'completed'\` }]` → the sql strings, `${X}` normalised to `{X}`. */
function jsFilterSqls(body: string): { sql: string }[] {
  const match = body.match(/filters\s*:\s*\[/);
  if (!match || match.index === undefined) return [];
  let depth = 1;
  let i = match.index + match[0].length;
  const start = i;
  while (i < body.length && depth > 0) {
    if (body[i] === "[") depth += 1;
    else if (body[i] === "]") depth -= 1;
    i += 1;
  }
  const inner = body.slice(start, i - 1);
  const out: { sql: string }[] = [];
  const re = /sql\s*:\s*(`|'|")((?:\\.|(?!\1)[^\\])*)\1/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(inner))) {
    out.push({ sql: hit[2]!.replace(/\$\{([^}]+)\}/g, "{$1}") });
  }
  return out;
}

function jsNamedObjects(body: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(body))) {
    const openAt = match.index + match[0].length - 1;
    const inner = extractBrace(body, openAt);
    if (inner === null) continue;
    out.push({ name: match[1]!, body: inner });
    re.lastIndex = openAt + inner.length + 1;
  }
  return out;
}

function jsSection(body: string, key: string): string | null {
  const match = body.match(new RegExp(`${key}\\s*:\\s*\\{`));
  if (!match || match.index === undefined) return null;
  return extractBrace(body, match.index + match[0].length - 1);
}

/** Parse cube('name', { ... }) JavaScript. Never evals. */
export function parseCubeJavaScript(text: string): Record<string, unknown>[] {
  const cubes: Record<string, unknown>[] = [];
  const re = /cube\s*\(\s*([`'"])([^`'"]+)\1\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const after = match.index + match[0].length;
    const openAt = text.indexOf("{", after);
    if (openAt < 0) continue;
    const body = extractBrace(text, openAt);
    if (body === null) continue;
    const name = match[2]!;
    const sqlTable = jsField(body, "sql_table") ?? jsField(body, "sql_table_name");
    const sql = jsField(body, "sql");
    const dimensions = jsNamedObjects(jsSection(body, "dimensions") ?? "").map((d) => ({
      name: d.name,
      sql: jsField(d.body, "sql") ?? d.name,
      type: jsField(d.body, "type"),
      primary_key: jsBool(d.body, "primary_key"),
      title: jsField(d.body, "title"),
    }));
    const measures = jsNamedObjects(jsSection(body, "measures") ?? "").map((m) => ({
      name: m.name,
      sql: jsField(m.body, "sql"),
      type: jsField(m.body, "type") ?? "count",
      title: jsField(m.body, "title"),
      filters: jsFilterSqls(m.body),
    }));
    const joins = jsNamedObjects(jsSection(body, "joins") ?? "").map((j) => ({
      name: j.name,
      sql: (jsField(j.body, "sql") ?? "").replace(/\$\{([^}]+)\}/g, "{$1}"),
      relationship: jsField(j.body, "relationship"),
    }));
    cubes.push({
      name,
      sql_table: sqlTable,
      sql,
      description: jsField(body, "description") ?? jsField(body, "title"),
      dimensions,
      measures,
      joins,
    });
  }
  return cubes;
}

const CUBE_AGG: Record<string, "sum" | "count" | "count_distinct" | "avg" | "min" | "max"> = {
  sum: "sum",
  count: "count",
  countdistinct: "count_distinct",
  count_distinct: "count_distinct",
  avg: "avg",
  average: "avg",
  min: "min",
  max: "max",
};

export function loadCubeProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root || (!isDir(root) && !isFile(root))) {
    throw configError(`Cube connector needs path/project pointing at a Cube schema directory or YAML file.`);
  }
  const out = emptyContribution();
  const files = isFile(root)
    ? [root]
    : [...walkYamlFiles(root), ...walkFiles(root, (name) => /\.js$/i.test(name))];
  const cubes: { name: string; table: string; path: string }[] = [];

  const docs: { rel: string; doc: Record<string, unknown> }[] = [];
  for (const file of files) {
    const rel = isDir(root) ? relative(root, file) : file;
    if (/\.js$/i.test(file)) {
      const parsed = parseCubeJavaScript(readText(file));
      if (parsed.length > 0) docs.push({ rel, doc: { cubes: parsed } });
      continue;
    }
    let doc: unknown;
    try {
      doc = parseYaml(readText(file));
    } catch (err) {
      out.warnings.push(`Skipped ${file}: ${(err as Error).message}`);
      continue;
    }
    if (isRecord(doc)) docs.push({ rel, doc });
  }

  for (const { rel, doc } of docs) {
    for (const cube of asArray(doc.cubes)) {
      if (!isRecord(cube)) continue;
      const name = str(cube.name);
      if (!name) continue;
      const table = tableName(str(cube.sql_table) ?? str(cube.sql_table_name), name);
      if (cube.sql && !cube.sql_table) {
        out.warnings.push(
          `Cube "${name}" uses a SQL subquery rather than sql_table; Grane binds it to table "${table}".`,
        );
      }
      const source = { provider: "cube", path: rel };
      const pkDim = asArray(cube.dimensions).find((d) => isRecord(d) && bool(d.primary_key));
      const pk = isRecord(pkDim) ? simpleColumn(str(pkDim.sql), str(pkDim.name) ?? "id") : "id";
      out.entities[name] = withSource(
        { table, primary_key: pk ?? "id", description: str(cube.description) ?? str(cube.title) },
        source,
      );
      cubes.push({ name, table, path: rel });

      for (const dim of asArray(cube.dimensions)) {
        if (!isRecord(dim)) continue;
        const dimName = str(dim.name);
        if (!dimName || bool(dim.primary_key)) continue;
        const column = simpleColumn(str(dim.sql), dimName);
        if (!column) {
          out.warnings.push(`Skipping Cube dimension "${name}.${dimName}": sql is not a simple column.`);
          continue;
        }
        let published = dimName;
        if (published in out.dimensions && out.dimensions[published]!.sql !== sqlRef(table, column)) {
          published = `${name}_${dimName}`;
        }
        const dimType = str(dim.type)?.toLowerCase();
        out.dimensions[published] = withSource(
          {
            description: str(dim.description) ?? str(dim.title),
            entity: name,
            sql: sqlRef(table, column),
            type: dimType === "time" ? "timestamp" : dimType === "number" ? "number" : dimType === "boolean" ? "boolean" : "string",
          },
          source,
        );
      }

      for (const measure of asArray(cube.measures)) {
        if (!isRecord(measure)) continue;
        const measureName = str(measure.name);
        const aggRaw = (str(measure.type) ?? "").replace(/_/g, "").toLowerCase();
        const agg = CUBE_AGG[str(measure.type)?.toLowerCase() ?? ""] ?? CUBE_AGG[aggRaw];
        if (!measureName || !agg) {
          if (measureName) {
            out.warnings.push(`Skipping Cube measure "${name}.${measureName}": type "${str(measure.type)}" is not supported.`);
          }
          continue;
        }
        const parsed = str(measure.sql) ? parseAggExpression(str(measure.sql)!) : null;
        const column =
          parsed?.column ??
          simpleColumn(str(measure.sql), agg === "count" ? pk ?? "id" : measureName) ??
          (agg === "count" ? pk ?? "id" : null);
        if (!column) {
          out.warnings.push(`Skipping Cube measure "${name}.${measureName}": sql is not a simple column.`);
          continue;
        }
        const filterItems: MetricFilterItem[] = [];
        let filtersOk = true;
        for (const filter of asArray(measure.filters)) {
          const filterSql = isRecord(filter) ? str(filter.sql) : undefined;
          const translated = filterSql ? parseCubeFilterSql(filterSql, name, table) : null;
          if (!translated) {
            out.warnings.push(
              `Skipping Cube measure "${name}.${measureName}": filter ${JSON.stringify(filterSql ?? filter)} is not a ` +
                `simple {CUBE}.column = 'value' condition. Grane will not import the measure without its filter.`,
            );
            filtersOk = false;
            break;
          }
          filterItems.push(...translated);
        }
        if (!filtersOk) continue;
        let published = measureName;
        if (published in out.metrics) published = `${name}_${measureName}`;
        const timeDim = asArray(cube.dimensions).find((d) => isRecord(d) && str(d.type)?.toLowerCase() === "time");
        const timeCol = isRecord(timeDim) ? simpleColumn(str(timeDim.sql), str(timeDim.name)) : null;
        out.metrics[published] = withSource(
          {
            description: str(measure.description) ?? str(measure.title),
            entity: name,
            type: agg,
            sql: sqlRef(parsed?.table ?? table, column),
            time_dimension: timeCol ? sqlRef(table, timeCol) : undefined,
            filters: metricFilters(filterItems),
            synonyms: str(measure.title) && str(measure.title) !== measureName ? [str(measure.title)!] : [],
            status: "approved" as const,
          },
          source,
        );
      }
    }
  }

  for (const { rel, doc } of docs) {
    for (const cube of asArray(doc.cubes)) {
      if (!isRecord(cube)) continue;
      const name = str(cube.name);
      if (!name) continue;
      const self = cubes.find((c) => c.name === name);
      if (!self) continue;
      for (const join of asArray(cube.joins)) {
        if (!isRecord(join)) continue;
        const parsed = str(join.sql) ? parseJoinSql(str(join.sql)!, name, self.table) : null;
        const relTypeRaw = (str(join.relationship) ?? "many_to_one")
          .toLowerCase()
          .replace(/belongs_to/, "many_to_one")
          .replace(/belongsto/, "many_to_one")
          .replace(/has_many/, "one_to_many")
          .replace(/hasmany/, "one_to_many")
          .replace(/has_one/, "one_to_one")
          .replace(/hasone/, "one_to_one");
        const relType =
          relTypeRaw === "one_to_many" || relTypeRaw === "one_to_one" || relTypeRaw === "many_to_one"
            ? relTypeRaw
            : "many_to_one";
        if (!parsed) {
          out.warnings.push(`Skipping Cube join on "${name}": could not parse sql "${str(join.sql)}".`);
          continue;
        }
        const key = str(join.name)
          ? `${name}_to_${str(join.name)}`
          : `${parsed.from.split(".")[0]}_to_${parsed.to.split(".")[0]}`;
        if (key in out.relationships) continue;
        out.relationships[key] = withSource(
          { from: parsed.from, to: parsed.to, type: relType },
          { provider: "cube", path: rel },
        );
      }
    }
  }

  if (cubes.length === 0) {
    out.warnings.push(`Cube connector found no cubes under ${spec.path ?? spec.project ?? root}.`);
  }
  return out;
}
