import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEMO_AUTHORING_MARKER } from "../authoring/demo-marker.js";
import { writeInitProject } from "../cli/init-project.js";
import { demoPostgresUrl } from "../demo/run.js";
import { persistOwnConnection } from "./connection.js";
import type { SetupIo } from "./types.js";

export const DEMO_AUTHORING_QUESTION =
  "Open the Set up Grane prompt to define metrics against the demo shop.";

const AUTHORING_BLOCK = [
  "authoring:",
  "  enabled: true",
  "  mode: local",
  "  sampling: true",
  "  sample_rows: 20",
  "",
].join("\n");

const COMMENTED_AUTHORING = /# V2 authoring MCP tools[\s\S]*?#   sample_rows: 20\n\n/;

/** Write a blank Grane project pointed at demo Postgres with authoring on. Never pins. */
export function writeDemoAuthoringProject(
  projectDir: string,
  options: { url?: string; schema?: string } = {},
): { projectDir: string; url: string } {
  const dir = resolve(projectDir);
  mkdirSync(dir, { recursive: true });
  writeInitProject(dir);
  const url = options.url ?? demoPostgresUrl();
  persistOwnConnection(dir, {
    type: "postgres",
    url,
    schema: options.schema ?? "public",
  });
  persistAuthoringEnabled(dir);
  writeFileSync(join(dir, DEMO_AUTHORING_MARKER), "demo-authoring\n");
  return { projectDir: dir, url };
}

export function persistAuthoringEnabled(projectDir: string): void {
  const file = join(projectDir, "grane.yml");
  if (!existsSync(file)) {
    throw new Error(`Cannot enable authoring: ${file} was not found.`);
  }
  const raw = readFileSync(file, "utf8");
  let next: string;
  if (COMMENTED_AUTHORING.test(raw)) {
    next = raw.replace(COMMENTED_AUTHORING, `${AUTHORING_BLOCK}\n`);
  } else if (/^authoring:/m.test(raw)) {
    next = raw.replace(/^authoring:\n(?:[ \t]+.+\n)*/, AUTHORING_BLOCK);
  } else {
    next = raw.endsWith("\n") ? `${raw}\n${AUTHORING_BLOCK}` : `${raw}\n\n${AUTHORING_BLOCK}`;
  }
  if (next !== raw) writeFileSync(file, next);
}

/**
 * Nested `git init` in the project directory so proposals never land on a
 * parent repo (including the Grane source tree). Commits the starter YAML.
 */
/** Refuse --dir that is already a git repository (proposals must not land there). */
export function assertNotExistingGitRepo(dir: string): void {
  const resolved = resolve(dir);
  if (!existsSync(resolved)) return;
  if (existsSync(join(resolved, ".git"))) {
    throw new Error(
      `Refusing --dir ${resolved}: it is already a git repository. ` +
        `Pass an empty folder so proposal branches cannot land on an existing repo.`,
    );
  }
}

export function ensureDemoAuthoringGitRepo(projectDir: string, io: SetupIo): void {
  const dir = resolve(projectDir);
  assertNotExistingGitRepo(dir);
  git(dir, ["init", "-b", "main"]);
  const hasHead = spawnSync("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir, encoding: "utf8" });
  if ((hasHead.status ?? 1) === 0) {
    io.log(`git        using existing repo at ${dir}`);
    return;
  }
  git(dir, ["config", "user.email", "setup@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Setup"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "Initial Grane demo authoring project"]);
  io.log(`git        nested repo at ${dir} (proposal branches stay here)`);
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(
      result.stderr?.trim() ||
        result.stdout?.trim() ||
        `git ${args.join(" ")} failed. Install git, then re-run grane setup.`,
    );
  }
}
