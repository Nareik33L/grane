import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Committed marker written by setup `--dir` demo authoring. Proposal branches
 * stay in that nested repo; review/approve/rollback must not pin it.
 */
export const DEMO_AUTHORING_MARKER = ".grane-demo";

export function isDemoAuthoringProject(projectDir: string): boolean {
  return existsSync(join(resolve(projectDir), DEMO_AUTHORING_MARKER));
}
