import { relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { configError } from "../errors.js";
import type { SemanticProviderConfig } from "../config/schema.js";
import type { ProviderContext, SemanticContribution } from "./types.js";
import { emptyContribution, withSource } from "./types.js";
import {
  asArray,
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
  walkFiles,
  walkYamlFiles,
} from "./helpers.js";

function dialectExpr(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  if (typeof value.expression === "string") return value.expression;
  const dialects = asArray(value.dialects);
  for (const preferred of ["ANSI_SQL", "ansi_sql", "GENERIC"]) {
    const hit = dialects.find((d) => isRecord(d) && str(d.dialect)?.toUpperCase() === preferred.toUpperCase());
    if (isRecord(hit) && str(hit.expression)) return str(hit.expression);
  }
  for (const d of dialects) {
    if (isRecord(d) && str(d.expression)) return str(d.expression);
  }
  return undefined;
}

function modelsFromDoc(doc: unknown): Record<string, unknown>[] {
  if (!isRecord(doc)) return [];
  if (Array.isArray(doc.semantic_model)) return doc.semantic_model.filter(isRecord);
  if (Array.isArray(doc.semantic_models)) return doc.semantic_models.filter(isRecord);
  if (isRecord(doc.semantic_model) && Array.isArray(doc.semantic_model.datasets)) {
    return [doc.semantic_model];
  }
  if (Array.isArray(doc.datasets)) return [doc];
  return [];
}

export function loadOssieProvider(spec: SemanticProviderConfig, ctx: ProviderContext): SemanticContribution {
  const root = specRoot(spec, ctx);
  if (!root) {
    throw configError(`Ossie connector needs path/project/file pointing at an Ossie YAML/JSON document.`);
  }
  const out = emptyContribution();
  const files = isFile(root)
    ? [root]
    : [
        ...walkYamlFiles(root),
        ...walkFiles(root, (name) => /\.json$/i.test(name) && /ossie|osi/i.test(name)),
      ];

  for (const file of files) {
    let doc: unknown;
    try {
      doc = file.endsWith(".json") ? JSON.parse(readText(file)) : parseYaml(readText(file));
    } catch (err) {
      out.warnings.push(`Skipped ${file}: ${(err as Error).message}`);
      continue;
    }
    const rel = isDir(root) ? relative(root, file) : file;
    for (const model of modelsFromDoc(doc)) {
      const source = { provider: "ossie" as const, path: rel };
      const datasetTables = new Map<string, string>();
      for (const dataset of asArray(model.datasets)) {
        if (!isRecord(dataset)) continue;
        const name = str(dataset.name);
        if (!name) continue;
        const table = tableName(str(dataset.source), name);
        datasetTables.set(name, table);
        const pkRaw = dataset.primary_key;
        const pkList = Array.isArray(pkRaw) ? pkRaw.map(str).filter(Boolean) : str(pkRaw) ? [str(pkRaw)] : [];
        if (pkList.length > 1) {
          out.warnings.push(
            `Ossie dataset "${name}" has a composite primary key; Grane using "${pkList[0]}" as the grain key.`,
          );
        }
        out.entities[name] = withSource(
          { table, primary_key: pkList[0] ?? "id", description: str(dataset.description) },
          source,
        );
        for (const field of asArray(dataset.fields)) {
          if (!isRecord(field)) continue;
          const fieldName = str(field.name);
          if (!fieldName) continue;
          const expr = dialectExpr(field.expression) ?? fieldName;
          const column = simpleColumn(expr, fieldName);
          if (!column) continue;
          const isDim = field.dimension !== undefined && field.dimension !== false;
          if (!isDim) continue;
          const dimMeta = isRecord(field.dimension) ? field.dimension : {};
          let published = fieldName;
          if (published in out.dimensions) published = `${name}_${fieldName}`;
          out.dimensions[published] = withSource(
            {
              description: str(field.description),
              entity: name,
              sql: sqlRef(table, column),
              type: boolTime(dimMeta) ? "timestamp" : undefined,
            },
            source,
          );
        }
      }

      for (const reln of asArray(model.relationships)) {
        if (!isRecord(reln)) continue;
        const fromDs = str(reln.from);
        const toDs = str(reln.to);
        const fromCols = asArray(reln.from_columns).map(str).filter(Boolean) as string[];
        const toCols = asArray(reln.to_columns).map(str).filter(Boolean) as string[];
        if (!fromDs || !toDs || fromCols.length === 0 || toCols.length === 0) continue;
        const fromTable = datasetTables.get(fromDs) ?? fromDs;
        const toTable = datasetTables.get(toDs) ?? toDs;
        const key = str(reln.name) ?? `${fromTable}_to_${toTable}`;
        out.relationships[key] = withSource(
          { from: `${fromTable}.${fromCols[0]}`, to: `${toTable}.${toCols[0]}`, type: "many_to_one" },
          source,
        );
      }

      for (const metric of asArray(model.metrics)) {
        if (!isRecord(metric)) continue;
        const name = str(metric.name);
        const expr = dialectExpr(metric.expression);
        if (!name || !expr) continue;
        const parsed = parseAggExpression(expr);
        if (!parsed) {
          out.warnings.push(`Skipping Ossie metric "${name}": expression "${expr}" is not a simple aggregate.`);
          continue;
        }
        const table = parsed.table ?? [...datasetTables.values()][0];
        if (!table) {
          out.warnings.push(`Skipping Ossie metric "${name}": no dataset to bind it to.`);
          continue;
        }
        const entity =
          [...datasetTables.entries()].find(([, t]) => t === table)?.[0] ??
          parsed.table ??
          Object.keys(out.entities)[0];
        if (!entity) continue;
        const synonyms = isRecord(metric.ai_context)
          ? asArray(metric.ai_context.synonyms).filter((s) => typeof s === "string")
          : [];
        out.metrics[name] = withSource(
          {
            description: str(metric.description),
            entity,
            type: parsed.type,
            sql: sqlRef(table, parsed.column),
            synonyms: synonyms as string[],
            status: "approved" as const,
          },
          source,
        );
      }
    }
  }

  if (Object.keys(out.entities).length === 0 && Object.keys(out.metrics).length === 0) {
    out.warnings.push(`Ossie connector found no datasets or metrics under ${spec.path ?? spec.file ?? root}.`);
  }
  return out;
}

function boolTime(meta: Record<string, unknown>): boolean {
  return meta.is_time === true;
}
