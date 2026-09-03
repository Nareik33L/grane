import type { GraneConfig } from "./config/schema.js";
import { SemanticModel } from "./model/model.js";
import { createConnector } from "./connectors/create.js";
import type { WarehouseConnector } from "./connectors/types.js";
import type { DatabaseSchema } from "./connectors/types.js";
import { validateModel, type ValidationReport } from "./validate/validate.js";
import { resolveQuery, queryNeedsSchema, type ResolvedQuery } from "./query/resolve.js";
import type { SemanticQueryInput, TrustLevel } from "./query/model.js";
import { compileQuery, type CompiledQuery } from "./compile/compiler.js";
import { executeCompiled, type QueryResult } from "./execute/executor.js";
import { explorationPolicy } from "./explore/policy.js";
import { listExplorableColumns, type ExplorableColumn } from "./explore/raw.js";
import { recordRawUsage } from "./explore/usage.js";
import type { AgentGrant } from "./auth/agents.js";
import { dimensionAllowed, metricAllowed } from "./auth/agents.js";
import { recordAudit, refusalFromError } from "./audit.js";
import type { SemanticAuditEvent } from "./audit.js";

export const GRANE_VERSION = "0.6.4";

export interface ServerInfo {
  name: "grane";
  version: string;
  query_model: "v1";
  database: string;
  capabilities: string[];
  exploration: { enabled: boolean };
  semantic_providers: string[];
  agent: string | null;
}

export interface CatalogMetric {
  name: string;
  description: string | null;
  entity: string;
  type: string;
  unit: string | null;
  status: string;
  synonyms: string[];
  time_dimension: string | null;
  definition_version: string;
  available_dimensions: string[];
  source: { provider: string; path?: string };
}

export interface CatalogDimension {
  name: string;
  description: string | null;
  entity: string;
  type: string | null;
  source: { provider: string; path?: string };
}

export interface CatalogEntity {
  name: string;
  table: string;
  description: string | null;
  source: { provider: string; path?: string };
}

export interface CatalogExploration {
  enabled: boolean;
  schemas: string[];
  excluded: string[];
  columns: ExplorableColumn[];
}

/**
 * An upstream definition (dbt/MetricFlow, …) Grane saw and deliberately did
 * not import. Requesting it refuses with `undefined_metric` and this reason.
 */
export interface CatalogUnsupported {
  kind: "metric" | "dimension" | "entity" | "relationship";
  name: string;
  reason: string;
  source: { provider: string; path?: string };
}

export interface Catalog {
  server: ServerInfo;
  metrics: CatalogMetric[];
  dimensions: CatalogDimension[];
  entities: CatalogEntity[];
  unsupported: CatalogUnsupported[];
  exploration: CatalogExploration;
}

export interface ExplainResult {
  trust: TrustLevel;
  governed: string[];
  ungoverned: string[];
  warning: string | null;
  query_model: "v1";
  entity: string | null;
  base_table: string;
  metrics: Record<
    string,
    {
      description: string | null;
      type: string;
      definition_version: string;
      status: string;
      source: { provider: string; path?: string };
    }
  >;
  plan: CompiledQuery["plan"];
  generated_sql: string;
  params: unknown[];
  notes: string[];
}

export interface KernelOptions {
  projectDir?: string;
  schema?: DatabaseSchema;
  providerWarnings?: string[];
  now?: Date;
  agent?: AgentGrant | null;
  connector?: WarehouseConnector | null;
}

/**
 * The Grane kernel: a loaded semantic model bound to a database connection.
 * The CLI and the MCP server are both thin layers over this class.
 */
export class GraneKernel {
  readonly model: SemanticModel;
  readonly config: GraneConfig;
  readonly projectDir: string | undefined;
  readonly providerWarnings: string[];
  readonly agent: AgentGrant | null;
  private readonly now: Date | undefined;
  private connector: WarehouseConnector | null = null;
  private schemaCache: DatabaseSchema | null = null;

  constructor(config: GraneConfig, options: KernelOptions = {}) {
    this.config = config;
    this.model = new SemanticModel(config);
    this.projectDir = options.projectDir;
    this.schemaCache = options.schema ?? null;
    this.providerWarnings = options.providerWarnings ?? [];
    this.agent = options.agent ?? null;
    this.now = options.now;
    this.connector = options.connector ?? null;
  }

