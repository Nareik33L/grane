#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../config/load.js";
import { GraneKernel, GRANE_VERSION } from "../kernel.js";
import { inferRelationships } from "../connectors/types.js";
import { resolveRelativeRange } from "../query/time.js";
import { serveHttp, serveStdio } from "../mcp/transport.js";
import { registerMcpCommands } from "./mcp.js";
import { GraneError } from "../errors.js";
import type { SemanticQueryInput } from "../query/model.js";
import { listExplorableColumns } from "../explore/raw.js";
import { explorationPolicy } from "../explore/policy.js";
import { promoteColumn } from "../explore/promote.js";
import { usageRanked } from "../explore/usage.js";
import { GRANE_YML, METRICS_YML, DIMENSIONS_YML, RELATIONSHIPS_YML } from "./templates.js";

const program = new Command();

program
  .name("grane")
  .description("Grane — governed analytics and controlled exploration for AI agents.")
  .version(GRANE_VERSION)
  .option("-p, --project <dir>", "project directory containing grane.yml", ".");

function projectDir(): string {
  return resolve(program.opts<{ project: string }>().project);
}

function loadKernel(): GraneKernel {
  const loaded = loadConfig(projectDir());
  return new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
}

function fail(err: unknown): never {
  if (err instanceof GraneError) {
    console.error(`ERROR (${err.refusal.status}): ${err.refusal.message}`);
    if (err.refusal.similar?.length) {
      console.error(`Similar: ${err.refusal.similar.join(", ")}`);
    }
  } else {
    console.error(`ERROR: ${(err as Error).message}`);
  }
  process.exit(1);
}

// ---------------------------------------------------------------- init
program
  .command("init")
  .description("Create a new Grane project in the current directory")
  .option("--dir <dir>", "directory to create the project in", ".")
  .action((options: { dir: string }) => {
    const dir = resolve(options.dir);
    mkdirSync(dir, { recursive: true });
    const files: [string, string][] = [
      ["grane.yml", GRANE_YML],
      ["metrics.yml", METRICS_YML],
      ["dimensions.yml", DIMENSIONS_YML],
      ["relationships.yml", RELATIONSHIPS_YML],
    ];
    const written: string[] = [];
    for (const [name, contents] of files) {
      const path = join(dir, name);
      if (existsSync(path)) {
        console.log(`skip  ${name} (already exists)`);
        continue;
      }
      writeFileSync(path, contents);
      written.push(name);
      console.log(`write ${name}`);
    }
    console.log(
      written.length > 0
        ? `\nGrane project created. Next steps:\n  1. Set connection.url in grane.yml (or export DATABASE_URL)\n  2. Run "grane discover" to inspect your schema\n  3. Define entities, metrics, dimensions and relationships\n  4. Run "grane validate"\n  5. Run "grane mcp doctor" then "grane mcp connect <client>"\n     Clients: claude, cursor, gemini, vscode, chatgpt, windsurf, claude-code`
        : "\nNothing to do.",
    );
  });

// ---------------------------------------------------------------- discover
program
  .command("discover")
  .description("Introspect the connected database schema and infer relationships")
  .option("--yaml", "print inferred relationships as YAML ready for relationships.yml")
  .action(async (options: { yaml?: boolean }) => {
    const kernel = loadKernel();
    try {
      const schema = await kernel.introspectSchema();
      const inferred = inferRelationships(schema);
      if (options.yaml) {
        console.log(stringifyYaml({ relationships: inferred }));
        return;
      }
      const columnCount = schema.tables.reduce((n, t) => n + t.columns.length, 0);
      const policy = explorationPolicy(kernel.config);
      const explorable = policy.enabled ? listExplorableColumns(kernel.model, schema) : [];
      console.log(`Database: ${kernel.config.connection.type} (schema "${schema.schemaName}")\n`);
      console.log(`${schema.tables.length} tables`);
      console.log(`${columnCount} columns discovered`);
      console.log(`${schema.foreignKeys.length} foreign keys`);
      console.log(`${Object.keys(inferred).length} inferred relationships\n`);
      console.log(`Governed:`);
      console.log(`  ${kernel.model.metrics.size} metrics`);
      console.log(`  ${kernel.model.dimensions.size} dimensions`);
      if (policy.enabled) {
        console.log(`Explorable:`);
        console.log(`  ${explorable.length} additional columns`);
      } else {
        console.log(`Exploration: disabled`);
      }
      console.log("");
      for (const table of schema.tables) {
        console.log(`${table.name}`);
        for (const column of table.columns) {
          console.log(`  ${column.name.padEnd(28)} ${column.dataType}`);
        }
      }
      if (Object.keys(inferred).length > 0) {
        console.log(`\nInferred relationships (grane discover --yaml to copy):`);
        for (const [name, rel] of Object.entries(inferred)) {
          console.log(`  ${name}: ${rel.from} -> ${rel.to} (${rel.type})`);
        }
      }
    } catch (err) {
      fail(err);
    } finally {
      await kernel.close();
    }
  });

