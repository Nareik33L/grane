import { createHash } from "node:crypto";
import {
  recordDiscoveryAudit,
  refusalFromError,
  type DiscoveryAuditInput,
  type HttpAuditContext,
} from "../audit.js";
import type { GraneConfig, LimitsConfig } from "../config/schema.js";
import { inferRelationships } from "../discover/relationships.js";
import type { InferredRelationship } from "../discover/relationships.js";
import type { DatabaseSchema, ExecutedRows, TableInfo, WarehouseConnector } from "../connectors/types.js";
import { isWriteSql, stripLeadingSqlComments } from "../connectors/types.js";
import {
  GraneError,
  columnNotPermitted,
  explorationDisabled,
  undefinedColumn,
  unsafeQuery,
} from "../errors.js";
import {
  explorationPolicy,
  isExplorable,
  isSchemaAllowed,
  matchesAnyPattern,
} from "../explore/policy.js";

/** Hard ceiling for sampled rows. Config and callers cannot exceed this. */
export const DISCOVERY_SAMPLE_ROW_HARD_CAP = 50;

export interface DiscoveryOptions {
  config: GraneConfig;
  connector: WarehouseConnector;
  projectDir?: string;
  sessionId?: string | null;
  agent?: string | null;
  http?: HttpAuditContext | null;
  /**
   * When false, this instance does not write audit lines (the caller owns the
   * single outer line). Default true so CLI/setup discovery still logs.
   */
  audit?: boolean;
  /** Override setup sampling decision. Default: config.authoring.sampling (on). */
  sampling?: boolean;
  /** Requested sample rows; clamped to {@link DISCOVERY_SAMPLE_ROW_HARD_CAP}. */
  sampleRows?: number;
  timeoutMs?: number;
}

export interface ColumnProfile {
  table: string;
  column: string;
  schema: string;
  distinctCount: number | null;
  samples: unknown[];
  sampleHash?: string;
  sql: string[];
}

export interface Discovery {
  introspectSchema(): Promise<DatabaseSchema>;
  inferRelationships(schema: DatabaseSchema): Promise<Record<string, InferredRelationship>>;
  profileColumn(table: string, column: string): Promise<ColumnProfile>;
}

const DISCOVERY_HEAD = /^(select|with)\b/i;
const DISCOVERY_WITH_WRITE =
  /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum|merge|call|do|optimize|execute|commit|rollback|begin)\b/i;

/** Driver errors are collapsed to this so DSN, passwords, and samples never leak. */
export const DISCOVERY_WAREHOUSE_ERROR = "Warehouse query failed.";

/**
 * Refuse anything that is not a single SELECT/WITH statement. Discovery
 * profiling always goes through this so multi-statement or SET/ATTACH/PRAGMA
 * input cannot skip `isWriteSql` (which only inspects the first keyword).
 */
export function assertDiscoverySql(sql: string): void {
  if (typeof sql !== "string" || !sql.trim()) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
  const structural = stripSqlCommentsAndLiterals(sql);
  const single = structural.replace(/;+\s*$/, "").trim();
  if (!single) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
  if (single.includes(";")) {
    throw unsafeQuery("Refusing to execute multiple SQL statements.");
  }
  const head = stripLeadingSqlComments(sql);
  if (!DISCOVERY_HEAD.test(head) || isWriteSql(sql)) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
  const keyword = head.match(/^([A-Za-z_]+)/)?.[1]?.toLowerCase();
  if (keyword === "with" && DISCOVERY_WITH_WRITE.test(structural)) {
    throw unsafeQuery("Refusing to execute a non-SELECT statement.");
  }
}

/**
 * Strip comments and string/identifier literals so `;` and keywords are
 * checked against statement structure, not contents.
 */
export function stripSqlCommentsAndLiterals(sql: string): string {
  let i = 0;
  let out = "";
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    const next = i + 1 < n ? sql[i + 1] : "";
    if (c === "-" && next === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n" && sql[i] !== "\r") i += 1;
      out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i + 1 < n && !(sql[i] === "*" && sql[i + 1] === "/")) i += 1;
      i = i + 1 < n ? i + 2 : n;
      out += " ";
      continue;
    }
    if (c === "$") {
      const tag = dollarQuoteTag(sql, i);
      if (tag) {
        const close = sql.indexOf(tag, i + tag.length);
        if (close === -1) break;
        i = close + tag.length;
        out += " ";
        continue;
      }
    }
    if (c === "'" || c === '"' || c === "`") {
      i = skipQuotedLiteral(sql, i, c);
      out += " ";
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function dollarQuoteTag(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j += 1;
  if (sql[j] === "$") return sql.slice(i, j + 1);
  return null;
}

function skipQuotedLiteral(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i += 1;
  }
  return sql.length;
}

