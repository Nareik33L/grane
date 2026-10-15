import { parse as parseYaml } from "yaml";

export interface PlaybackMetric {
  name: string;
  sql: string;
  calculation: string;
  filters: string;
  grain: string;
  description: string;
}

/**
 * Canonical play-back of a propose_definitions draft. The Set up Grane prompt
 * tells the model to read these fields back exactly — tests lock that the
 * summary is derived from the same YAML the proposal will contain.
 */
export function proposalPlaybackMetrics(draftYaml: Record<string, string>): PlaybackMetric[] {
  const raw = parseYaml(draftYaml["metrics.yml"] ?? "") as { metrics?: Record<string, Record<string, unknown>> };
  const metrics = raw?.metrics ?? {};
  return Object.entries(metrics)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, def]) => {
      const semi = def.semi_additive;
      const groupBy =
        semi && typeof semi === "object" && semi !== null && "group_by" in semi
          ? (semi as { group_by?: unknown }).group_by
          : undefined;
      return {
        name,
        sql: String(def.sql ?? ""),
        calculation: String(def.type ?? ""),
        filters: def.filters == null ? "none" : JSON.stringify(def.filters),
        grain: groupBy != null ? JSON.stringify(groupBy) : String(def.entity ?? ""),
        description: def.description == null || def.description === "" ? "none" : String(def.description),
      };
    });
}

export function formatProposalPlayback(draftYaml: Record<string, string>): string {
  const rows = proposalPlaybackMetrics(draftYaml);
  if (rows.length === 0) return "(no metrics in this proposal)";
  return rows
    .map(
      (row) =>
        `${row.name}: table/column ${row.sql}; calculation ${row.calculation}; filters ${row.filters}; grain ${row.grain}; description ${row.description}`,
    )
    .join("\n");
}
