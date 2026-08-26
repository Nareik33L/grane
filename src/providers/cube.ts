import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { configError } from "../errors.js";
import type { SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import {
  asArray,
  bool,
  isDir,
  isFile,
  isRecord,
  parseAggExpression,
  readText,
  simpleColumn,
  specRoot,
  sqlRef,
  str,
  tableName,
  walkYamlFiles,
} from "./helpers.js";

function parseJoinSql(
  sql: string,
  cubeName: string,
  cubeTable: string,
): { from: string; to: string } | null {
  const text = sql.replace(/\s+/g, " ").trim();
  const ident = (raw: string): { cube: string; column: string } | null => {
    const cubeField = raw.match(/^\{\s*CUBE\.(\w+)\s*\}$/i);
    if (cubeField) return { cube: cubeName, column: cubeField[1]! };
    const cubeDot = raw.match(/^\{\s*CUBE\s*\}\.(\w+)$/i);
    if (cubeDot) return { cube: cubeName, column: cubeDot[1]! };
    const otherField = raw.match(/^\{\s*(\w+)\.(\w+)\s*\}$/);
    if (otherField) return { cube: otherField[1]!, column: otherField[2]! };
    const otherDot = raw.match(/^\{\s*(\w+)\s*\}\.(\w+)$/);
    if (otherDot) return { cube: otherDot[1]!, column: otherDot[2]! };
    return null;
  };
  const parts = text.split(/\s*=\s*/);
  if (parts.length !== 2) return null;
  const left = ident(parts[0]!.trim());
  const right = ident(parts[1]!.trim());
  if (!left || !right) return null;
  const leftTable = left.cube === cubeName ? cubeTable : left.cube;
  const rightTable = right.cube === cubeName ? cubeTable : right.cube;
  return { from: `${leftTable}.${left.column}`, to: `${rightTable}.${right.column}` };
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
  const files = isFile(root) ? [root] : walkYamlFiles(root);
  const cubes: { name: string; table: string; path: string }[] = [];

  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseYaml(readText(file));
    } catch (err) {
      out.warnings.push(`Skipped ${file}: ${(err as Error).message}`);
      continue;
    }
    if (!isRecord(doc)) continue;
    const rel = isDir(root) ? relative(root, file) : file;
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
            synonyms: str(measure.title) && str(measure.title) !== measureName ? [str(measure.title)!] : [],
            status: "approved" as const,
          },
          source,
        );
      }
    }
  }

  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseYaml(readText(file));
    } catch {
      continue;
    }
    if (!isRecord(doc)) continue;
    const rel = isDir(root) ? relative(root, file) : file;
    for (const cube of asArray(doc.cubes)) {
      if (!isRecord(cube)) continue;
      const name = str(cube.name);
      if (!name) continue;
      const self = cubes.find((c) => c.name === name);
      if (!self) continue;
      for (const join of asArray(cube.joins)) {
        if (!isRecord(join)) continue;
        const parsed = str(join.sql) ? parseJoinSql(str(join.sql)!, name, self.table) : null;
        const relTypeRaw = (str(join.relationship) ?? "many_to_one").toLowerCase().replace(/belongs_to/, "many_to_one").replace(/has_many/, "one_to_many").replace(/has_one/, "one_to_one");
        const relType =
          relTypeRaw === "one_to_many" || relTypeRaw === "one_to_one" || relTypeRaw === "many_to_one"
            ? relTypeRaw
            : "many_to_one";
        if (!parsed) {
          out.warnings.push(`Skipping Cube join on "${name}": could not parse sql "${str(join.sql)}".`);
          continue;
        }
        const key = str(join.name) ? `${name}_to_${str(join.name)}` : `${parsed.from.split(".")[0]}_to_${parsed.to.split(".")[0]}`;
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
