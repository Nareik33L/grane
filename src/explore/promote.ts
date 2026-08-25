import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SemanticModel } from "../model/model.js";
import type { DimensionConfig } from "../config/schema.js";
import type { DatabaseSchema } from "../connectors/types.js";
import { parseColumnRef, formatColumnRef } from "../model/refs.js";
import { configError, invalidQuery } from "../errors.js";
import { isNumericType, isTemporalType } from "../connectors/dialect.js";

export interface PromoteResult {
  name: string;
  column: string;
  config: DimensionConfig;
  file: string;
}

function inferType(dataType: string | undefined): DimensionConfig["type"] | undefined {
  if (!dataType) return undefined;
  if (isTemporalType(dataType)) {
    return /date/i.test(dataType) && !/time/i.test(dataType) ? "date" : "timestamp";
  }
  if (isNumericType(dataType)) return "number";
  if (/bool/i.test(dataType)) return "boolean";
  return "string";
}

function inferEntity(model: SemanticModel, table: string): string | null {
  for (const entity of model.entities.values()) {
    if (entity.config.table === table) return entity.name;
  }
  return null;
}

function uniqueDimensionName(model: SemanticModel, preferred: string, table: string): string {
  if (!model.dimensions.has(preferred)) return preferred;
  const fallback = `${table}_${preferred}`;
  if (!model.dimensions.has(fallback)) return fallback;
  throw invalidQuery(
    `Cannot promote: dimension names "${preferred}" and "${fallback}" are already defined.`,
  );
}

export function planPromotion(
  model: SemanticModel,
  column: string,
  options: { name?: string; entity?: string; description?: string; schema?: DatabaseSchema | null } = {},
): { name: string; config: DimensionConfig } {
  const ref = parseColumnRef(column);
  if (!ref) {
    throw invalidQuery(`"${column}" is not a table.column reference.`);
  }
  const qualified = formatColumnRef(ref);
  for (const dimension of model.dimensions.values()) {
    if (dimension.column.table === ref.table && dimension.column.column === ref.column) {
      throw invalidQuery(
        `"${qualified}" is already the governed dimension "${dimension.name}".`,
      );
    }
  }

  const entity = options.entity ?? inferEntity(model, ref.table);
  if (!entity) {
    throw invalidQuery(
      `Cannot infer an entity for table "${ref.table}". Pass --entity, or add the entity to grane.yml.`,
    );
  }
  if (!model.entities.has(entity)) {
    throw invalidQuery(`Entity "${entity}" is not defined in the semantic model.`);
  }

  let dataType: string | undefined;
  if (options.schema) {
    const table = options.schema.tables.find((t) => t.name === ref.table);
    const col = table?.columns.find((c) => c.name === ref.column);
    if (!table) {
      throw invalidQuery(`Table "${ref.table}" was not found in the warehouse schema.`);
    }
    if (!col) {
      throw invalidQuery(`Column "${qualified}" was not found in the warehouse schema.`);
    }
    dataType = col.dataType;
  }

  const name = uniqueDimensionName(model, options.name ?? ref.column, ref.table);
  const type = inferType(dataType);
  const config: DimensionConfig = {
    description: options.description ?? `Promoted from warehouse column ${qualified}.`,
    entity,
    sql: `\${${qualified}}`,
    ...(type ? { type } : {}),
  };
  return { name, config };
}

function formatDimensionBlock(name: string, config: DimensionConfig): string {
  const lines = [`  ${name}:`];
  if (config.description) lines.push(`    description: ${yamlScalar(config.description)}`);
  lines.push(`    entity: ${config.entity}`);
  lines.push(`    sql: ${config.sql}`);
  if (config.type) lines.push(`    type: ${config.type}`);
  return lines.join("\n") + "\n";
}

function yamlScalar(value: string): string {
  if (/[:#{}[\],&*?|<>=!%@`"'\\]/.test(value) || value !== value.trim()) {
    return JSON.stringify(value);
  }
  return value;
}

export function writePromotedDimension(projectDir: string, name: string, config: DimensionConfig): string {
  const file = join(projectDir, "dimensions.yml");
  const block = formatDimensionBlock(name, config);
  if (!existsSync(file)) {
    writeFileSync(file, `# Approved dimensions for breaking down and filtering metrics.\n\ndimensions:\n${block}`);
    return file;
  }
  const existing = readFileSync(file, "utf8");
  if (new RegExp(`^\\s*${name}:\\s*$`, "m").test(existing)) {
    throw configError(`Dimension "${name}" already exists in ${file}.`);
  }
  const suffix = existing.endsWith("\n") ? "" : "\n";
  writeFileSync(file, existing + suffix + "\n" + block);
  return file;
}

export function promoteColumn(
  model: SemanticModel,
  projectDir: string,
  column: string,
  options: { name?: string; entity?: string; description?: string; schema?: DatabaseSchema | null } = {},
): PromoteResult {
  const { name, config } = planPromotion(model, column, options);
  const file = writePromotedDimension(projectDir, name, config);
  return { name, column: parseColumnRef(column) ? formatColumnRef(parseColumnRef(column)!) : column, config, file };
}
