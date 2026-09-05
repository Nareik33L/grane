import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { configError } from "../errors.js";
import { detectConnectorKinds } from "../providers/detect.js";

/**
 * Fail `grane init --provider` when the path is missing or has no sniffable
 * semantic definitions, so the user does not get a later generic load error.
 */
export function assertInitProviderPath(projectDir: string, provider: string): string {
  const root = isAbsolute(provider) ? provider : resolve(projectDir, provider);
  if (!existsSync(root)) {
    throw configError(
      `Provider path does not exist: ${provider} (resolved ${root}). ` +
        `Pass a directory or file Grane can import (dbt/MetricFlow, Cube, LookML, Ossie, Malloy, or a Grane fragment).`,
      { provider, resolved: root },
    );
  }
  const kinds = detectConnectorKinds(root);
  if (kinds.length === 0) {
    throw configError(
      `No semantic definitions found at ${provider} (resolved ${root}). ` +
        `Grane can auto-detect dbt/MetricFlow, Cube YAML, LookML, Apache Ossie, Malloy, or Grane fragment maps.`,
      { provider, resolved: root },
    );
  }
  return root;
}
