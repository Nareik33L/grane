import { homedir } from "node:os";
import { GraneKernel } from "../kernel.js";
import { loadConfig } from "../config/load.js";
import { GraneError } from "../errors.js";
import { trustHeadline } from "../query/trust.js";
import { addDays, formatDate, parseCivilDate, resolveRelativeRange, type DateRange } from "../query/time.js";
import type { QueryResult } from "../execute/executor.js";
import {
  connectMcp,
  findWorkspaceDir,
  formatConnectOutput,
  resolveClient,
  resolveGraneLaunch,
} from "../mcp/connect/index.js";
import { join } from "node:path";
import { buildDemoWarehouse } from "./warehouse.js";
import { bundledDuckdbProject } from "./paths.js";
import { resolveDemoProject, type ResolveDemoProjectOptions } from "./project.js";

export const DEMO_QUESTION = "Why did revenue fall last month?";

export interface DemoIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface RunDemoOptions extends ResolveDemoProjectOptions {
  connect?: string;
  io?: DemoIo;
}

export interface DemoChannelRow {
  channel: string;
  revenue: number;
}

export interface DemoResult {
  projectDir: string;
  warehousePath: string | null;
  lastMonth: DateRange;
  priorMonth: DateRange;
  lastMonthRevenue: number;
  priorMonthRevenue: number;
  lastMonthByChannel: DemoChannelRow[];
  mixedCodes: string[];
  productCategoryStatus: string | null;
  emailStatus: string | null;
  generatedSql: string;
}

const defaultIo: DemoIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

export function priorCalendarMonth(last: DateRange): DateRange {
  const from = parseCivilDate(last.from);
  const priorStart = {
    year: from.month === 1 ? from.year - 1 : from.year,
    month: from.month === 1 ? 12 : from.month - 1,
    day: 1,
  };
  return { from: formatDate(priorStart), to: formatDate(addDays(from, -1)) };
}

export async function runDemo(options: RunDemoOptions = {}): Promise<DemoResult> {
  const io = options.io ?? defaultIo;
  const resolved = resolveDemoProject(options);

  if (!resolved.postgres && resolved.warehousePath) {
    io.log("Building the local DuckDB demo warehouse...");
    const parquetDir =
      resolved.projectDir === bundledDuckdbProject()
        ? join(resolved.projectDir, "parquet")
        : undefined;
    await buildDemoWarehouse(resolved.warehousePath, { parquetDir });
    io.log(`Wrote ${resolved.warehousePath}`);
    io.log("");
  } else if (resolved.postgres) {
    io.log("Using the Postgres demo project (example/docker-compose.yml must be running).");
    io.log("");
  }

  const loaded = loadConfig(resolved.projectDir);
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

    const timezone = kernel.config.project.timezone;
    const lastMonth = resolveRelativeRange("last_month", timezone);
    const priorMonth = priorCalendarMonth(lastMonth);

    const last = await kernel.query({
      metrics: ["revenue"],
      time: { period: "last_month" },
    });
    const prior = await kernel.query({
      metrics: ["revenue"],
      time: { from: priorMonth.from, to: priorMonth.to },
    });
    const byChannel = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["channel"],
      time: { period: "last_month" },
    });
    const mixed = await kernel.query({
      metrics: ["revenue"],
      dimensions: ["channel"],
      raw_dimensions: ["orders.discount_code"],
      time: { period: "last_month" },
    });

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

    const lastMonthRevenue = num(last.rows[0]?.["revenue"]);
    const priorMonthRevenue = num(prior.rows[0]?.["revenue"]);
    const lastMonthByChannel: DemoChannelRow[] = byChannel.rows.map((row) => ({
      channel: String(row["channel"]),
      revenue: num(row["revenue"]),
    }));
    const mixedCodes = [
      ...new Set(mixed.rows.map((row) => String(row["orders.discount_code"] ?? "")).filter(Boolean)),
    ];

    printBanner(io, resolved.projectDir, resolved.postgres);
    printQuery(io, "Last month revenue", last);
    printQuery(io, `Prior month revenue (${priorMonth.from} → ${priorMonth.to})`, prior);
    printQuery(io, "Last month by channel", byChannel);
    printQuery(io, "Last month by channel + orders.discount_code (ungoverned)", mixed);
    printRefusal(io, "revenue by product_category", productCategoryStatus);
    printRefusal(io, "revenue by customers.email", emailStatus);
    printNextSteps(io, resolved.projectDir, resolved.demoMarkdown);

    if (options.connect) {
      const output = connectDemo(resolved.projectDir, options.connect);
      io.log("");
      io.log(output);
    }

    return {
      projectDir: resolved.projectDir,
      warehousePath: resolved.warehousePath,
      lastMonth,
      priorMonth,
      lastMonthRevenue,
      priorMonthRevenue,
      lastMonthByChannel,
      mixedCodes,
      productCategoryStatus,
      emailStatus,
      generatedSql: last.provenance.generated_sql,
    };
  } finally {
    await kernel.close();
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

function printBanner(io: DemoIo, projectDir: string, postgres: boolean): void {
  io.log("Grane demo shop");
  io.log(postgres ? "Warehouse: Postgres (example compose)" : "Warehouse: local DuckDB (no Docker)");
  io.log(`Project:   ${projectDir}`);
  io.log("");
  io.log("Agents reason. Grane executes. The SQL below is compiled by Grane, not written by an agent.");
  io.log("");
}

function printQuery(io: DemoIo, title: string, result: QueryResult): void {
  io.log(title);
  io.log(trustHeadline(result.trust));
  if (result.warning) io.error(`warning: ${result.warning}`);
  printTable(io, result.columns, result.rows);
  io.log(`query ${result.provenance.query_id}  |  ${result.provenance.duration_ms}ms`);
  io.log("");
}

function printRefusal(io: DemoIo, label: string, status: string | null): void {
  if (status) {
    io.log(`Refused ${label}: ${status}`);
  } else {
    io.log(`Expected a refusal for ${label}, but the query ran.`);
  }
  io.log("");
}

function printNextSteps(io: DemoIo, projectDir: string, demoMarkdown: string): void {
  io.log("────────────────────────────────────────");
  io.log("Ask your agent this question:");
  io.log("");
  io.log(`  ${DEMO_QUESTION}`);
  io.log("");
  io.log("The agent should catalog governed metrics first, find the partner decline,");
  io.log("then investigate orders.discount_code (trust: mixed). It must not write SQL.");
  io.log("");
  io.log("Connect a local agent (stdio):");
  io.log(`  grane -p ${projectDir} mcp connect cursor`);
  io.log(`  grane -p ${projectDir} mcp connect claude`);
  io.log("");
  io.log(`What you should see: ${demoMarkdown}`);
}

function printTable(io: DemoIo, columns: string[], rows: Record<string, unknown>[]): void {
  if (rows.length === 0) {
    io.log("(no rows)");
    return;
  }
  const render = (value: unknown): string => {
    if (value === null || value === undefined) return "";
    if (value instanceof Date) return value.toISOString();
    return String(value);
  };
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => render(r[c]).length)));
  io.log(columns.map((c, i) => c.padEnd(widths[i]!)).join("  "));
  io.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const row of rows) {
    io.log(columns.map((c, i) => render(row[c]).padEnd(widths[i]!)).join("  "));
  }
}

function num(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  const parsed = Number(value);
  if (Number.isFinite(parsed)) return parsed;
  const text = String(value).trim();
  const fromText = Number(text);
  return Number.isFinite(fromText) ? fromText : 0;
}