// ---------------------------------------------------------------- validate
program
  .command("validate")
  .description("Validate the semantic model (structure, references, join safety)")
  .option("--offline", "skip live database schema checks")
  .action(async (options: { offline?: boolean }) => {
    const kernel = loadKernel();
    try {
      const schema = options.offline ? undefined : await kernel.introspectSchema();
      const report = kernel.validate(schema);
      for (const metric of report.metrics) {
        if (metric.ok) {
          console.log(`OK ${metric.metric}`);
        } else {
          console.log(`ERROR ${metric.metric}`);
          for (const issue of metric.issues) {
            console.log(`  ${issue.message}`);
          }
        }
      }
      const nonMetricIssues = report.issues.filter((i) => !i.subject.startsWith("metric:"));
      if (nonMetricIssues.length > 0) {
        console.log("");
        for (const issue of nonMetricIssues) {
          console.log(`${issue.severity.toUpperCase()} ${issue.subject}: ${issue.message}`);
        }
      }
      const validMetrics = report.metrics.filter((m) => m.ok).length;
      console.log("");
      console.log(`${validMetrics}/${report.metrics.length} metrics valid`);
      console.log(`${report.dimensionCount} dimensions defined`);
      console.log(`${report.relationshipCount} relationships defined`);
      if (!options.offline) console.log(`schema checks: live`);
      if (!report.ok) process.exit(1);
    } catch (err) {
      fail(err);
    } finally {
      await kernel.close();
    }
  });

// ---------------------------------------------------------------- query
program
  .command("query")
  .description("Run a query, e.g.: grane query revenue --dimension country --last 30d")
  .argument("[metrics...]", "governed metric names")
  .option("-d, --dimension <name...>", "governed dimension(s) to group by")
  .option("--raw-dimension <ref...>", "ungoverned table.column field(s) to group by")
  .option("--raw-metric <spec...>", "ungoverned aggregation(s), e.g. count:orders.id")
  .option("-f, --filter <expr...>", "filter(s) as dimension=value or table.column=value")
  .option("--last <period>", "relative period, e.g. 30d, 6m, last_month")
  .option("--from <date>", "start date (YYYY-MM-DD)")
  .option("--to <date>", "end date (YYYY-MM-DD), inclusive")
  .option("--grain <grain>", "time grain: day|week|month|quarter|year")
  .option("--limit <n>", "row limit")
  .option("--sql", "print the compiled SQL without executing")
  .option("--json", "print the full JSON result including provenance")
  .action(
    async (
      metrics: string[],
      options: {
        dimension?: string[];
        rawDimension?: string[];
        rawMetric?: string[];
        filter?: string[];
        last?: string;
        from?: string;
        to?: string;
        grain?: string;
        limit?: string;
        sql?: boolean;
        json?: boolean;
      },
    ) => {
      const kernel = loadKernel();
      try {
        const query: SemanticQueryInput = { metrics: metrics ?? [] };
        if (options.dimension) query.dimensions = options.dimension;
        if (options.rawDimension) query.raw_dimensions = options.rawDimension;
        if (options.rawMetric) {
          query.raw_metrics = options.rawMetric.map(parseRawMetricSpec);
        }
        if (options.filter) {
          query.filters = options.filter.map((expr) => {
            const eq = expr.indexOf("=");
            if (eq < 1) {
              throw new Error(`Invalid --filter "${expr}"; use field=value.`);
            }
            return { field: expr.slice(0, eq), operator: "=" as const, value: expr.slice(eq + 1) };
          });
        }
        if (options.last || options.from || options.to) {
          let from = options.from;
          let to = options.to;
          if (options.last) {
            const range = resolveRelativeRange(options.last, kernel.config.project.timezone);
            from = range.from;
            to = range.to;
          }
          if (!from || !to) {
            throw new Error("Provide either --last, or both --from and --to.");
          }
          query.time = {
            from,
            to,
            ...(options.grain ? { grain: options.grain as never } : {}),
          };
        } else if (options.grain) {
          throw new Error("--grain requires a time range (--last or --from/--to).");
        }
        if (options.limit) query.limit = Number(options.limit);

        if (options.sql) {
          const explained = await kernel.explain(query);
          console.log(explained.generated_sql);
          if (explained.params.length > 0) {
            console.log(`\n-- params: ${JSON.stringify(explained.params)}`);
          }
          if (explained.warning) console.error(`warning: ${explained.warning}`);
          return;
        }

        const result = await kernel.query(query);
        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }
        for (const note of result.notes) console.error(`note: ${note}`);
        if (result.warning) console.error(`warning: ${result.warning}`);
        printTable(result.columns, result.rows);
        console.error(
          `\n${result.provenance.row_count} rows | trust: ${result.trust} | query ${result.provenance.query_id} | ${result.provenance.duration_ms}ms`,
        );
      } catch (err) {
        fail(err);
      } finally {
        await kernel.close();
      }
    },
  );

