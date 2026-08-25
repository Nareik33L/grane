import { resolve } from "node:path";
import type { ClientAdapter, McpServerEntry, ResolvedLaunch, Transport } from "./types.js";
import { connectionEnv, looksLikeSecret, stdioArgs } from "./launch.js";

export function defaultHttpUrl(port: number): string {
  return `http://localhost:${port}/mcp`;
}

export function buildServerEntry(opts: {
  client: ClientAdapter;
  transport: Transport;
  projectDir: string;
  launch: ResolvedLaunch;
  url?: string;
  port: number;
  includeEnv: boolean;
  env: NodeJS.ProcessEnv;
}): { entry: McpServerEntry; warnings: string[] } {
  const warnings: string[] = [];
  if (opts.transport === "http") {
    const url = opts.url ?? defaultHttpUrl(opts.port);
    if (opts.client.id === "chatgpt" && !url.startsWith("https://")) {
      warnings.push(
        "ChatGPT requires a public HTTPS URL. localhost and plain HTTP will not work.",
      );
    }
    if (opts.client.vscodeStyle) {
      return { entry: { type: "http", url }, warnings };
    }
    if (opts.client.httpField === "httpUrl") {
      return { entry: { httpUrl: url }, warnings };
    }
    return { entry: { url }, warnings };
  }

  const extraEnv = opts.includeEnv ? connectionEnv(opts.env) : {};
  const envBlock = Object.keys(extraEnv).length > 0 ? extraEnv : undefined;
  if (envBlock) {
    for (const [key, value] of Object.entries(envBlock)) {
      if (looksLikeSecret(value)) {
        warnings.push(
          `${key} looks like a connection string with credentials. Avoid committing this MCP config.`,
        );
      }
    }
  }

  const command = opts.launch.command;
  const args = stdioArgs(opts.launch, resolve(opts.projectDir));
  if (opts.launch.source === "argv" && args[0]?.endsWith(".ts")) {
    warnings.push(
      'Launch path is TypeScript. Run "npm run build" so agents can start Grane without tsx.',
    );
  }

  if (opts.client.vscodeStyle) {
    return {
      entry: envBlock ? { type: "stdio", command, args, env: envBlock } : { type: "stdio", command, args },
      warnings,
    };
  }
  return {
    entry: envBlock ? { command, args, env: envBlock } : { command, args },
    warnings,
  };
}

export function resolveTransport(client: ClientAdapter, requested?: Transport): Transport {
  const transport = requested ?? client.defaultTransport;
  if (transport === "stdio" && !client.supportsStdio) {
    throw new Error(`${client.label} does not support stdio MCP. Use --transport http.`);
  }
  if (transport === "http" && !client.supportsHttp) {
    throw new Error(`${client.label} does not support HTTP MCP. Use --transport stdio.`);
  }
  return transport;
}