export function redactDriverError(err: unknown): string {
  const code =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? (err as { code: string }).code
      : "";
  if (/^[0-9A-Z]{5}$/.test(code)) return `${DISCOVERY_WAREHOUSE_ERROR} (${code}).`;
  return DISCOVERY_WAREHOUSE_ERROR;
}

function sanitizeDiscoveryError(err: unknown): Error {
  if (err instanceof GraneError) return err;
  if (err instanceof Error && err.message.startsWith(DISCOVERY_WAREHOUSE_ERROR)) return err;
  return new Error(redactDriverError(err));
}

/**
 * @internal Discovery-only query path. Not part of the public API — callers
 * must go through {@link createDiscovery}.
 */
export async function runDiscoveryQuery(
  connector: WarehouseConnector,
  sql: string,
  limits: LimitsConfig,
): Promise<ExecutedRows> {
  assertDiscoverySql(sql);
  try {
    return await connector.query(sql, [], limits);
  } catch (err) {
    throw sanitizeDiscoveryError(err);
  }
}

export function clampDiscoverySampleRows(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return 1;
  return Math.min(Math.floor(requested), DISCOVERY_SAMPLE_ROW_HARD_CAP);
}

export function hashDiscoverySnapshot(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const sampling = options.sampling ?? options.config.authoring.sampling;
  const sampleRows = clampDiscoverySampleRows(options.sampleRows ?? options.config.authoring.sample_rows);
  const timeoutMs = options.timeoutMs ?? options.config.limits.timeout_ms;
  const limits: LimitsConfig = {
    ...options.config.limits,
    timeout_ms: timeoutMs,
    max_rows: Math.max(options.config.limits.max_rows, sampleRows),
  };
  const sessionId = options.sessionId ?? null;
  const agent = options.agent ?? null;
  const policy = explorationPolicy(options.config);

  const emit = (input: Omit<DiscoveryAuditInput, "session_id" | "agent" | "connector">): void => {
    if (options.audit === false) return;
    recordDiscoveryAudit(options.config, options.projectDir, {
      ...input,
      session_id: sessionId,
      agent,
      connector: options.connector.type,
      http: options.http,
    });
  };

  const introspectSchema = async (): Promise<DatabaseSchema> => {
    const started = Date.now();
    let schema: DatabaseSchema;
    try {
      schema = await options.connector.introspect();
    } catch (err) {
      const safe = sanitizeDiscoveryError(err);
      emit({
        operation: "introspect",
        target: {},
        sql: [`/* connector.introspect() ${options.connector.type} */`],
        row_count: 0,
        duration_ms: Date.now() - started,
        refusal: refusalFromError(safe),
      });
      throw safe;
    }
    const columnCount = schema.tables.reduce((n, table) => n + table.columns.length, 0);
    emit({
      operation: "introspect",
      target: { schema: schema.schemaName },
      sql: [`/* connector.introspect() ${options.connector.type} */`],
      row_count: columnCount,
      duration_ms: Date.now() - started,
      snapshot_hash: hashDiscoverySnapshot(canonicalSchema(schema)),
    });
    return schema;
  };

  const infer = async (schema: DatabaseSchema): Promise<Record<string, InferredRelationship>> => {
    const started = Date.now();
    let inferred: Record<string, InferredRelationship>;
    try {
      inferred = inferRelationships(schema);
    } catch (err) {
      const safe = sanitizeDiscoveryError(err);
      emit({
        operation: "relationships",
        target: { schema: schema.schemaName },
        sql: [],
        row_count: 0,
        duration_ms: Date.now() - started,
        refusal: refusalFromError(safe),
      });
      throw safe;
    }
    emit({
      operation: "relationships",
      target: { schema: schema.schemaName },
      sql: [],
      row_count: Object.keys(inferred).length,
      duration_ms: Date.now() - started,
      snapshot_hash: hashDiscoverySnapshot(inferred),
    });
    return inferred;
  };

  const profileColumn = async (table: string, column: string): Promise<ColumnProfile> => {
    const started = Date.now();
    const requested = `${table}.${column}`;
    const sql: string[] = [];
    const target = { table, column };
    let profile: ColumnProfile;
    try {
      profile = await profileWork(table, column, requested, sql);
    } catch (err) {
      const safe = sanitizeDiscoveryError(err);
      emit({
        operation: "profile",
        target,
        sql,
        row_count: 0,
        duration_ms: Date.now() - started,
        refusal: refusalFromError(safe),
      });
      throw safe;
    }
    emit({
      operation: "profile",
      target: { schema: profile.schema, table: profile.table, column: profile.column },
      sql: profile.sql,
      row_count: sampling ? profile.samples.length : profile.distinctCount ?? 0,
      duration_ms: Date.now() - started,
      snapshot_hash: profile.sampleHash ?? hashDiscoverySnapshot({ distinctCount: profile.distinctCount }),
    });
    return profile;
  };

  async function profileWork(
    table: string,
    column: string,
    requested: string,
    sql: string[],
  ): Promise<ColumnProfile> {
    if (!policy.enabled) {
      throw explorationDisabled(requested);
    }
    const schema = await options.connector.introspect();
    const found = findColumn(schema, table, column);
    if (!found) {
      throw undefinedColumn(requested, similarColumns(schema, requested));
    }
    if (!isSchemaAllowed(policy, found.table.schema)) {
      throw columnNotPermitted(
        `${requested} (schema "${found.table.schema}" is not in exploration.schemas)`,
      );
    }
    if (!isExplorable(policy, found.table.name, found.column)) {
      const allowlistMiss =
        policy.mode === "allowlist" && !matchesAnyPattern(policy.include, found.table.name, found.column);
      throw columnNotPermitted(requested, allowlistMiss ? "allowlist" : "excluded");
    }
    assertSafeIdent(found.table.schema || "public");
    assertSafeIdent(found.table.name);
    assertSafeIdent(found.column);

    const dialect = options.connector.dialect;
    const tableSql = dialect.qualifyTable(found.table.schema, found.table.name);
    const colSql = dialect.ident(found.column);
    const distinctSql = `SELECT COUNT(DISTINCT ${colSql}) AS n FROM ${tableSql}`;
    sql.push(distinctSql);
    const distinctRows = await runDiscoveryQuery(options.connector, distinctSql, limits);
    const distinctCount = parseCount(distinctRows.rows[0]?.n);

    let samples: unknown[] = [];
    let sampleHash: string | undefined;
    if (sampling) {
      const sampleSql = `SELECT ${colSql} AS v FROM ${tableSql} LIMIT ${sampleRows}`;
      sql.push(sampleSql);
      const sampleRowsResult = await runDiscoveryQuery(options.connector, sampleSql, limits);
      samples = sampleRowsResult.rows.map((row) => canonicalizeValue(row.v));
      sampleHash = hashDiscoverySnapshot(samples);
    }

    return {
      table: found.table.name,
      column: found.column,
      schema: found.table.schema,
      distinctCount,
      samples,
      sampleHash,
      sql: [...sql],
    };
  }

  return { introspectSchema, inferRelationships: infer, profileColumn };
}

