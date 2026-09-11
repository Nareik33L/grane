import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { AgentConfig, GraneConfig } from "../config/schema.js";
import { configError } from "../errors.js";

/**
 * The grant applied to one authenticated agent. `null` allow-lists mean the
 * full governed catalog (still subject to global exploration).
 */
export interface AgentGrant {
  id: string;
  metrics: string[] | null;
  dimensions: string[] | null;
  exploration: boolean;
  explorationExclude: string[];
}

export function configuredAgents(config: GraneConfig): AgentConfig[] {
  return config.auth.agents;
}

export function httpAuthRequired(config: GraneConfig): boolean {
  return configuredAgents(config).length > 0;
}

export function validateAuthConfig(config: GraneConfig): void {
  const agents = configuredAgents(config);
  const ids = new Set<string>();
  const tokenDigests = new Set<string>();
  for (const agent of agents) {
    if (ids.has(agent.id)) {
      throw configError(`Duplicate auth agent id "${agent.id}".`);
    }
    ids.add(agent.id);
    const digest = tokenDigest(agent);
    if (tokenDigests.has(digest)) {
      throw configError(`Duplicate auth token for agent "${agent.id}". Each agent needs its own token.`);
    }
    tokenDigests.add(digest);
  }
}

export function toGrant(agent: AgentConfig): AgentGrant {
  return {
    id: agent.id,
    metrics: agent.metrics && agent.metrics.length > 0 ? agent.metrics : null,
    dimensions: agent.dimensions && agent.dimensions.length > 0 ? agent.dimensions : null,
    exploration: agent.exploration,
    explorationExclude: agent.exploration_exclude ?? [],
  };
}

export function tokensEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

export function tokenDigest(agent: AgentConfig): string {
  if (agent.token_sha256) return agent.token_sha256.toLowerCase();
  if (agent.token) return createHash("sha256").update(agent.token).digest("hex");
  throw configError(`Agent "${agent.id}" has neither token nor token_sha256.`);
}

export function tokenMatches(agent: AgentConfig, presented: string): boolean {
  if (agent.token_sha256) {
    const expected = Buffer.from(agent.token_sha256, "hex");
    const actual = createHash("sha256").update(presented).digest();
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }
  if (agent.token) return tokensEqual(agent.token, presented);
  return false;
}

export function bearerTokenFromHeaders(headers: IncomingHttpHeaders): string | undefined {
  const auth = headerValue(headers.authorization);
  if (auth && /^Bearer\s+\S/i.test(auth)) {
    return auth.replace(/^Bearer\s+/i, "").trim();
  }
  const alt = headerValue(headers["x-grane-token"]);
  return alt?.trim() || undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export function authenticateAgent(
  config: GraneConfig,
  token: string | undefined,
): AgentGrant | "missing" | "invalid" {
  const agents = configuredAgents(config);
  if (agents.length === 0) {
    return { id: "anonymous", metrics: null, dimensions: null, exploration: true, explorationExclude: [] };
  }
  if (!token) return "missing";
  for (const agent of agents) {
    if (tokenMatches(agent, token)) return toGrant(agent);
  }
  return "invalid";
}

export function metricAllowed(grant: AgentGrant | null | undefined, name: string): boolean {
  if (!grant?.metrics) return true;
  return grant.metrics.includes(name);
}

export function dimensionAllowed(grant: AgentGrant | null | undefined, name: string): boolean {
  if (!grant?.dimensions) return true;
  return grant.dimensions.includes(name);
}
