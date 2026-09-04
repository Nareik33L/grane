import { vacuousSnapshotSeriesKeys, vacuousSnapshotSeriesMessage, type SemanticModel, type Metric } from "../model/model.js";
import { parseColumnRef } from "../model/refs.js";
import {
  isNumericType,
  isTemporalType,
} from "../connectors/dialect.js";
import type { DatabaseSchema } from "../connectors/types.js";
import { isReservedInternalIdent, reservedInternalMessage } from "../compile/internal-namespace.js";
import { classifyMetricFilterField } from "../compile/metric-filter-support.js";

/**
 * Structural validation: is every semantic definition legal and analytically
 * safe? ("A type checker for analytics.")
 *
 * Config-only checks always run. Schema checks run when a live database
 * schema snapshot is provided.
 */

export interface ValidationIssue {
  severity: "error" | "warning";
  code: string;
  subject: string;
  message: string;
}

export interface MetricReport {
  metric: string;
  ok: boolean;
  entity: string;
  timeDimension: string | null;
  availableDimensions: string[];
  issues: ValidationIssue[];
}

export interface ValidationReport {
  ok: boolean;
  issues: ValidationIssue[];
  metrics: MetricReport[];
  dimensionCount: number;
  relationshipCount: number;
}

export function validateModel(model: SemanticModel, schema?: DatabaseSchema): ValidationReport {
  const issues: ValidationIssue[] = [];
  const tableColumns = buildSchemaIndex(schema);

  const columnExists = (table: string, column: string): boolean | null => {
    if (!tableColumns) return null;
    const columns = tableColumns.get(table);
    if (!columns) return false;
    return columns.has(column);
  };

  const columnType = (table: string, column: string): string | null =>
    tableColumns?.get(table)?.get(column) ?? null;

  const checkColumn = (subject: string, table: string, column: string): void => {
    if (!tableColumns) return;
    if (!tableColumns.has(table)) {
      issues.push({
        severity: "error",
        code: "missing_table",
        subject,
        message: `Table "${table}" does not exist in the database schema.`,
      });
    } else if (columnExists(table, column) === false) {
      issues.push({
        severity: "error",
        code: "missing_column",
        subject,
        message: `Column "${table}.${column}" does not exist in the database schema.`,
      });
    }
  };

  // --- Entities ---
  for (const entity of model.entities.values()) {
    if (isReservedInternalIdent(entity.name)) {
      issues.push({
        severity: "error",
        code: "reserved_internal_name",
        subject: `entity:${entity.name}`,
        message: reservedInternalMessage("Entity", entity.name),
      });
    }
    if (isReservedInternalIdent(entity.config.table)) {
      issues.push({
        severity: "error",
        code: "reserved_internal_name",
        subject: `entity:${entity.name}`,
        message: reservedInternalMessage("Entity table", entity.config.table),
      });
    }
    checkColumn(`entity:${entity.name}`, entity.config.table, entity.config.primary_key);
  }

  // --- Relationships ---
  for (const [name, rel] of Object.entries(model.config.relationships)) {
    const from = parseColumnRef(rel.from);
    const to = parseColumnRef(rel.to);
    if (!from || !to) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject: `relationship:${name}`,
        message: `Relationship references must use table.column form (from: "${rel.from}", to: "${rel.to}").`,
      });
      continue;
    }
    checkColumn(`relationship:${name}`, from.table, from.column);
    checkColumn(`relationship:${name}`, to.table, to.column);
  }

  // --- Dimensions ---
  for (const dimension of model.dimensions.values()) {
    const subject = `dimension:${dimension.name}`;
    if (isReservedInternalIdent(dimension.name)) {
      issues.push({
        severity: "error",
        code: "reserved_internal_name",
        subject,
        message: reservedInternalMessage("Dimension", dimension.name),
      });
    }
    if (!dimension.column.table) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject,
        message: `Dimension sql must be a \${table.column} reference (got "${dimension.config.sql}").`,
      });
      continue;
    }
    if (!model.entities.has(dimension.config.entity)) {
      issues.push({
        severity: "error",
        code: "unknown_entity",
        subject,
        message: `Dimension references undefined entity "${dimension.config.entity}".`,
      });
    }
    checkColumn(subject, dimension.column.table, dimension.column.column);
    if (dimension.config.type === "timestamp" || dimension.config.type === "date") {
      const type = columnType(dimension.column.table, dimension.column.column);
      if (type && !isTemporalType(type)) {
        issues.push({
          severity: "error",
          code: "type_mismatch",
          subject,
          message: `Dimension is declared ${dimension.config.type} but "${dimension.column.table}.${dimension.column.column}" has type ${type}.`,
        });
      }
    }
  }

  // --- Exploration policy ---
  for (const entry of model.config.exploration.exclude) {
    if (!parseColumnRef(entry)) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject: "exploration",
        message: `exploration.exclude entry "${entry}" must be a table.column reference.`,
      });
      continue;
    }
    const ref = parseColumnRef(entry)!;
    if (!tableColumns) continue;
    if (!tableColumns.has(ref.table) || !tableColumns.get(ref.table)!.has(ref.column)) {
      issues.push({
        severity: "warning",
        code: "unknown_exclude",
        subject: "exploration",
        message: `exploration.exclude "${entry}" was not found in the introspected schema.`,
      });
    }
  }
  const metricReports: MetricReport[] = [];
  for (const metric of model.metrics.values()) {
    const reserved: ValidationIssue[] = isReservedInternalIdent(metric.name)
      ? [
          {
            severity: "error",
            code: "reserved_internal_name",
            subject: `metric:${metric.name}`,
            message: reservedInternalMessage("Metric", metric.name),
          },
        ]
      : [];
    const metricIssues = [
      ...reserved,
      ...validateMetric(model, metric, checkColumnFactory(issues, tableColumns), columnType),
    ];
    issues.push(...metricIssues);
    const ok = metricIssues.every((i) => i.severity !== "error");
    metricReports.push({
      metric: metric.name,
      ok,
      entity: metric.config.entity,
      timeDimension: metric.timeDimension
        ? `${metric.timeDimension.table}.${metric.timeDimension.column}`
        : null,
      availableDimensions: ok ? model.availableDimensions(metric) : [],
      issues: metricIssues,
    });
  }

  const globalOk = issues.every((i) => i.severity !== "error");
  return {
    ok: globalOk,
    issues,
    metrics: metricReports,
    dimensionCount: model.dimensions.size,
    relationshipCount: Object.keys(model.config.relationships).length,
  };
}

