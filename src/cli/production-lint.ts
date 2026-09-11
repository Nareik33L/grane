import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { GraneConfig } from "../config/schema.js";
import { resolveAuditPath } from "../audit.js";

/**
 * Production fail-open ceilings. Values *above* these fail
 * `grane validate --production` / `grane doctor --production`.
 * Equal to the schema defaults is allowed.
 */
export const PRODUCTION_LIMIT_CEILINGS = {
  max_rows: 10_000,
  default_rows: 1_000,
  timeout_ms: 30_000,
  max_concurrency: 32,
} as const;

export interface ProductionCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ProductionLint {
  ok: boolean;
  checks: ProductionCheck[];
}

export function lintProduction(config: GraneConfig, projectDir: string | undefined): ProductionLint {
  const checks: ProductionCheck[] = [];

  const agents = config.auth.agents;
  if (agents.length === 0) {
    checks.push({
      name: "auth.agents",
      ok: false,
      detail: "no agents configured; production HTTP would be unauthenticated",
    });
  } else {
    checks.push({
      name: "auth.agents",
      ok: true,
      detail: `${agents.length} agent(s)`,
    });
  }

  const exploring = agents.filter((agent) => agent.exploration);
  if (exploring.length > 0) {
    checks.push({
      name: "exploration",
      ok: false,
      detail: `agent(s) with exploration: true: ${exploring.map((a) => a.id).join(", ")}`,
    });
  } else {
    checks.push({
      name: "exploration",
      ok: true,
      detail: agents.length === 0 ? "no agents" : "no agent has exploration: true",
    });
  }

  if (config.connection.ssl && config.connection.ssl_verify === false) {
    checks.push({
      name: "tls",
      ok: false,
      detail: "connection.ssl_verify is false; certificates are not verified",
    });
  } else {
    checks.push({
      name: "tls",
      ok: true,
      detail: config.connection.ssl
        ? "connection.ssl is on and certificates are verified"
        : "connection.ssl is off (nothing to verify)",
    });
  }

  checks.push(auditPathCheck(config, projectDir));

  const limits = config.limits;
  const over: string[] = [];
  if (limits.max_rows > PRODUCTION_LIMIT_CEILINGS.max_rows) {
    over.push(`max_rows ${limits.max_rows} > ${PRODUCTION_LIMIT_CEILINGS.max_rows}`);
  }
  if (limits.default_rows > PRODUCTION_LIMIT_CEILINGS.default_rows) {
    over.push(`default_rows ${limits.default_rows} > ${PRODUCTION_LIMIT_CEILINGS.default_rows}`);
  }
  if (limits.timeout_ms > PRODUCTION_LIMIT_CEILINGS.timeout_ms) {
    over.push(`timeout_ms ${limits.timeout_ms} > ${PRODUCTION_LIMIT_CEILINGS.timeout_ms}`);
  }
  if (limits.max_concurrency != null && limits.max_concurrency > PRODUCTION_LIMIT_CEILINGS.max_concurrency) {
    over.push(`max_concurrency ${limits.max_concurrency} > ${PRODUCTION_LIMIT_CEILINGS.max_concurrency}`);
  }
  checks.push({
    name: "limits",
    ok: over.length === 0,
    detail: over.length === 0 ? "within production ceilings" : over.join("; "),
  });

  const experimental = Object.entries(config.metrics)
    .filter(([, metric]) => metric.status === "experimental")
    .map(([name]) => name)
    .sort();
  if (experimental.length > 0) {
    checks.push({
      name: "metrics",
      ok: false,
      detail: `experimental metric(s) present: ${experimental.join(", ")}`,
    });
  } else {
    checks.push({
      name: "metrics",
      ok: true,
      detail: "no status: experimental metrics",
    });
  }

  return { ok: checks.every((check) => check.ok), checks };
}

function auditPathCheck(config: GraneConfig, projectDir: string | undefined): ProductionCheck {
  if (!config.audit.enabled) {
    return { name: "audit.path", ok: false, detail: "audit.enabled is false; production HTTP has no audit trail" };
  }
  const path = resolveAuditPath(projectDir, config.audit.path);
  if (!path) {
    return {
      name: "audit.path",
      ok: false,
      detail: "audit.path is relative and cannot be resolved without a project directory",
    };
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a");
    closeSync(fd);
    return { name: "audit.path", ok: true, detail: `writable ${path}` };
  } catch (err) {
    return {
      name: "audit.path",
      ok: false,
      detail: `${path} is not writable (${(err as Error).message})`,
    };
  }
}

export function formatProductionLint(lint: ProductionLint): string {
  const lines = lint.checks.map((check) => {
    const tag = check.ok ? "OK  " : "FAIL";
    return `${tag}  ${check.name.padEnd(14)} ${check.detail}`;
  });
  lines.push("");
  lines.push(lint.ok ? "Production lint passed." : "Production lint failed.");
  return lines.join("\n");
}
