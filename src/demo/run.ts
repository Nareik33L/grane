import { homedir } from "node:os";
import { GraneKernel } from "../kernel.js";
import { loadConfig } from "../config/load.js";
import { GraneError } from "../errors.js";
import {
  connectMcp,
  findWorkspaceDir,
  formatConnectOutput,
  resolveClient,
  resolveGraneLaunch,
} from "../mcp/connect/index.js";
import { serveHttp } from "../mcp/transport.js";
import { buildDemoWarehouse } from "./warehouse.js";
import { demoRoot } from "./paths.js";
import { resolveDemoProject, type ResolveDemoProjectOptions } from "./project.js";
import { runInvestigation, type Investigation } from "./investigate.js";
import { join } from "node:path";

export const DEMO_QUESTION = "Why did revenue fall last month?";

export const DEMO_POSTGRES =
  process.env.DATABASE_URL ??
  process.env.GRANE_DEMO_DATABASE_URL ??
  "postgres://grane_readonly:grane_readonly@localhost:5433/grane_demo";

export interface DemoIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface RunDemoOptions extends ResolveDemoProjectOptions {
  connect?: string;
  json?: boolean;
  serve?: boolean;
  port?: number;
  io?: DemoIo;
}

export interface DemoResult {
  projectDir: string;
  warehousePath: string | null;
  investigation: Investigation;
  productCategoryStatus: string | null;
  emailStatus: string | null;
  generatedSql: string;
}

const defaultIo: DemoIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export async function runDemo(options: RunDemoOptions = {}): Promise<DemoResult> {
  const io = options.io ?? defaultIo;
  const resolved = resolveDemoProject(options);

  if (!resolved.postgres && resolved.warehousePath) {
    io.error("Building the local DuckDB demo warehouse from demo/seed/duckdb.sql...");
    await buildDemoWarehouse(resolved.warehousePath);
    io.error(`Wrote ${resolved.warehousePath}`);
    io.error("");
  } else if (resolved.postgres) {
    io.error("Using Postgres on localhost:5433 (docker compose up -d postgres --wait).");
    io.error("");
  }

  const loaded = loadConfig(resolved.projectDir);
  if (resolved.postgres) {
    loaded.config.connection = {
      ...loaded.config.connection,
      type: "postgres",
      url: DEMO_POSTGRES,
      schema: "public",
    };
  } else if (resolved.warehousePath) {
    loaded.config.connection = {
      type: "duckdb",
      path: resolved.warehousePath,
      schema: "main",
    };
  }

  const kernel = new GraneKernel(loaded.config, {
    projectDir: loaded.projectDir,
    providerWarnings: loaded.warnings,
  });

  try {
    const schema = await kernel.introspectSchema();
    const report = kernel.validate(schema);
    if (!report.ok) {
      const errors = report.issues.filter((i) => i.severity === "error");
      throw new Error(
        `Demo project failed validate:\n${errors.map((e) => `  ${e.subject}: ${e.message}`).join("\n")}`,
      );
    }

    const investigation = await runInvestigation(kernel);
    const productCategoryStatus = await refusalStatus(kernel, {
      metrics: ["revenue"],
      dimensions: ["product_category"],
      time: { period: "last_month" },
    });
    const emailStatus = await refusalStatus(kernel, {
      metrics: ["revenue"],
      raw_dimensions: ["customers.email"],
      time: { period: "last_month" },
    });

    if (options.json) {
      io.log(
        JSON.stringify(
          {
            projectDir: resolved.projectDir,
            warehousePath: resolved.warehousePath,
            revenueLast: investigation.revenueLast,
            revenueChangePct: investigation.revenueChangePct,
            byCountry: investigation.byCountry,
            failures: investigation.failures,
            productCategoryStatus,
            emailStatus,
          },
          null,
          2,
        ),
      );
    } else {
      io.log("");
      io.log(investigation.transcript);
      io.log("");
      printRefusal(io, "revenue by product_category", productCategoryStatus);
      printRefusal(io, "revenue by customers.email", emailStatus);
      printNextSteps(io, resolved.projectDir, resolved.demoMarkdown, Boolean(options.serve));
    }

    if (options.connect) {
      const output = connectDemo(resolved.projectDir, options.connect);
      io.log("");
      io.log(output);
    }

    if (options.serve) {
      const port = options.port ?? 8080;
      await serveHttp(kernel, port);
      io.log(`\nMCP  http://localhost:${port}/mcp`);
    }

    return {
      projectDir: resolved.projectDir,
      warehousePath: resolved.warehousePath,
      investigation,
      productCategoryStatus,
      emailStatus,
      generatedSql: investigation.generatedSql,
    };
  } finally {
    if (!options.serve) await kernel.close();
  }
}

function connectDemo(projectDir: string, clientName: string): string {
  const result = connectMcp({
    client: resolveClient(clientName).id,
    projectDir,
    workspaceDir: findWorkspaceDir(process.cwd(), projectDir),
    homeDir: homedir(),
    platform: process.platform,
    launch: resolveGraneLaunch(),
    includeEnv: true,
    env: process.env,
    serverName: "grane",
    port: 8080,
    scope: "project",
    dryRun: false,
  });
  return formatConnectOutput(result);
}

async function refusalStatus(
  kernel: GraneKernel,
  query: Parameters<GraneKernel["query"]>[0],
): Promise<string | null> {
  try {
    await kernel.query(query);
    return null;
  } catch (err) {
    if (err instanceof GraneError) return err.refusal.status;
    throw err;
  }
}

function printRefusal(io: DemoIo, label: string, status: string | null): void {
  if (status) {
    io.log(`Refused ${label}: ${status}`);
  } else {
    io.log(`Expected a refusal for ${label}, but the query ran.`);
  }
  io.log("");
}

function printNextSteps(io: DemoIo, projectDir: string, demoMarkdown: string, serving: boolean): void {
  io.log("────────────────────────────────────────");
  io.log("Ask your agent this question:");
  io.log("");
  io.log(`  ${DEMO_QUESTION}`);
  io.log("");
  io.log("The agent should catalog governed metrics, find Germany, then investigate");
  io.log("permitted raw payments.failure_code (trust: mixed). It must not write SQL.");
  io.log("");
  if (!serving) {
    io.log("Connect a local agent (stdio):");
    io.log(`  grane -p ${projectDir} mcp connect cursor`);
    io.log(`  grane -p ${projectDir} mcp connect claude`);
    io.log("");
    io.log("  or: docker compose up");
    io.log("");
  }
  io.log(`What you should see: ${demoMarkdown}`);
  io.log(`Questions:           ${join(demoRoot(), "questions.md")}`);
}