type CheckColumn = (subject: string, table: string, column: string) => ValidationIssue[];

function checkColumnFactory(
  _globalIssues: ValidationIssue[],
  tableColumns: Map<string, Map<string, string>> | null,
): CheckColumn {
  return (subject, table, column) => {
    if (!tableColumns) return [];
    if (!tableColumns.has(table)) {
      return [
        {
          severity: "error",
          code: "missing_table",
          subject,
          message: `Table "${table}" does not exist in the database schema.`,
        },
      ];
    }
    if (!tableColumns.get(table)!.has(column)) {
      return [
        {
          severity: "error",
          code: "missing_column",
          subject,
          message: `Column "${table}.${column}" does not exist in the database schema.`,
        },
      ];
    }
    return [];
  };
}

function validateMetric(
  model: SemanticModel,
  metric: Metric,
  checkColumn: CheckColumn,
  columnType: (table: string, column: string) => string | null,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const subject = `metric:${metric.name}`;
  const config = metric.config;

  const baseTable = model.entityTable(config.entity);
  if (!baseTable) {
    issues.push({
      severity: "error",
      code: "unknown_entity",
      subject,
      message: `Metric references undefined entity "${config.entity}". Define it under "entities" in grane.yml.`,
    });
    return issues;
  }

  if (config.type === "ratio") {
    for (const [role, ref] of [
      ["numerator", config.numerator],
      ["denominator", config.denominator],
    ] as const) {
      if (!ref) continue;
      const component = model.metrics.get(ref);
      if (!component) {
        issues.push({
          severity: "error",
          code: "unknown_metric",
          subject,
          message: `Ratio ${role} "${ref}" is not a defined metric.`,
        });
      } else if (component.config.type === "ratio") {
        issues.push({
          severity: "error",
          code: "nested_ratio",
          subject,
          message: `Ratio ${role} "${ref}" is itself a ratio; nested ratios are not supported in V0.1.`,
        });
      } else if (component.config.entity !== config.entity) {
        issues.push({
          severity: "error",
          code: "grain_mismatch",
          subject,
          message: `Ratio ${role} "${ref}" has entity "${component.config.entity}" but the ratio is defined at entity "${config.entity}". Ratio components must share the metric's grain.`,
        });
      }
    }
    if (metric.filters.length > 0) {
      issues.push({
        severity: "error",
        code: "filter_out_of_scope",
        subject,
        message:
          `Ratio metric "${metric.name}" cannot carry its own metric filters; they are not applied to the ratio result. ` +
          `Put table.column predicates on the numerator and denominator metrics instead.`,
      });
    }
  } else {
    if (!metric.measure) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject,
        message: `Metric sql must be a \${table.column} reference (got "${config.sql}").`,
      });
      return issues;
    }
    if (metric.countsRows) {
      // COUNT(1) over the entity table: only the table has to exist.
      if (!model.entityTable(config.entity)) {
        issues.push({ severity: "error", code: "unknown_entity", subject, message: `Row-count metric needs a defined entity table.` });
      }
    } else {
      issues.push(...checkColumn(subject, metric.measure.table, metric.measure.column));
    }

    if (metric.semiAdditive) {
      if (metric.countsRows || !["sum", "min", "max"].includes(config.type)) {
        issues.push({
          severity: "error",
          code: "unsupported_semi_additive",
          subject,
          message: `Semi-additive metrics must be sum, min, or max of a column (got "${config.type}").`,
        });
      }
      if (!metric.timeDimension) {
        issues.push({
          severity: "error",
          code: "missing_time_dimension",
          subject,
          message: `Semi-additive metrics require a time_dimension to choose the snapshot within the time range.`,
        });
      }
      for (const key of metric.semiAdditive.keys) {
        if (!key.table || !key.column) {
          issues.push({
            severity: "error",
            code: "invalid_reference",
            subject,
            message: `semi_additive.group_by entry "${key.column}" must be a \${table.column} reference.`,
          });
        } else if (key.table !== baseTable) {
          issues.push({
            severity: "error",
            code: "filter_out_of_scope",
            subject,
            message: `semi_additive.group_by "${key.table}.${key.column}" must be a column on the entity table "${baseTable}".`,
          });
        } else {
          issues.push(...checkColumn(subject, key.table, key.column));
        }
      }
      const vacuousKeys = vacuousSnapshotSeriesKeys(model, metric);
      if (vacuousKeys.length > 0) {
        issues.push({
          severity: "error",
          code: "vacuous_semi_additive_group_by",
          subject,
          message: vacuousSnapshotSeriesMessage(metric, vacuousKeys),
        });
      }
    }

    // Measure reachability and fan-out safety.
    const path = model.graph.findPath(baseTable, metric.measure.table);
    if (!path) {
      issues.push({
        severity: "error",
        code: "unreachable_measure",
        subject,
        message: `No relationship path from entity table "${baseTable}" to measure table "${metric.measure.table}". Add the relationship to relationships.yml.`,
      });
    } else if (path.fansOut) {
      if (config.type === "count_distinct") {
        issues.push({
          severity: "error",
          code: "unsafe_fanout",
          subject,
          message:
            `Potential fan-out detected: "${baseTable}" -> "${metric.measure.table}" traverses a one_to_many relationship. ` +
            `count_distinct cannot be safely pre-aggregated across a fan-out in V0.1. ` +
            `Define the metric at the "${metric.measure.table}" grain instead.`,
        });
      }
      // Other aggregations are handled by deterministic pre-aggregation in the compiler.
    }

    if ((config.type === "sum" || config.type === "avg") && metric.measure && !metric.countsRows) {
      const type = columnType(metric.measure.table, metric.measure.column);
      if (type && !isNumericType(type)) {
        issues.push({
          severity: "error",
          code: "type_mismatch",
          subject,
          message: `Metric type "${config.type}" requires a numeric column but "${metric.measure.table}.${metric.measure.column}" has type ${type}.`,
        });
      }
    }
  }

  // Metric filters must parse and bind to a table the compiler will actually
  // place in the FILTER/WHERE clause. Unreachable or fan-out-only tables are
  // refused here and at compile time — never left for the warehouse binder.
  for (const filter of metric.filters) {
    const ref = parseColumnRef(filter.field);
    if (!ref) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject,
        message: `Metric filter field must be a table.column reference (got "${filter.field}").`,
      });
      continue;
    }
    issues.push(...checkColumn(subject, ref.table, ref.column));
    if (config.type === "ratio") continue;
    const bound = classifyMetricFilterField(model, metric, baseTable, filter.field);
    if (!bound.ok) {
      issues.push({
        severity: "error",
        code: "filter_out_of_scope",
        subject,
        message: bound.refusal.message,
      });
    }
  }

  // Time dimension.
  if (config.time_dimension) {
    if (!metric.timeDimension) {
      issues.push({
        severity: "error",
        code: "invalid_reference",
        subject,
        message: `time_dimension must be a \${table.column} reference (got "${config.time_dimension}").`,
      });
    } else {
      issues.push(...checkColumn(subject, metric.timeDimension.table, metric.timeDimension.column));
      const path = model.graph.findPath(baseTable, metric.timeDimension.table);
      if (!path) {
        issues.push({
          severity: "error",
          code: "unreachable_time_dimension",
          subject,
          message: `No relationship path from "${baseTable}" to time dimension table "${metric.timeDimension.table}".`,
        });
      } else if (path.fansOut) {
        issues.push({
          severity: "error",
          code: "unsafe_fanout",
          subject,
          message: `Time dimension "${config.time_dimension}" would fan out rows of "${baseTable}". Use a column at or above the metric's grain.`,
        });
      }
      const type = columnType(metric.timeDimension.table, metric.timeDimension.column);
      if (type && !isTemporalType(type)) {
        issues.push({
          severity: "error",
          code: "type_mismatch",
          subject,
          message: `time_dimension "${config.time_dimension}" has type ${type}; expected timestamp or date.`,
        });
      }
    }
  }

  return issues;
}

function buildSchemaIndex(schema?: DatabaseSchema): Map<string, Map<string, string>> | null {
  if (!schema) return null;
  const index = new Map<string, Map<string, string>>();
  for (const table of schema.tables) {
    const columns = new Map<string, string>();
    for (const column of table.columns) {
      columns.set(column.name, column.dataType);
    }
    index.set(table.name, columns);
  }
  return index;
}