  serverInfo(): ServerInfo {
    const capabilities = [
      "metrics",
      "dimensions",
      "filters",
      "time_grains",
      "time_periods",
      "ordering",
      "provenance",
    ];
    if (this.config.exploration.enabled) {
      capabilities.push("exploration", "raw_dimensions", "raw_metrics");
    }
    const names = new Set<string>(["native"]);
    for (const spec of this.config.providers) {
      const type = (spec.type ?? "auto").trim().toLowerCase();
      if (type && type !== "auto") names.add(type);
    }
    for (const collection of [
      this.config.metrics,
      this.config.entities,
      this.config.dimensions,
      this.config.relationships,
    ]) {
      for (const item of Object.values(collection)) {
        if (item.source?.provider) names.add(item.source.provider);
      }
    }
    const semantic_providers = [...names];
    if (this.config.providers.length > 0) {
      capabilities.push("semantic_providers");
    }
    if (this.config.auth.agents.length > 0) {
      capabilities.push("agent_auth");
    }
    if (this.config.audit.enabled) {
      capabilities.push("audit");
    }
    return {
      name: "grane",
      version: GRANE_VERSION,
      query_model: "v1",
      database: this.config.connection.type,
      capabilities,
      exploration: { enabled: this.config.exploration.enabled },
      semantic_providers: [...new Set(semantic_providers)],
      agent: this.agent?.id ?? null,
    };
  }

  getConnector(): WarehouseConnector {
    if (!this.connector) {
      this.connector = createConnector(this.config.connection);
    }
    return this.connector;
  }

  setSchema(schema: DatabaseSchema): void {
    this.schemaCache = schema;
  }

  async loadSchema(): Promise<DatabaseSchema> {
    if (!this.schemaCache) {
      this.schemaCache = await this.getConnector().introspect();
    }
    return this.schemaCache;
  }

  async close(): Promise<void> {
    if (this.connector) {
      await this.connector.close();
      this.connector = null;
    }
  }

  async introspectSchema(): Promise<DatabaseSchema> {
    const schema = await this.getConnector().introspect();
    this.schemaCache = schema;
    return schema;
  }

  /** Structural validation; pass a schema snapshot for live checks. */
  validate(schema?: DatabaseSchema): ValidationReport {
    return validateModel(this.model, schema);
  }

  /** Governed catalog (sync). Prefer catalog() when exploration columns are needed. */
  governedCatalog(search?: string): Omit<Catalog, "exploration"> {
    const filter = search ? this.model.search(search) : null;
    const metrics = [...this.model.metrics.values()]
      .filter((m) => !filter || filter.metrics.includes(m.name))
      .map((m) => ({
        name: m.name,
        description: m.config.description ?? null,
        entity: m.config.entity,
        type: m.config.type,
        unit: m.config.unit ?? null,
        status: m.config.status,
        synonyms: m.config.synonyms,
        time_dimension: m.timeDimension ? `${m.timeDimension.table}.${m.timeDimension.column}` : null,
        definition_version: m.definitionVersion,
        available_dimensions: this.model.availableDimensions(m).filter((name) => dimensionAllowed(this.agent, name)),
        source: m.config.source ?? { provider: "native" },
      }))
      .filter((m) => metricAllowed(this.agent, m.name));
    const dimensions = [...this.model.dimensions.values()]
      .filter((d) => !filter || filter.dimensions.includes(d.name))
      .map((d) => ({
        name: d.name,
        description: d.config.description ?? null,
        entity: d.config.entity,
        type: d.config.type ?? null,
        source: d.config.source ?? { provider: "native" },
      }))
      .filter((d) => dimensionAllowed(this.agent, d.name));
    const entities = [...this.model.entities.values()]
      .filter((e) => !filter || filter.entities.includes(e.name))
      .map((e) => ({
        name: e.name,
        table: e.config.table,
        description: e.config.description ?? null,
        source: e.config.source ?? { provider: "native" },
      }));
    const unsupported = this.config.unsupported
      .filter((u) => !filter || u.name.toLowerCase().includes(search!.toLowerCase()))
      .map((u) => ({
        kind: u.kind,
        name: u.name,
        reason: u.reason,
        source: { provider: u.provider, ...(u.path ? { path: u.path } : {}) },
      }));
    return { server: this.serverInfo(), metrics, dimensions, entities, unsupported };
  }

