/** Grane public API. */

export { GraneKernel, GRANE_VERSION } from "./kernel.js";
export { loadConfig, findProjectDir } from "./config/load.js";
export {
  graneConfigSchema,
  type GraneConfig,
  type MetricConfig,
  type DimensionConfig,
  type RelationshipConfig,
} from "./config/schema.js";
export { SemanticModel, type Metric, type Dimension } from "./model/model.js";
export { RelationshipGraph } from "./model/graph.js";
export { parseColumnRef } from "./model/refs.js";
export { validateModel, type ValidationReport } from "./validate/validate.js";
export {
  semanticQuerySchema,
  QUERY_MODEL_VERSION,
  type SemanticQuery,
  type SemanticQueryInput,
} from "./query/model.js";
export { resolveQuery, type ResolvedQuery } from "./query/resolve.js";
export { resolveRelativeRange, todayInTimeZone } from "./query/time.js";
export { compileQuery, type CompiledQuery } from "./compile/compiler.js";
export { executeCompiled, type QueryResult, type Provenance } from "./execute/executor.js";
export { introspect, inferRelationships, type DatabaseSchema } from "./connectors/postgres/introspect.js";
export { buildMcpServer } from "./mcp/server.js";
export { serveStdio, serveHttp } from "./mcp/transport.js";
export { GraneError, type Refusal } from "./errors.js";
