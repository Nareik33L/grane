import type { ValidationReport } from "./validate.js";

/**
 * The lines `grane validate` prints for a report. Import setup reuses this so
 * invalid YAML produces the same messages.
 */
export function formatValidateReport(
  report: ValidationReport,
  extras: {
    providers: string[];
    providerWarnings?: string[];
    schemaLive?: boolean;
  },
): string[] {
  const lines: string[] = [];
  for (const metric of report.metrics) {
    if (metric.ok) {
      lines.push(`OK ${metric.metric}`);
    } else {
      lines.push(`ERROR ${metric.metric}`);
      for (const issue of metric.issues) {
        lines.push(`  ${issue.message}`);
      }
    }
  }
  const nonMetricIssues = report.issues.filter((i) => !i.subject.startsWith("metric:"));
  if (nonMetricIssues.length > 0) {
    if (lines.length > 0) lines.push("");
    for (const issue of nonMetricIssues) {
      lines.push(`${issue.severity.toUpperCase()} ${issue.subject}: ${issue.message}`);
    }
  }
  const validMetrics = report.metrics.filter((m) => m.ok).length;
  lines.push("");
  lines.push(`${validMetrics}/${report.metrics.length} metrics valid`);
  lines.push(`${report.dimensionCount} dimensions defined`);
  lines.push(`${report.relationshipCount} relationships defined`);
  lines.push(`providers     ${extras.providers.join(", ")}`);
  if (extras.providerWarnings && extras.providerWarnings.length > 0) {
    lines.push("");
    for (const warning of extras.providerWarnings) {
      lines.push(`WARNING ${warning}`);
    }
  }
  if (extras.schemaLive) lines.push(`schema checks: live`);
  return lines;
}
