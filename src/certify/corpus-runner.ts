import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function repoRootFromHere(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/certify or dist/certify
  return join(here, "..", "..");
}

/**
 * Runs the shared WS1 corpus (`tests/certification/corpus.test.ts` via the
 * unit-test alias) for a single engine. Does not invent a second gold set.
 */
export async function spawnVitestCorpus(
  engine: string,
  opts: { cwd?: string; extraEnv?: NodeJS.ProcessEnv } = {},
): Promise<{ status: number; stdout: string; stderr: string }> {
  const cwd = opts.cwd ?? repoRootFromHere();
  const vitestJs = join(cwd, "node_modules", "vitest", "vitest.mjs");
  const vitestBin = join(cwd, "node_modules", ".bin", "vitest");
  const command = existsSync(vitestJs) ? process.execPath : vitestBin;
  const args = existsSync(vitestJs)
    ? [vitestJs, "run", "tests/unit/postgres-live-certification.test.ts"]
    : ["run", "tests/unit/postgres-live-certification.test.ts"];
  if (!existsSync(vitestJs) && !existsSync(vitestBin)) {
    throw new Error(
      "grane certify runs the shared corpus through vitest. From a git checkout run `npm install` (devDependency). This is not a second corpus.",
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(command, existsSync(vitestJs) ? args : args, {
      cwd,
      env: {
        ...process.env,
        ...opts.extraEnv,
        GRANE_CERTIFY_ENGINE: engine,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ status: code ?? 1, stdout, stderr });
    });
  });
}
