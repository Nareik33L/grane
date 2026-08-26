import { existsSync } from "node:fs";
import { effectiveScope, listClients, resolveClient } from "./clients.js";
import {
  formatSnippet,
  getNamedServer,
  listServerNames,
  mergeServerEntry,
  readJsoncFile,
  removeServerEntry,
  serverEntryHttpUrl,
  writeJsonFile,
} from "./config-file.js";
import { buildServerEntry, resolveTransport } from "./entry.js";
import type {
  ClientAdapter,
  ClientId,
  ClientPaths,
  ConfigScope,
  ConnectRequest,
  ConnectResult,
  Transport,
} from "./types.js";

export function connectMcp(req: ConnectRequest): ConnectResult {
  const client = resolveClient(req.client);
  const transport = resolveTransport(client, req.transport);
  const scope = effectiveScope(client, req.scope);
  const paths: ClientPaths = {
    homeDir: req.homeDir,
    workspaceDir: req.workspaceDir,
    platform: req.platform,
    appData: req.appData,
  };
  const { entry, warnings } = buildServerEntry({
    client,
    transport,
    projectDir: req.projectDir,
    launch: req.launch,
    url: req.url,
    port: req.port,
    includeEnv: req.includeEnv,
    env: req.env,
  });

  const path = client.configPath(paths, scope);
  if (!client.writable || path === null) {
    return {
      client: client.id,
      label: client.label,
      transport,
      serverName: req.serverName,
      written: false,
      created: false,
      path: null,
      entry,
      config: null,
      warnings,
      nextSteps: client.nextSteps({
        transport,
        url: req.url,
        configPath: null,
        written: false,
      }),
    };
  }

  const created = !existsSync(path);
  const existing = readJsoncFile(path);
  const config = mergeServerEntry(existing, client.serversKey, req.serverName, entry);
  if (!req.dryRun) writeJsonFile(path, config);

  if (transport === "stdio" && client.scope === "both") {
    const otherScope = scope === "project" ? "global" : "project";
    const otherPath = client.configPath(paths, otherScope);
    if (otherPath && otherPath !== path && existsSync(otherPath)) {
      const otherExisting = readJsoncFile(otherPath);
      const leftoverUrl = serverEntryHttpUrl(
        getNamedServer(otherExisting, client.serversKey, req.serverName),
        client.httpField,
      );
      if (leftoverUrl) {
        const replaced = mergeServerEntry(otherExisting, client.serversKey, req.serverName, entry);
        if (!req.dryRun) writeJsonFile(otherPath, replaced);
        warnings.push(
          `Replaced HTTP entry (${leftoverUrl}) in ${otherPath} with stdio. Cursor was connecting to that URL instead of launching Grane.`,
        );
      }
    }
  }

  return {
    client: client.id,
    label: client.label,
    transport,
    serverName: req.serverName,
    written: !req.dryRun,
    created,
    path,
    entry,
    config,
    warnings,
    nextSteps: client.nextSteps({
      transport,
      url: req.url,
      configPath: path,
      written: !req.dryRun,
    }),
  };
}

export function printMcpConfig(req: Pick<
  ConnectRequest,
  "client" | "transport" | "projectDir" | "launch" | "url" | "port" | "includeEnv" | "env" | "serverName"
>): {
  client: ClientAdapter;
  transport: Transport;
  entry: ReturnType<typeof buildServerEntry>["entry"];
  snippet: string;
  warnings: string[];
} {
  const client = resolveClient(req.client);
  const transport = resolveTransport(client, req.transport);
  const { entry, warnings } = buildServerEntry({
    client,
    transport,
    projectDir: req.projectDir,
    launch: req.launch,
    url: req.url,
    port: req.port,
    includeEnv: req.includeEnv,
    env: req.env,
  });
  return {
    client,
    transport,
    entry,
    warnings,
    snippet: formatSnippet(client.serversKey, req.serverName, entry),
  };
}

export function listMcpRegistrations(opts: {
  workspaceDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  appData?: string;
  serverName?: string;
}): {
  client: ClientId;
  label: string;
  scope: ConfigScope;
  path: string;
  exists: boolean;
  servers: string[];
  configured: boolean;
}[] {
  const results: {
    client: ClientId;
    label: string;
    scope: ConfigScope;
    path: string;
    exists: boolean;
    servers: string[];
    configured: boolean;
  }[] = [];
  const paths: ClientPaths = {
    homeDir: opts.homeDir,
    workspaceDir: opts.workspaceDir,
    platform: opts.platform,
    appData: opts.appData,
  };
  const name = opts.serverName ?? "grane";

  for (const client of listClients()) {
    if (!client.writable) continue;
    const scopes: ConfigScope[] =
      client.scope === "global" ? ["global"] : client.scope === "project" ? ["project"] : ["project", "global"];
    const seen = new Set<string>();
    for (const scope of scopes) {
      const path = client.configPath(paths, scope);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      const exists = existsSync(path);
      let servers: string[] = [];
      if (exists) {
        try {
          servers = listServerNames(readJsoncFile(path), client.serversKey);
        } catch {
          servers = [];
        }
      }
      results.push({
        client: client.id,
        label: client.label,
        scope,
        path,
        exists,
        servers,
        configured: servers.includes(name),
      });
    }
  }
  return results;
}

export function removeMcpRegistration(opts: {
  client: string;
  serverName: string;
  scope: ConfigScope;
  workspaceDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  appData?: string;
  dryRun: boolean;
}): { path: string; removed: boolean; servers: string[] } {
  const client = resolveClient(opts.client);
  if (!client.writable) {
    throw new Error(`${client.label} has no config file to edit.`);
  }
  const scope = effectiveScope(client, opts.scope);
  const path = client.configPath(
    {
      homeDir: opts.homeDir,
      workspaceDir: opts.workspaceDir,
      platform: opts.platform,
      appData: opts.appData,
    },
    scope,
  );
  if (!path) {
    throw new Error(`${client.label} has no config file to edit.`);
  }
  if (!existsSync(path)) {
    throw new Error(`No config file at ${path}.`);
  }
  const existing = readJsoncFile(path);
  const { config, removed } = removeServerEntry(existing, client.serversKey, opts.serverName);
  if (!removed) {
    throw new Error(`No server named "${opts.serverName}" in ${path}.`);
  }
  if (!opts.dryRun) writeJsonFile(path, config);
  return {
    path,
    removed: true,
    servers: listServerNames(config, client.serversKey),
  };
}

export function formatConnectOutput(result: ConnectResult): string {
  const lines: string[] = [];
  lines.push(`${result.label} (${result.transport})`);
  if (result.path) {
    lines.push(result.written ? `Wrote ${result.path}` : `Would write ${result.path}`);
    if (result.created && result.written) lines.push("(created new file)");
  } else {
    lines.push("No config file for this client — follow the steps below.");
  }
  lines.push("");
  lines.push(formatSnippetForResult(result));
  if (result.warnings.length > 0) {
    lines.push("");
    for (const warning of result.warnings) lines.push(`warning: ${warning}`);
  }
  lines.push("");
  lines.push("Next:");
  for (const step of result.nextSteps) lines.push(`  ${step}`);
  return lines.join("\n");
}

function formatSnippetForResult(result: ConnectResult): string {
  const client = resolveClient(result.client);
  return formatSnippet(client.serversKey, result.serverName, result.entry);
}