function assertSafeIdent(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw unsafeQuery(`Refusing discovery on unsafe identifier "${name}".`);
  }
}

function findColumn(
  schema: DatabaseSchema,
  table: string,
  column: string,
): { table: TableInfo; column: string } | null {
  const tbl =
    schema.tables.find((item) => item.name === table) ??
    schema.tables.find((item) => item.name.toLowerCase() === table.toLowerCase());
  if (!tbl) return null;
  const col =
    tbl.columns.find((item) => item.name === column) ??
    tbl.columns.find((item) => item.name.toLowerCase() === column.toLowerCase());
  if (!col) return null;
  return { table: tbl, column: col.name };
}

function similarColumns(schema: DatabaseSchema, requested: string): string[] {
  const lower = requested.toLowerCase();
  return schema.tables
    .flatMap((table) => table.columns.map((column) => `${table.name}.${column.name}`))
    .filter((name) => {
      const candidate = name.toLowerCase();
      return candidate.includes(lower) || lower.includes(candidate);
    })
    .slice(0, 5);
}

function parseCount(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) ? n : null;
}

function canonicalSchema(schema: DatabaseSchema): unknown {
  return {
    schemaName: schema.schemaName,
    tables: [...schema.tables]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((table) => ({
        schema: table.schema,
        name: table.name,
        columns: [...table.columns]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((column) => ({ name: column.name, dataType: column.dataType, nullable: column.nullable })),
      })),
    foreignKeys: [...schema.foreignKeys]
      .map((fk) => ({
        constraintName: fk.constraintName,
        table: fk.table,
        column: fk.column,
        refTable: fk.refTable,
        refColumn: fk.refColumn,
      }))
      .sort((a, b) => a.constraintName.localeCompare(b.constraintName)),
  };
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return value.toString();
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("hex");
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value);
}