  async catalog(search?: string): Promise<Catalog> {
    const governed = this.governedCatalog(search);
    const policy = explorationPolicy(this.config);
    if (!policy.enabled) {
      return {
        ...governed,
        exploration: { enabled: false, schemas: [], excluded: this.config.exploration.exclude, columns: [] },
      };
    }
    const schema = await this.loadSchema();
    return {
      ...governed,
      exploration: {
        enabled: true,
        schemas: policy.schemas,
        excluded: this.config.exploration.exclude,
        columns: listExplorableColumns(this.model, schema, search),
      },
    };
  }

  resolve(input: SemanticQueryInput): ResolvedQuery {
    return resolveQuery(this.model, input, {
      defaultRows: this.config.limits.default_rows,
      maxRows: this.config.limits.max_rows,
      schema: this.schemaCache,
      now: this.now,
      agent: this.agent,
    });
  }

  /**
   * A kernel bound to one authenticated agent. Shares the warehouse connector
   * and schema cache. Catalog and resolve honour that agent's allow-lists.
   */
  bindAgent(grant: AgentGrant): GraneKernel {
    const config: GraneConfig = {
      ...this.config,
      exploration: {
        ...this.config.exploration,
        enabled: this.config.exploration.enabled && grant.exploration,
      },
    };
    return new GraneKernel(config, {
      projectDir: this.projectDir,
      schema: this.schemaCache ?? undefined,
      providerWarnings: this.providerWarnings,
      now: this.now,
      agent: grant,
      connector: this.connector,
    });
  }

  compile(input: SemanticQueryInput): { resolved: ResolvedQuery; compiled: CompiledQuery } {
    const resolved = this.resolve(input);
    const compiled = compileQuery(this.model, resolved);
    return { resolved, compiled };
  }

  private async compileReady(input: SemanticQueryInput): Promise<{
    resolved: ResolvedQuery;
    compiled: CompiledQuery;
  }> {
    if (queryNeedsSchema(input, this.model)) {
      await this.loadSchema();
    }
    return this.compile(input);
  }

  private audit(event: Omit<SemanticAuditEvent, "ts" | "agent">): void {
    recordAudit(this.config, this.projectDir, {
      ts: new Date().toISOString(),
      agent: this.agent?.id ?? null,
      ...event,
    });
  }

  /** Validate + compile without executing (dry run). */
  async explain(input: SemanticQueryInput): Promise<ExplainResult> {
    try {
      const { resolved, compiled } = await this.compileReady(input);
      return {
        trust: resolved.trust,
        governed: resolved.governed,
        ungoverned: resolved.ungoverned,
        warning: resolved.warning,
        query_model: "v1",
        entity: resolved.entity,
        base_table: resolved.baseTable,
        metrics: Object.fromEntries(
          resolved.metrics.map((m) => [
            m.name,
            {
              description: m.config.description ?? null,
              type: m.config.type,
              definition_version: m.definitionVersion,
              status: m.config.status,
              source: m.config.source ?? { provider: "native" },
            },
          ]),
        ),
        plan: compiled.plan,
        generated_sql: compiled.sql,
        params: compiled.params,
        notes: resolved.notes,
      };
    } catch (err) {
      this.audit({
        kind: "refusal",
        operation: "explain",
        query: input,
        refusal: refusalFromError(err),
      });
      throw err;
    }
  }

  /** Resolve -> validate -> compile -> execute. Trust reflects governed vs raw fields. */
  async query(input: SemanticQueryInput): Promise<QueryResult & { notes: string[] }> {
    const started = Date.now();
    let sql: string | undefined;
    let trust: QueryResult["trust"] | undefined;
    try {
      const { resolved, compiled } = await this.compileReady(input);
      sql = compiled.sql;
      trust = compiled.trust;
      const result = await executeCompiled(this.getConnector(), compiled, this.config.limits);
      if (this.projectDir && resolved.ungoverned.length > 0) {
        try {
          recordRawUsage(this.projectDir, resolved.ungoverned);
        } catch {
          // Usage tracking is best-effort and must not fail a query.
        }
      }
      this.audit({
        kind: "query",
        operation: "query",
        query: input,
        trust: result.trust,
        query_id: result.provenance.query_id,
        sql: compiled.sql,
        row_count: result.provenance.row_count,
        duration_ms: result.provenance.duration_ms,
      });
      return { ...result, notes: resolved.notes };
    } catch (err) {
      this.audit({
        kind: "refusal",
        operation: "query",
        query: input,
        ...(trust ? { trust } : {}),
        ...(sql ? { sql } : {}),
        duration_ms: Date.now() - started,
        refusal: refusalFromError(err),
      });
      throw err;
    }
  }
}
