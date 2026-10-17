import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { csvEscape, formatTable } from "./compare.js";
import type { EngineRun } from "./harness.js";

const here = dirname(fileURLToPath(import.meta.url));
export const RESULTS_DIR = join(here, "results");

export interface ConsistencyReport {
  ran_at: string;
  commit_sha: string;
  git_dirty: boolean;
  method: string;
  engines: EngineRun[];
}

export function gitHeadSha(cwd = here): { sha: string; dirty: boolean } {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  const dirty = spawnSync("git", ["status", "--porcelain"], { cwd, encoding: "utf8" });
  return {
    sha: sha.status === 0 ? sha.stdout.trim() : "unknown",
    dirty: dirty.status === 0 ? dirty.stdout.trim().length > 0 : true,
  };
}

export function stampFilename(engine: string, ranAt: Date, sha: string, ext: string): string {
  const ts = ranAt.toISOString().replaceAll(":", "").replaceAll("-", "").replace(".000", "");
  const short = sha.slice(0, 12);
  return `${engine}-${ts}-${short}.${ext}`;
}

export function toCsv(run: EngineRun): string {
  const header = [
    "engine",
    "id",
    "question",
    "expect",
    "ok",
    "tables_match",
    "grane_kind",
    "grane_status",
    "grane_trust",
    "grane_answer",
    "raw_kind",
    "raw_answer",
    "detail",
  ];
  const lines = [header.join(",")];
  for (const q of run.questions) {
    lines.push(
      [
        run.engine,
        q.id,
        csvEscape(q.question),
        q.expect,
        String(q.ok),
        q.tables_match === null ? "" : String(q.tables_match),
        q.grane.kind,
        q.grane.status ?? "",
        q.grane.trust ?? "",
        csvEscape(q.grane.rows ? formatTable(q.grane.rows, 20) : (q.grane.message ?? "")),
        q.raw.kind,
        csvEscape(q.raw.rows ? formatTable(q.raw.rows, 20) : (q.raw.message ?? "")),
        csvEscape(q.detail),
      ].join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

export interface WrittenFiles {
  json: string;
  csv: string[];
}

export const COMMITTED_RESULTS = join(here, "results", "committed.json");

export function writeReport(report: ConsistencyReport, outDir = RESULTS_DIR): WrittenFiles {
  mkdirSync(outDir, { recursive: true });
  const ranAt = new Date(report.ran_at);
  const jsonName = stampFilename("consistency", ranAt, report.commit_sha, "json");
  const jsonPath = join(outDir, jsonName);
  const payload = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(jsonPath, payload);
  writeFileSync(COMMITTED_RESULTS, payload);
  const csv: string[] = [];
  for (const engine of report.engines.filter((e) => e.status === "ran")) {
    const csvName = stampFilename(engine.engine, ranAt, report.commit_sha, "csv");
    const csvPath = join(outDir, csvName);
    writeFileSync(csvPath, toCsv(engine));
    csv.push(csvPath);
  }
  return { json: jsonPath, csv };
}
