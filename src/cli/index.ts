#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { stringify as stringifyYaml } from "yaml";
import { loadConfig } from "../config/load.js";
import { GraneKernel, GRANE_VERSION } from "../kernel.js";
import { inferRelationships } from "../connectors/types.js";
import { serveHttp, serveStdio, installHttpProcessShutdown, type HttpMcpHandle } from "../mcp/transport.js";
import { isLoopbackHost } from "../mcp/http-bind.js";
import { registerMcpCommands } from "./mcp.js";
import { GraneError } from "../errors.js";
import type { SemanticQueryInput } from "../query/model.js";
import { trustHeadline } from "../query/trust.js";
import { listExplorableColumns } from "../explore/raw.js";
import { explorationPolicy } from "../explore/policy.js";
import { promoteColumn } from "../explore/promote.js";
import { usageRanked } from "../explore/usage.js";
import { graneYml, METRICS_YML, DIMENSIONS_YML, RELATIONSHIPS_YML } from "./templates.js";
import { writeDiscoveredRelationships } from "../discover/relationships.js";
import { runDemo } from "../demo/run.js";
import { parseFilterSpec } from "./args.js";
import { formatProductionLint, lintProduction } from "./production-lint.js";
import {
  defaultUserTestTargets,
  formatUserTestReport,
  loadUserTestCases,
  runUserTests,
} from "./user-tests.js";

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
  return new GraneKernel(loaded.config, {
    projectDir: loaded.projectDir,
    providerWarnings: loaded.warnings,
  });
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
  .option(
    "--provider <path>",
    "existing dbt/MetricFlow, Cube, LookML, … project to import (relative to the new project); written live under providers:",
  )
  .action((options: { dir: string; provider?: string }) => {
    const dir = resolve(options.dir);
    mkdirSync(dir, { recursive: true });
    const files: [string, string][] = [
      ["grane.yml", graneYml(options.provider)],
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
    const nextSteps = options.provider
      ? `\nGrane project created. Your existing definitions stay where they are:\n  1. Create a read-only DB user and set DATABASE_URL (or connection.url)\n  2. Run "grane validate" — metrics, dimensions and joins are imported from ${options.provider}\n     Skipped upstream definitions are listed with the reason (also under catalog.unsupported)\n  3. Run "grane mcp doctor" then "grane mcp connect <client>"\n     Docs: https://github.com/Nareik33L/grane/blob/main/docs/providers.md`
      : `\nGrane project created. First week on your own Postgres:\n  1. Create a read-only DB user and set DATABASE_URL (or connection.url)\n  2. Run "grane discover --write-relationships" to inspect schema and merge FKs\n  3. Define entities and about five metrics (see metrics.yml comments)\n     Already have dbt/MetricFlow, Cube or LookML? Re-run with --provider <path> instead\n  4. Run "grane validate"\n  5. Run "grane mcp doctor" then "grane mcp connect <client>"\n     Docs: https://github.com/Nareik33L/grane/blob/main/docs/first-week.md`;
    console.log(written.length > 0 ? nextSteps : "\nNothing to do.");
  });

// ---------------------------------------------------------------- demo
program
  .command("demo")
    .description("Build the demo shop, run the revenue-drop investigation, and print the question to ask an agent")
    .option("--dir <dir>", "write the DuckDB demo project here (default: demo/analytics or ~/.grane/demo)")
    .option("--postgres", "use Docker Postgres on localhost:5433 instead of DuckDB")
    .option("--connect <client>", "register the demo with an MCP client (cursor, claude, …)")
    .option("--serve", "start the MCP server after the investigation")
    .option("--port <port>", "HTTP port when using --serve", "8080")
    .option("--json", "print investigation results as JSON")
    .action(
      async (options: {
        dir?: string;
        postgres?: boolean;
        connect?: string;
        serve?: boolean;
        port: string;
        json?: boolean;
      }) => {
        try {
          await runDemo({
            dir: options.dir,
            postgres: options.postgres,
            connect: options.connect,
            serve: options.serve,
            port: Number(options.port),
            json: options.json,
          });
        } catch (err) {
          fail(err);
        }
      },
    );

// ---------------------------------------------------------------- discover
program
  .command("discover")
  .description("Introspect the connected database schema and infer relationships")
  .option("--yaml", "print inferred relationships as YAML ready for relationships.yml")
  .option(
    "--write-relationships",
    "merge inferred foreign keys into relationships.yml (never overwrites existing keys)",
  )
  .action(async (options: { yaml?: boolean; writeRelationships?: boolean }) => {
    const kernel = loadKernel();
    try {
      const schema = await kernel.introspectSchema();
      const inferred = inferRelationships(schema);
      if (options.writeRelationships) {
        const project = kernel.projectDir;
        if (!project) {
          throw new Error("Cannot write relationships.yml: project directory is unknown.");
        }
        const written = writeDiscoveredRelationships(project, inferred, kernel.config.relationships);
        if (written.added.length > 0) {
          console.log(`Wrote ${written.added.length} relationship(s) to ${written.file}`);
          for (const name of written.added) console.log(`  + ${name}`);
        } else {
          console.log("No new relationships to write (existing keys and from→to pairs were kept).");
        }
        if (written.skipped.length > 0) {
          console.log(`Skipped ${written.skipped.length} already defined:`);
          for (const skip of written.skipped) console.log(`  - ${skip.name} (${skip.reason})`);
        }
        console.log("");
      }
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
        console.log(`\nInferred relationships (grane discover --yaml to copy, --write-relationships to merge):`);
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
  .option("--production", "also fail on production fail-open conditions")
  .action(async (options: { offline?: boolean; production?: boolean }) => {
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
      const providers = kernel.serverInfo().semantic_providers;
      console.log(`providers     ${providers.join(", ")}`);
      if (kernel.providerWarnings.length > 0) {
        console.log("");
        for (const warning of kernel.providerWarnings) {
          console.log(`WARNING ${warning}`);
        }
      }
      if (!options.offline) console.log(`schema checks: live`);
      let productionOk = true;
      if (options.production) {
        const lint = lintProduction(kernel.config, kernel.projectDir);
        console.log("");
        console.log(formatProductionLint(lint));
        productionOk = lint.ok;
      }
      if (!report.ok || !productionOk) process.exit(1);
    } catch (err) {
      fail(err);
    } finally {
      await kernel.close();
    }
  });

// ---------------------------------------------------------------- doctor (production lint)
program
  .command("doctor")
  .description("Fail-open production lint (auth, TLS, audit path, limits, experimental metrics)")
  .option("--production", "accepted for the documented form; this command always runs the production lint")
  .option("--json", "print JSON")
  .action((options: { production?: boolean; json?: boolean }) => {
    void options.production;
    let loaded;
    try {
      loaded = loadConfig(projectDir());
    } catch (err) {
      fail(err);
    }
    const lint = lintProduction(loaded.config, loaded.projectDir);
    if (options.json) {
      console.log(JSON.stringify(lint, null, 2));
    } else {
      console.log("Grane production doctor\n");
      console.log(formatProductionLint(lint));
    }
    if (!lint.ok) process.exit(1);
  });

// ---------------------------------------------------------------- test
program
  .command("test")
  .description("Run user-authored YAML query scenarios (query + expected disposition/status/gold)")
  .argument("[path]", "file or directory of YAML scenarios (default: grane-tests.yml / grane-tests/)")
  .option("--json", "print JSON")
  .action(async (path: string | undefined, options: { json?: boolean }) => {
    let loaded;
    try {
      loaded = loadConfig(projectDir());
    } catch (err) {
      fail(err);
    }
    const targets = path ? [resolve(path)] : defaultUserTestTargets(loaded.projectDir);
    if (targets.length === 0) {
      console.error(`No test files. Add ${join(loaded.projectDir, "grane-tests.yml")} or pass a path.`);
      process.exit(2);
    }
    const kernel = new GraneKernel(loaded.config, {
      projectDir: loaded.projectDir,
      providerWarnings: loaded.warnings,
    });
    try {
      const cases = loadUserTestCases(targets);
      if (cases.length === 0) {
        console.error("No scenarios found in the given YAML.");
        process.exit(2);
      }
      const report = await runUserTests(kernel, cases);
      if (options.json) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        console.log(formatUserTestReport(report));
      }
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
  .option("-f, --filter <expr...>", "filter(s) as dimension=value, dimension!=value (or <>), or table.column=value")
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
          query.filters = options.filter.map(parseFilterSpec);
        }
        if (options.last || options.from || options.to) {
          if (options.last) {
            if (options.from || options.to) {
              throw new Error("Provide either --last, or both --from and --to.");
            }
            query.time = {
              period: options.last,
              ...(options.grain ? { grain: options.grain as never } : {}),
            };
          } else {
            if (!options.from || !options.to) {
              throw new Error("Provide either --last, or both --from and --to.");
            }
            query.time = {
              from: options.from,
              to: options.to,
              ...(options.grain ? { grain: options.grain as never } : {}),
            };
          }
        } else if (options.grain) {
          throw new Error("--grain requires --last or --from/--to.");
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
        console.log(trustHeadline(result.trust));
        console.log("");
        for (const note of result.notes) console.error(`note: ${note}`);
        if (result.warning) console.error(`warning: ${result.warning}`);
        printTable(result.columns, result.rows);
        if (result.completeness.status === "truncated") {
          console.error(
            `Showing ${result.provenance.row_count} rows; result truncated by execution limit ${result.completeness.limit}.`,
          );
        }
        console.error(
          `\n${result.provenance.row_count} rows | trust: ${result.trust} | completeness: ${result.completeness.status} | query ${result.provenance.query_id} | ${result.provenance.duration_ms}ms`,
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
  .option("--host <host>", "HTTP bind address", "127.0.0.1")
  .option(
    "--allow-anonymous",
    "allow unauthenticated HTTP on a non-loopback address (no auth.agents)",
  )
  .action(async (options: { stdio?: boolean; port: string; host: string; allowAnonymous?: boolean }) => {
    const kernel = loadKernel();
    let handle: HttpMcpHandle | undefined;
    try {
      if (options.stdio) {
        await serveStdio(kernel);
        return; // Keeps running until stdin closes.
      }
      const port = Number(options.port);
      const host = options.host;
      handle = await serveHttp(kernel, port, {
        host,
        allowAnonymous: options.allowAnonymous,
      });
      installHttpProcessShutdown(handle, kernel);
      const catalog = await kernel.catalog();
      const agents = kernel.config.auth.agents.length;
      const poolSize = kernel.config.connection.pool_size;
      const concurrency = kernel.config.limits.max_concurrency ?? poolSize * 2;
      console.log("Grane MCP Server\n");
      console.log(`Database      ${kernel.config.connection.type}`);
      console.log(`Providers     ${kernel.serverInfo().semantic_providers.join(", ")}`);
      console.log(
        agents > 0
          ? `Auth          ${agents} agent${agents === 1 ? "" : "s"} (HTTP bearer required)`
          : `Auth          anonymous`,
      );
      console.log(`Pool          ${poolSize}`);
      console.log(`Concurrency   ${concurrency}`);
      console.log(
        kernel.config.limits.rate_limit_rps != null
          ? `Rate limit    ${kernel.config.limits.rate_limit_rps} rps`
          : `Rate limit    off`,
      );
      console.log(`Metrics       ${catalog.metrics.length}`);
      console.log(`Dimensions    ${catalog.dimensions.length}`);
      if (catalog.exploration.enabled) {
        console.log(`Explorable    ${catalog.exploration.columns.length} columns`);
      }
      console.log(`Bind          ${handle.host}:${handle.port}`);
      console.log(`Status        ready\n`);
      const reach = isLoopbackHost(handle.host) || handle.host === "0.0.0.0" || handle.host === "::"
        ? handle.host === "0.0.0.0" || handle.host === "::"
          ? "127.0.0.1"
          : handle.host
        : handle.host;
      console.log(`MCP           http://${reach}:${handle.port}/mcp`);
    } catch (err) {
      await handle?.close().catch(() => undefined);
      await kernel.close().catch(() => undefined);
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
    if (columns.length > 0) console.log(columns.join("  "));
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
