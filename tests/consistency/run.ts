#!/usr/bin/env node
/**
 * Re-run the Grane vs independent-SQL consistency suite.
 *
 *   npx tsx tests/consistency/run.ts
 *   npx tsx tests/consistency/run.ts --write
 *   npx tsx tests/consistency/run.ts --engine duckdb --write
 *
 * --write records JSON + CSV under tests/consistency/results/ with ran_at
 * and the git SHA the queries actually ran against. Numbers are never
 * invented: if an engine cannot run, the report says skipped/failed.
 */
process.env.TZ = "UTC";

import {
  duckdbAvailable,
  openDuckdbBackend,
  openPostgresBackend,
  postgresAvailable,
  postgresRequired,
} from "./warehouse.js";
import { failedRun, runBackend, skippedRun, type EngineRun } from "./harness.js";
import { gitHeadSha, writeReport, type ConsistencyReport } from "./record.js";

function arg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

export async function runConsistency(options: {
  engine?: "duckdb" | "postgres" | "all";
} = {}): Promise<ConsistencyReport> {
  const engine = options.engine ?? "all";
  const wantDuck = engine === "all" || engine === "duckdb";
  const wantPg = engine === "all" || engine === "postgres";
  const engines: EngineRun[] = [];

  if (wantDuck) {
    if (!(await duckdbAvailable())) {
      engines.push(
        skippedRun("duckdb", "@duckdb/node-api is not installed. npm install -D @duckdb/node-api"),
      );
    } else {
      try {
        const backend = await openDuckdbBackend();
        try {
          engines.push(await runBackend(backend));
        } finally {
          await backend.close();
        }
      } catch (err) {
        engines.push(failedRun("duckdb", (err as Error).message));
      }
    }
  }

  if (wantPg) {
    if (!(await postgresAvailable())) {
      engines.push(
        skippedRun(
          "postgres",
          "No reachable Postgres (GRANE_PG_WRITE_URL, 127.0.0.1:5432, or localhost:5433). CI provides postgres:16.",
        ),
      );
    } else {
      try {
        const backend = await openPostgresBackend();
        try {
          engines.push(await runBackend(backend));
        } finally {
          await backend.close();
        }
      } catch (err) {
        engines.push(failedRun("postgres", (err as Error).message));
      }
    }
  }

  const { sha, dirty } = gitHeadSha();
  return {
    ran_at: new Date().toISOString(),
    commit_sha: sha,
    git_dirty: dirty,
    method:
      "Same demo-shop questions via (a) GraneKernel.query — the MCP query tool — and (b) handwritten SQL through pg / DuckDB, not Grane. Relative periods anchored to max(orders timestamps). Independent SQL is the metric definition, never compiler output.",
    engines,
  };
}

export function reportExitCode(report: ConsistencyReport): number {
  let code = 0;
  for (const engine of report.engines) {
    if (engine.status === "failed") code = 1;
    if (engine.status === "ran" && engine.summary.failed > 0) code = 1;
    if (engine.engine === "postgres" && engine.status === "skipped" && postgresRequired()) code = 1;
    if (engine.engine === "duckdb" && engine.status === "skipped") code = 1;
  }
  if (report.engines.length === 0) code = 1;
  return code;
}

function printReport(report: ConsistencyReport): void {
  console.log(`ran_at=${report.ran_at} commit_sha=${report.commit_sha} git_dirty=${report.git_dirty}`);
  for (const engine of report.engines) {
    if (engine.status !== "ran") {
      console.log(`[${engine.engine}] ${engine.status}: ${engine.skip_reason ?? engine.error}`);
      continue;
    }
    console.log(
      `[${engine.engine}] ${engine.engine_version.split(" ")[0]} anchor=${engine.anchor_now} ` +
        `ok=${engine.summary.ok}/${engine.summary.total} failed=${engine.summary.failed}`,
    );
    for (const q of engine.questions) {
      const mark = q.ok ? "ok" : "FAIL";
      const grane = q.grane.kind === "answered" ? formatShort(q.grane.rows) : `${q.grane.kind}:${q.grane.status ?? q.grane.message}`;
      const raw = q.raw.kind === "answered" ? formatShort(q.raw.rows) : `${q.raw.kind}:${q.raw.message}`;
      console.log(`  ${mark} ${q.id}  grane=${grane}  raw=${raw}  ${q.detail}`);
    }
  }
}

function formatShort(rows: import("./compare.js").Table | undefined): string {
  if (!rows) return "∅";
  return rows
    .slice(0, 3)
    .map((r) => r.map((c) => (c === null ? "NULL" : String(c))).join("|"))
    .join(";");
}

async function main(): Promise<void> {
  const engineArg = arg("--engine");
  const engine =
    engineArg === "duckdb" || engineArg === "postgres" || engineArg === "all" ? engineArg : "all";
  const write = has("--write") || process.env.CONSISTENCY_WRITE === "1";
  const report = await runConsistency({ engine });
  printReport(report);
  if (write) {
    const written = writeReport(report);
    console.log(`wrote ${written.json}`);
    for (const csv of written.csv) console.log(`wrote ${csv}`);
  }
  process.exitCode = reportExitCode(report);
}

const isMain = process.argv[1]?.includes("tests/consistency/run.ts");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
