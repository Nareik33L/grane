/** Grane public API. */

export { GraneKernel, GRANE_VERSION } from "./kernel.js";
export { loadConfig, findProjectDir } from "./config/load.js";
export {
  graneConfigSchema,
  type GraneConfig,
  type MetricConfig,
  type DimensionConfig,
  type RelationshipConfig,
  type ExplorationConfig,
  type SemanticProviderConfig,
  type DefinitionSource,
  type AuthConfig,
  type AgentConfig,
  type AuditConfig,
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
  type TrustLevel,
} from "./query/model.js";
export { trustHeadline, TRUST_HEADLINES } from "./query/trust.js";
export { resolveQuery, resolveRowLimit, type ResolvedQuery, type RowLimitSource } from "./query/resolve.js";
export { resolveRelativeRange, todayInTimeZone, isValidCivilDate } from "./query/time.js";
export { compileQuery, type CompiledQuery } from "./compile/compiler.js";
export {
  executeCompiled,
  resultCompleteness,
  type QueryResult,
  type Provenance,
  type ResultCompleteness,
  type CompletenessStatus,
} from "./execute/executor.js";
export { inferRelationships, type DatabaseSchema } from "./connectors/types.js";
export { createConnector } from "./connectors/create.js";
export { getDialect, WAREHOUSE_TYPES } from "./connectors/dialect.js";
export { buildMcpServer } from "./mcp/server.js";
export { serveStdio, serveHttp, type HttpMcpHandle } from "./mcp/transport.js";
export {
  CLIENT_IDS,
  connectMcp,
  printMcpConfig,
  resolveClient,
  resolveGraneLaunch,
  runDoctor,
} from "./mcp/connect/index.js";
export type { ClientId, Transport } from "./mcp/connect/index.js";
export { GraneError, type Refusal, ambiguousQuery, invalidQuery, unsafeQuery } from "./errors.js";
export { explorationPolicy } from "./explore/policy.js";
export { listExplorableColumns } from "./explore/raw.js";
export { promoteColumn, planPromotion } from "./explore/promote.js";
export { authenticateAgent, bearerTokenFromHeaders, httpAuthRequired } from "./auth/agents.js";
export type { AgentGrant } from "./auth/agents.js";
export { recordAudit, type AuditEvent } from "./audit.js";
export { loadConfiguredProviders, SUPPORTED_PROVIDER_TYPES, detectConnectorKinds } from "./providers/registry.js";
export type { SemanticContribution, SemanticProviderLoader } from "./providers/types.js";
