import { configError } from "../errors.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/**
 * Unauthenticated HTTP may only leave loopback with an explicit opt-in.
 * Authenticated servers may bind any host (still default loopback at the CLI).
 */
export function assertAnonymousHttpBind(input: {
  host: string;
  allowAnonymous: boolean;
  hasAgents: boolean;
}): void {
  if (input.hasAgents || isLoopbackHost(input.host)) return;
  if (input.allowAnonymous) return;
  throw configError(
    `Anonymous HTTP MCP cannot bind ${input.host}. Default is 127.0.0.1. ` +
      `Pass --allow-anonymous to expose an unauthenticated server on a non-loopback interface, ` +
      `or configure auth.agents and use --host ${input.host}.`,
  );
}

export function anonymousHttpWarning(host: string, port: number): string {
  const where = isLoopbackHost(host)
    ? `loopback ${host}:${port}`
    : `non-loopback ${host}:${port} (--allow-anonymous)`;
  return (
    `WARNING: No auth.agents configured. HTTP MCP is unauthenticated ` +
    `(full governed catalog for anyone who can reach the port). Bound to ${where}. ` +
    `Configure auth.agents for production HTTP.`
  );
}
