import type { GraneConfig } from "./config/schema.js";
import { SemanticModel } from "./model/model.js";
import { createConnector } from "./connectors/create.js";
import type { WarehouseConnector } from "./connectors/types.js";
import type { DatabaseSchema } from "./connectors/types.js";
import { validateModel, type ValidationReport } from "./validate/validate.js";
import { resolveQuery, type ResolvedQuery } from "./query/resolve.js";
import type { SemanticQueryInput } from "./query/model.js";
import { compileQuery, type CompiledQuery } from "./compile/compiler.js";
import { executeCompiled, type QueryResult } from "./execute/executor.js";

export const GRANE_VERSION = "0.3.0";

export interface ServerInfo {
  name: "grane";
  version: string;
  query_model: "v1";
  database: string;
  capabilities: string[];
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
}

export interface CatalogDimension {
  name: string;
  description: string | null;
  entity: string;
  type: string | null;
}

export interface CatalogEntity {
  name: string;
  table: string;
  description: string | null;
}

export interface Catalog {
  server: ServerInfo;
  metrics: CatalogMetric[];
  dimensions: CatalogDimension[];
  entities: CatalogEntity[];
}

export interface ExplainResult {
  trust: "governed";
  query_model: "v1";
  entity: string;
  base_table: string;
  metrics: Record<
    string,
    { description: string | null; type: string; definition_version: string; status: string }
  >;
  plan: CompiledQuery["plan"];
  generated_sql: string;
  params: unknown[];
  notes: string[];
}

/**
 * The Grane kernel: a loaded semantic model bound to a database connection.
 * The CLI and the MCP server are both thin layers over this class.
 */
export class GraneKernel {
  readonly model: SemanticModel;
  readonly config: GraneConfig;
  private connector: WarehouseConnector | null = null;

  constructor(config: GraneConfig) {
    this.config = config;
    this.model = new SemanticModel(config);
  }

  serverInfo(): ServerInfo {
    return {
      name: "grane",
      version: GRANE_VERSION,
      query_model: "v1",
      database: this.config.connection.type,
      capabilities: ["metrics", "dimensions", "filters", "time_grains", "ordering", "provenance"],
    };
  }

  getConnector(): WarehouseConnector {
    if (!this.connector) {
      this.connector = createConnector(this.config.connection);
    }
    return this.connector;
  }

  async close(): Promise<void> {
    if (this.connector) {
      await this.connector.close();
      this.connector = null;
    }
  }

  async introspectSchema(): Promise<DatabaseSchema> {
    return this.getConnector().introspect();
  }

  /** Structural validation; pass a schema snapshot for live checks. */
  validate(schema?: DatabaseSchema): ValidationReport {
    return validateModel(this.model, schema);
  }

  catalog(search?: string): Catalog {
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
        available_dimensions: this.model.availableDimensions(m),
      }));
    const dimensions = [...this.model.dimensions.values()]
      .filter((d) => !filter || filter.dimensions.includes(d.name))
      .map((d) => ({
        name: d.name,
        description: d.config.description ?? null,
        entity: d.config.entity,
        type: d.config.type ?? null,
      }));
    const entities = [...this.model.entities.values()]
      .filter((e) => !filter || filter.entities.includes(e.name))
      .map((e) => ({
        name: e.name,
        table: e.config.table,
        description: e.config.description ?? null,
      }));
    return { server: this.serverInfo(), metrics, dimensions, entities };
  }

  resolve(input: SemanticQueryInput): ResolvedQuery {
    return resolveQuery(this.model, input, {
      defaultRows: this.config.limits.default_rows,
      maxRows: this.config.limits.max_rows,
    });
  }

  compile(input: SemanticQueryInput): { resolved: ResolvedQuery; compiled: CompiledQuery } {
    const resolved = this.resolve(input);
    const compiled = compileQuery(this.model, resolved);
    return { resolved, compiled };
  }

  /** Validate + compile without executing (dry run). */
  explain(input: SemanticQueryInput): ExplainResult {
    const { resolved, compiled } = this.compile(input);
    return {
      trust: "governed",
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
          },
        ]),
      ),
      plan: compiled.plan,
      generated_sql: compiled.sql,
      params: compiled.params,
      notes: resolved.notes,
    };
  }

  /** The full governed path: resolve -> validate -> compile -> execute -> provenance. */
  async query(input: SemanticQueryInput): Promise<QueryResult & { notes: string[] }> {
    const { resolved, compiled } = this.compile(input);
    const result = await executeCompiled(this.getConnector(), compiled, this.config.limits);
    return { ...result, notes: resolved.notes };
  }
}
