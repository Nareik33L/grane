import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseJsonc } from "./jsonc.js";
import type { HttpField, McpServerEntry, ServersKey } from "./types.js";

export function readJsoncFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  const parsed = parseJsonc(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

export function mergeServerEntry(
  existing: Record<string, unknown>,
  serversKey: ServersKey,
  name: string,
  entry: McpServerEntry,
): Record<string, unknown> {
  const next = { ...existing };
  const current = next[serversKey];
  const servers =
    current && typeof current === "object" && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  servers[name] = entry;
  next[serversKey] = servers;
  return next;
}

export function removeServerEntry(
  existing: Record<string, unknown>,
  serversKey: ServersKey,
  name: string,
): { config: Record<string, unknown>; removed: boolean } {
  const next = { ...existing };
  const current = next[serversKey];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return { config: next, removed: false };
  }
  const servers = { ...(current as Record<string, unknown>) };
  if (!(name in servers)) return { config: next, removed: false };
  delete servers[name];
  next[serversKey] = servers;
  return { config: next, removed: true };
}

/** URL if this MCP server entry is HTTP (Cursor/Claude `url`, Gemini `httpUrl`, VS Code `type: http`). */
export function serverEntryHttpUrl(entry: unknown, httpField: HttpField): string | undefined {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const rec = entry as Record<string, unknown>;
  if (rec.type === "http" && typeof rec.url === "string") return rec.url;
  const value = rec[httpField];
  return typeof value === "string" ? value : undefined;
}

export function getNamedServer(
  config: Record<string, unknown>,
  serversKey: ServersKey,
  name: string,
): unknown {
  const current = config[serversKey];
  if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
  return (current as Record<string, unknown>)[name];
}

export function listServerNames(config: Record<string, unknown>, serversKey: ServersKey): string[] {
  const current = config[serversKey];
  if (!current || typeof current !== "object" || Array.isArray(current)) return [];
  return Object.keys(current as Record<string, unknown>);
}

export function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const body = `${JSON.stringify(value, null, 2)}\n`;
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

export function formatSnippet(
  serversKey: ServersKey,
  name: string,
  entry: McpServerEntry,
): string {
  return JSON.stringify({ [serversKey]: { [name]: entry } }, null, 2);
}
