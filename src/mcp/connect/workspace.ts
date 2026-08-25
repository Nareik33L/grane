import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** Walk up from cwd (then the Grane project) looking for a git workspace root. */
export function findWorkspaceDir(cwd: string, projectDir: string): string {
  for (const start of [cwd, projectDir]) {
    let dir = resolve(start);
    for (;;) {
      if (existsSync(resolve(dir, ".git"))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(cwd);
}
