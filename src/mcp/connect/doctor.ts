import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../config/load.js";
import { GraneKernel, GRANE_VERSION } from "../../kernel.js";
import type { DoctorCheck, DoctorResult, ResolvedLaunch } from "./types.js";
import { childEnv, stdioArgs } from "./launch.js";

const EXPECTED_TOOLS = ["catalog", "explain", "query", "validate"];

export interface DoctorOptions {
  projectDir: string;
  offline?: boolean;
  skipMcp?: boolean;
  url?: string;
  launch: ResolvedLaunch;
  timeoutMs?: number;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const projectDir = resolve(opts.projectDir);
  let kernel: GraneKernel | undefined;

  try {
    const loaded = loadConfig(projectDir);
    kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });
    checks.push({
      name: "project",
      ok: true,
      level: "ok",
      detail: loaded.projectDir,
    });
    checks.push({
      name: "database",
      ok: true,
      level: "ok",
      detail: kernel.config.connection.type,
    });
  } catch (err) {
    checks.push({
      name: "project",
      ok: false,
      level: "error",
      detail: (err as Error).message,
    });
    return { ok: false, projectDir, checks };
  }

  const launchDetail =
    opts.launch.prefixArgs.length > 0
      ? `${opts.launch.command} ${opts.launch.prefixArgs.join(" ")}`
      : opts.launch.command;
  checks.push({
    name: "binary",
    ok: true,
    level: "ok",
    detail: `${launchDetail} (${opts.launch.source})`,
  });

  try {
    const report = kernel.validate();
    const valid = report.metrics.filter((m) => m.ok).length;
    const detail = `${valid}/${report.metrics.length} metrics, ${report.dimensionCount} dimensions, ${report.relationshipCount} relationships`;
    checks.push({
      name: "model",
      ok: report.ok,
      level: report.ok ? "ok" : "error",
      detail: report.ok ? detail : `${detail}; ${report.issues.length} issue(s)`,
    });
  } catch (err) {
    checks.push({
      name: "model",
      ok: false,
      level: "error",
      detail: (err as Error).message,
    });
  }

  if (opts.offline) {
    checks.push({
      name: "schema",
      ok: true,
      level: "ok",
      detail: "skipped (--offline)",
    });
  } else {
    try {
      const schema = await kernel.introspectSchema();
      const live = kernel.validate(schema);
      checks.push({
        name: "schema",
        ok: live.ok,
        level: live.ok ? "ok" : "error",
        detail: live.ok
          ? `live OK (${schema.tables.length} tables)`
          : `live schema issues (${live.issues.length})`,
      });
    } catch (err) {
      checks.push({
        name: "schema",
        ok: true,
        level: "warn",
        detail: `database unreachable: ${(err as Error).message}`,
      });
    }
  }

  if (opts.skipMcp) {
    checks.push({
      name: "mcp",
      ok: true,
      level: "ok",
      detail: "skipped (--skip-mcp)",
    });
  } else {
    try {
      const tools = await withTimeout(
        probeStdio(opts.launch, kernel.projectDir ?? projectDir),
        opts.timeoutMs ?? 12_000,
        "MCP stdio handshake timed out",
      );
      const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
      checks.push({
        name: "mcp",
        ok: missing.length === 0,
        level: missing.length === 0 ? "ok" : "error",
        detail:
          missing.length === 0
            ? `stdio tools: ${tools.join(", ")}`
            : `missing tools: ${missing.join(", ")} (got ${tools.join(", ") || "none"})`,
      });
    } catch (err) {
      checks.push({
        name: "mcp",
        ok: false,
        level: "error",
        detail: (err as Error).message,
      });
    }
  }

  if (opts.url) {
    try {
      const http = await withTimeout(
        probeHttp(opts.url),
        opts.timeoutMs ?? 12_000,
        "HTTP MCP probe timed out",
      );
      checks.push({
        name: "http",
        ok: http.ok,
        level: http.ok ? "ok" : "error",
        detail: http.detail,
      });
    } catch (err) {
      checks.push({
        name: "http",
        ok: false,
        level: "error",
        detail: (err as Error).message,
      });
    }
  }

  await kernel.close();
  const ok = checks.every((c) => c.ok);
  return { ok, projectDir: kernel.projectDir ?? projectDir, checks };
}

export async function probeStdio(launch: ResolvedLaunch, projectDir: string): Promise<string[]> {
  const args = stdioArgs(launch, projectDir);
  const transport = new StdioClientTransport({
    command: launch.command,
    args,
    env: childEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "grane-mcp-doctor", version: GRANE_VERSION });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    return listed.tools.map((t) => t.name).sort();
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function probeHttp(mcpUrl: string): Promise<{ ok: boolean; detail: string }> {
  const url = new URL(mcpUrl);
  const healthUrl = mcpUrl.replace(/\/mcp\/?$/, "/health");
  let healthNote = "";
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      healthNote = `health ${healthUrl} OK`;
    } else {
      healthNote = `health ${healthUrl} HTTP ${res.status}`;
    }
  } catch (err) {
    healthNote = `health unreachable (${(err as Error).message})`;
  }

  const client = new Client({ name: "grane-mcp-doctor", version: GRANE_VERSION });
  const transport = new StreamableHTTPClientTransport(url);
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tools = listed.tools.map((t) => t.name).sort();
    const missing = EXPECTED_TOOLS.filter((t) => !tools.includes(t));
    if (missing.length > 0) {
      return { ok: false, detail: `${healthNote}; missing tools: ${missing.join(", ")}` };
    }
    return { ok: true, detail: `${healthNote}; tools: ${tools.join(", ")}` };
  } catch (err) {
    return { ok: false, detail: `${healthNote}; MCP: ${(err as Error).message}` };
  } finally {
    await client.close().catch(() => undefined);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export { EXPECTED_TOOLS };
