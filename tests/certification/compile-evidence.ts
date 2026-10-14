/**
 * Pre-V2 vs now compile evidence for shipped example/demo YAML.
 * Baseline commit: 7a7ffc6 (last main before V2-01).
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { SemanticModel } from "../../src/model/model.js";
import { validateModel } from "../../src/validate/validate.js";

export const PRE_V2_BASELINE = "7a7ffc6";

export const EVIDENCE_PROJECTS = [
  "example/analytics",
  "example/analytics-duckdb",
  "demo/analytics",
] as const;

export const EVIDENCE_TIME = { from: "2026-08-01", to: "2026-08-31" } as const;

const YAML_NAMES = ["grane.yml", "grane.yaml", "metrics.yml", "dimensions.yml", "relationships.yml"];

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

export function projectYamlFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => YAML_NAMES.includes(name))
    .sort();
}

export function yamlHashes(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of projectYamlFiles(dir)) {
    out[name] = sha256(readFileSync(join(dir, name), "utf8"));
  }
  return out;
}

export function gitShowText(root: string, commit: string, path: string): string | null {
  const result = spawnSync("git", ["show", `${commit}:${path}`], {
    cwd: root,
    encoding: "utf8",
  });
  if ((result.status ?? 1) !== 0) return null;
  return result.stdout;
}

export function baselineYamlHashes(root: string, rel: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of YAML_NAMES) {
    const text = gitShowText(root, PRE_V2_BASELINE, `${rel}/${name}`);
    if (text === null) continue;
    out[name] = sha256(text);
  }
  return out;
}

export interface MetricMeaning {
  name: string;
  type: string;
  description: string | null;
  entity: string;
  sql: string | undefined;
  numerator?: string;
  denominator?: string;
  time_dimension?: string;
  additive?: string;
  filters: Record<string, unknown>;
  definition_version: string;
}

export interface CompileCase {
  name: string;
  input: { metrics: string[]; dimensions?: string[] };
  sql: string;
  params: unknown[];
}

export interface ProjectEvidence {
  project: string;
  yaml_bytes_identical_to_pre_v2: boolean;
  yaml_hashes_now: Record<string, string>;
  yaml_hashes_pre_v2: Record<string, string>;
  metrics: MetricMeaning[];
  validate_ok: boolean;
  compiles: CompileCase[];
}

export async function collectProjectEvidence(root: string, rel: string): Promise<ProjectEvidence> {
  const dir = join(root, rel);
  if (!existsSync(join(dir, "grane.yml")) && !existsSync(join(dir, "grane.yaml"))) {
    throw new Error(`missing project YAML in ${rel}`);
  }
  const now = yamlHashes(dir);
  const pre = baselineYamlHashes(root, rel);
  const yaml_bytes_identical_to_pre_v2 =
    Object.keys(now).length === Object.keys(pre).length &&
    Object.keys(now).every((name) => now[name] === pre[name]);

  const loaded = loadConfig(dir);
  const model = new SemanticModel(loaded.config);
  const report = validateModel(model);
  const metrics: MetricMeaning[] = Object.entries(loaded.config.metrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, config]) => {
      const metric = model.metrics.get(name);
      return {
        name,
        type: config.type,
        description: config.description ?? null,
        entity: config.entity,
        sql: config.sql,
        numerator: config.numerator,
        denominator: config.denominator,
        time_dimension: config.time_dimension,
        additive: config.additive,
        filters: config.filters ?? {},
        definition_version: metric?.definitionVersion ?? "",
      };
    });

  const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
  const compiles: CompileCase[] = [];
  try {
    for (const metric of metrics) {
      const { compiled } = kernel.compile({
        metrics: [metric.name],
        time: { ...EVIDENCE_TIME },
      });
      compiles.push({
        name: metric.name,
        input: { metrics: [metric.name] },
        sql: normalizeSql(compiled.sql),
        params: compiled.params,
      });
    }
    if (loaded.config.metrics.revenue && loaded.config.dimensions.country) {
      const { compiled } = kernel.compile({
        metrics: ["revenue"],
        dimensions: ["country"],
        time: { ...EVIDENCE_TIME },
      });
      compiles.push({
        name: "revenue_by_country",
        input: { metrics: ["revenue"], dimensions: ["country"] },
        sql: normalizeSql(compiled.sql),
        params: compiled.params,
      });
    }
  } finally {
    await kernel.close().catch(() => undefined);
  }

  return {
    project: rel,
    yaml_bytes_identical_to_pre_v2,
    yaml_hashes_now: now,
    yaml_hashes_pre_v2: pre,
    metrics,
    validate_ok: report.ok,
    compiles,
  };
}

export async function collectAllEvidence(root: string): Promise<{
  baseline_commit: string;
  generated_note: string;
  projects: ProjectEvidence[];
}> {
  const projects: ProjectEvidence[] = [];
  for (const rel of EVIDENCE_PROJECTS) {
    projects.push(await collectProjectEvidence(root, rel));
  }
  return {
    baseline_commit: PRE_V2_BASELINE,
    generated_note:
      "Pre-V2 baseline is 7a7ffc6. YAML hashes must match that commit. Metric meaning and compiled SQL are produced by the current compiler on that identical YAML (no silent semantic change).",
    projects,
  };
}
