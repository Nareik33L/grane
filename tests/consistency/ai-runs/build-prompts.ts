/**
 * Materialise the exact prompts given to each attempt. Run:
 *   npx tsx tests/consistency/ai-runs/build-prompts.ts
 */
process.env.TZ = "UTC";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../../src/config/load.js";
import { GraneKernel } from "../../../src/kernel.js";
import { demoAnalyticsDir } from "../../../src/demo/paths.js";
import { buildDemoWarehouse } from "../../../src/demo/warehouse.js";
import { AI_CONSISTENCY, QUESTION_STEMS } from "./meta.js";

const here = dirname(fileURLToPath(import.meta.url));
export const PROMPTS_DIR = join(here, "prompts");

const SCHEMA_SQL = readFileSync(fileURLToPath(new URL("../../../demo/seed/duckdb_schema.sql", import.meta.url)), "utf8");

function questionBlock(): string {
  return QUESTION_STEMS.map((q) => `- ${q.id}: ${q.question}`).join("\n");
}

export function pathAPrompt(): string {
  return `You are answering analytics questions against a shop warehouse.
You may ONLY use the DuckDB schema below. You do not have Grane, a semantic layer, metric YAML, sample rows, or previous answers.
Do not read files. Do not use tools. Do not look up definitions. Write one DuckDB SELECT per question from this schema alone.

Protocol for relative periods (last month, last 30 days, last quarter, Q2): they are relative to the newest timestamp in the warehouse (greatest of orders.created_at / orders.completed_at), not the machine clock. You may use a subquery or CTE to pin that "today". Inclusive start, exclusive end of the next day is acceptable.

Return ONLY a JSON array, no markdown, of objects:
  { "id": "<question id>", "sql": "<single DuckDB SELECT>" }
One object per question, every id listed. If you cannot answer, still return the id with "sql": null and "error": "<reason>".

Questions:
${questionBlock()}

Schema:
${SCHEMA_SQL.trim()}
`;
}

export function pathBPrompt(catalogJson: string): string {
  return `You are answering analytics questions through Grane's governed metrics path (the MCP query tool).
You may ONLY produce Grane Query Model v1 requests from the catalog below. Do not write warehouse SQL. Do not read files. Do not use tools other than mentally calling catalog (already provided) and query.

A query looks like:
  { "metrics": ["revenue"], "dimensions": ["country"], "time": { "period": "last_month" }, "filters": [], "raw_dimensions": [] }
time.period values include last_month, last_quarter, 30d, q2. Prefer period over computing dates.
Use governed metric and dimension names from the catalog. raw_dimensions is table.column for permitted exploration columns. If the catalog cannot support a question safely, return a query you would still send (Grane will refuse) rather than SQL.

Return ONLY a JSON array, no markdown, of objects:
  { "id": "<question id>", "query": { "metrics": [...], ... } }
One object per question, every id listed. If you cannot form a query, still return the id with "query": null and "error": "<reason>".

Questions:
${questionBlock()}

Grane catalog (MCP catalog() payload, truncated exploration to column names):
${catalogJson}
`;
}

async function dumpCatalog(): Promise<string> {
  const { path } = await buildDemoWarehouse();
  const { config, projectDir } = loadConfig(demoAnalyticsDir());
  config.project.timezone = "UTC";
  config.connection = { type: "duckdb", path, schema: "main" };
  const kernel = new GraneKernel(config, { projectDir });
  try {
    const catalog = await kernel.catalog();
    const slim = {
      metrics: catalog.metrics.map((m) => ({
        name: m.name,
        description: m.description,
        entity: m.entity,
        type: m.type,
        unit: m.unit,
        status: m.status,
        synonyms: m.synonyms,
        time_dimension: m.time_dimension,
        available_dimensions: m.available_dimensions,
      })),
      dimensions: catalog.dimensions.map((d) => ({
        name: d.name,
        description: d.description,
        entity: d.entity,
        type: d.type,
      })),
      entities: catalog.entities.map((e) => ({
        name: e.name,
        table: e.table,
        description: e.description,
      })),
      exploration: {
        enabled: catalog.exploration.enabled,
        mode: catalog.exploration.mode,
        excluded: catalog.exploration.excluded,
        columns: catalog.exploration.columns.map((c) => `${c.table}.${c.column}`),
      },
    };
    return JSON.stringify(slim, null, 2);
  } finally {
    await kernel.close();
  }
}

export async function writePrompts(): Promise<{ pathA: string; pathB: string }> {
  mkdirSync(PROMPTS_DIR, { recursive: true });
  const catalog = await dumpCatalog();
  const pathA = pathAPrompt();
  const pathB = pathBPrompt(catalog);
  writeFileSync(join(PROMPTS_DIR, "path-a.txt"), pathA);
  writeFileSync(join(PROMPTS_DIR, "path-b.txt"), pathB);
  writeFileSync(
    join(PROMPTS_DIR, "meta.json"),
    `${JSON.stringify({ ...AI_CONSISTENCY, question_count: QUESTION_STEMS.length, catalog_bytes: catalog.length }, null, 2)}\n`,
  );
  return { pathA, pathB };
}

const isMain = process.argv[1]?.includes("ai-runs/build-prompts.ts");
if (isMain) {
  writePrompts()
    .then((p) => {
      console.log(`wrote ${join(PROMPTS_DIR, "path-a.txt")} (${p.pathA.length} chars)`);
      console.log(`wrote ${join(PROMPTS_DIR, "path-b.txt")} (${p.pathB.length} chars)`);
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    });
}
