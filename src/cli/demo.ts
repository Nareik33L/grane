import { existsSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import type { Command } from "commander";
import { loadConfig } from "../config/load.js";
import { GraneKernel } from "../kernel.js";
import { serveHttp } from "../mcp/transport.js";
import { demoAnalyticsDir, demoRoot, packageRoot } from "../demo/paths.js";
import { buildDemoWarehouse, duckdbDriverAvailable } from "../demo/warehouse.js";
import { runInvestigation } from "../demo/investigate.js";

const DEMO_POSTGRES =
  process.env.DATABASE_URL ??
  process.env.GRANE_DEMO_DATABASE_URL ??
  "postgres://grane_readonly:grane_readonly@localhost:5433/grane_demo";

interface DemoCliContext {
  fail: (err: unknown) => never;
}

export function registerDemoCommand(program: Command, ctx: DemoCliContext): void {
  program
    .command("demo")
    .description("Run the 60-second Grane shop investigation (Why did revenue fall last month?)")
    .option("--serve", "start the MCP server after the investigation")
    .option("--port <port>", "HTTP port when using --serve", "8080")
    .option("--json", "print investigation results as JSON")
    .action(async (options: { serve?: boolean; port: string; json?: boolean }) => {
      const kernel = await openDemoKernel();
      try {
        const investigation = await runInvestigation(kernel);
        if (options.json) {
          const { transcript: _transcript, ...rest } = investigation;
          console.log(JSON.stringify(rest, null, 2));
        } else {
          console.log("");
          console.log(investigation.transcript);
          console.log("");
          printNextSteps(Boolean(options.serve));
        }
        if (options.serve) {
          const port = Number(options.port);
          await serveHttp(kernel, port);
          console.log(`\nMCP  http://localhost:${port}/mcp`);
          return;
        }
      } catch (err) {
        ctx.fail(err);
      } finally {
        if (!options.serve) await kernel.close();
      }
    });
}

async function openDemoKernel(): Promise<GraneKernel> {
  const analytics = demoAnalyticsDir();
  const loaded = loadConfig(analytics);

  if (await postgresDemoUp()) {
    loaded.config.connection = {
      ...loaded.config.connection,
      type: "postgres",
      url: DEMO_POSTGRES,
      schema: "public",
    };
    banner("Demo warehouse: Postgres on localhost:5433");
    return new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
  }

  if (await duckdbDriverAvailable()) {
    banner("Demo warehouse: DuckDB (building from demo/seed/duckdb.sql)");
    const path = await buildDemoWarehouse();
    loaded.config.connection = {
      type: "duckdb",
      path,
      schema: "main",
    };
    return new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
  }

  const compose = join(packageRoot(), "docker-compose.yml");
  const hint = existsSync(compose)
    ? `  docker compose up -d --wait\n  npx grane-analytics demo`
    : `  git clone https://github.com/Nareik33L/grane.git && cd grane && docker compose up`;
  throw new Error(
    "No demo warehouse is reachable.\n\n" +
      "Start the bundled shop (Postgres + Grane MCP):\n" +
      hint +
      "\n\nOr install the DuckDB driver and re-run:\n" +
      "  npm install @duckdb/node-api\n" +
      "  npx grane-analytics demo",
  );
}

async function postgresDemoUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DEMO_POSTGRES, connectionTimeoutMillis: 1500 });
  try {
    const result = await pool.query(
      "SELECT 1 FROM information_schema.tables WHERE table_name = 'orders'",
    );
    return (result.rowCount ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

function banner(line: string): void {
  console.error(`\n${line}`);
}

function printNextSteps(serving: boolean): void {
  const analytics = demoAnalyticsDir();
  console.log("Try it with your own agent:");
  console.log("");
  if (serving) {
    console.log("  MCP is listening. Ask:");
  } else {
    console.log("  npx grane-analytics -p demo/analytics serve");
    console.log("  npx grane-analytics -p demo/analytics mcp connect cursor");
    console.log("");
    console.log("  or one command:");
    console.log("");
    console.log("  docker compose up");
    console.log("");
    console.log("Ask:");
  }
  console.log("");
  console.log('  "Why did Revenue fall last month?"');
  console.log("");
  console.log(`Demo project: ${analytics}`);
  console.log(`Questions:    ${join(demoRoot(), "questions.md")}`);
}