// ---------------------------------------------------------------- serve
program
  .command("serve")
  .description("Start the Grane MCP server")
  .option("--stdio", "serve MCP over stdio (for local agent configs)")
  .option("--port <port>", "HTTP port", "8080")
  .action(async (options: { stdio?: boolean; port: string }) => {
    const kernel = loadKernel();
    try {
      if (options.stdio) {
        await serveStdio(kernel);
        return; // Keeps running until stdin closes.
      }
      const port = Number(options.port);
      await serveHttp(kernel, port);
      const catalog = await kernel.catalog();
      console.log("Grane MCP Server\n");
      console.log(`Database      ${kernel.config.connection.type}`);
      console.log(`Metrics       ${catalog.metrics.length}`);
      console.log(`Dimensions    ${catalog.dimensions.length}`);
      if (catalog.exploration.enabled) {
        console.log(`Explorable    ${catalog.exploration.columns.length} columns`);
      }
      console.log(`Status        ready\n`);
      console.log(`MCP           http://localhost:${port}/mcp`);
    } catch (err) {
      fail(err);
    }
  });

// ---------------------------------------------------------------- promote
program
  .command("promote")
  .description("Promote a raw warehouse column to a governed dimension")
  .argument("<column>", "table.column to promote, e.g. orders.discount_code")
  .option("--name <name>", "dimension name (default: the column name)")
  .option("--entity <entity>", "entity (inferred from the table when omitted)")
  .option("--description <text>", "dimension description")
  .action(
    async (
      column: string,
      options: { name?: string; entity?: string; description?: string },
    ) => {
      const loaded = loadConfig(projectDir());
      const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
      try {
        let schema;
        try {
          schema = await kernel.introspectSchema();
        } catch {
          schema = undefined;
        }
        const result = promoteColumn(kernel.model, loaded.projectDir, column, {
          name: options.name,
          entity: options.entity,
          description: options.description,
          schema: schema ?? null,
        });
        console.log(`Promoted ${result.column} -> governed dimension "${result.name}"`);
        console.log(`Wrote ${result.file}`);
        console.log(`Run "grane validate" to type-check the new definition.`);
      } catch (err) {
        fail(err);
      } finally {
        await kernel.close();
      }
    },
  );

// ---------------------------------------------------------------- usage
program
  .command("usage")
  .description("Show how often explorable columns have been queried")
  .action(() => {
    const loaded = loadConfig(projectDir());
    const ranked = usageRanked(loaded.projectDir);
    if (ranked.length === 0) {
      console.log("No exploratory column usage recorded yet.");
      return;
    }
    const width = Math.max(...ranked.map((r) => r.column.length), "column".length);
    console.log(`${"column".padEnd(width)}  uses  last_used`);
    console.log(`${"-".repeat(width)}  ----  ---------`);
    for (const row of ranked) {
      console.log(`${row.column.padEnd(width)}  ${String(row.count).padStart(4)}  ${row.last_used}`);
    }
  });

function parseRawMetricSpec(spec: string): { field: string; type: "sum" | "count" | "count_distinct" | "avg" | "min" | "max" } {
  const types = ["count_distinct", "count", "sum", "avg", "min", "max"] as const;
  for (const type of types) {
    if (spec.startsWith(`${type}:`)) {
      return { field: spec.slice(type.length + 1), type };
    }
  }
  return { field: spec, type: "count" };
}

function printTable(columns: string[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    console.log("(no rows)");
    return;
  }
  const render = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => render(r[c]).length)),
  );
  console.log(columns.map((c, i) => c.padEnd(widths[i]!)).join("  "));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    console.log(columns.map((c, i) => render(row[c]).padEnd(widths[i]!)).join("  "));
  }
}

registerMcpCommands(program, { projectDir, fail });

program.parseAsync(process.argv).catch(fail);
