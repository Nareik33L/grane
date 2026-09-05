import { createRequire } from "node:module";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

type DuckDbConnection = {
  runAndReadAll: (sql: string, values?: unknown[]) => Promise<unknown>;
  closeSync?: () => void;
  disconnectSync?: () => void;
};

type DuckDbInstance = {
  connect: () => Promise<DuckDbConnection>;
};

export type DuckDbMod = {
  DuckDBInstance: {
    create: (path?: string, opts?: Record<string, string>) => Promise<DuckDbInstance>;
  };
};

const CACHE_DIR = join(homedir(), ".grane");

export function duckdbCacheDir(): string {
  return CACHE_DIR;
}

/** Load @duckdb/node-api from the current install, or install it once under ~/.grane. */
export async function loadDuckDbModule(): Promise<DuckDbMod> {
  try {
    return (await import("@duckdb/node-api")) as DuckDbMod;
  } catch {
    // fall through to the user cache
  }

  const cached = tryRequireFrom(CACHE_DIR);
  if (cached) return cached;

  mkdirSync(CACHE_DIR, { recursive: true });
  const pkg = join(CACHE_DIR, "package.json");
  if (!existsSync(pkg)) {
    writeFileSync(pkg, `${JSON.stringify({ private: true, name: "grane-local" }, null, 2)}\n`);
  }

  process.stderr.write(
    "Installing @duckdb/node-api into ~/.grane (once, for the local demo warehouse)...\n",
  );
  const result = spawnSync("npm", ["install", "@duckdb/node-api@^1.5.5-r.4"], {
    cwd: CACHE_DIR,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      "The demo warehouse uses DuckDB and needs @duckdb/node-api. Install it, then re-run:\n" +
        "  npm install @duckdb/node-api\n" +
        "  npx grane-analytics demo   # grane-analytics@0.6.5+",
    );
  }

  const after = tryRequireFrom(CACHE_DIR);
  if (!after) {
    throw new Error("Installed @duckdb/node-api into ~/.grane but could not load it. Try: npm install @duckdb/node-api");
  }
  return after;
}

function tryRequireFrom(dir: string): DuckDbMod | null {
  const pkg = join(dir, "package.json");
  if (!existsSync(join(dir, "node_modules", "@duckdb", "node-api"))) return null;
  try {
    const require = createRequire(pkg);
    return require("@duckdb/node-api") as DuckDbMod;
  } catch {
    return null;
  }
}

export function splitSqlStatements(sql: string): string[] {
  const withoutLineComments = sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");
  return withoutLineComments
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}
