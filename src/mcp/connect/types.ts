/** MCP clients Grane can register with. Same server, different last-mile config. */
export const CLIENT_IDS = [
  "claude",
  "cursor",
  "gemini",
  "vscode",
  "chatgpt",
  "windsurf",
  "claude-code",
  "generic",
] as const;

export type ClientId = (typeof CLIENT_IDS)[number];
export type Transport = "stdio" | "http";
export type ConfigScope = "project" | "global";
export type ServersKey = "mcpServers" | "servers";
export type HttpField = "url" | "httpUrl";

export interface StdioServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface HttpUrlEntry {
  url: string;
}

export interface HttpUrlGeminiEntry {
  httpUrl: string;
}

export interface VscodeStdioEntry {
  type: "stdio";
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface VscodeHttpEntry {
  type: "http";
  url: string;
}

export type McpServerEntry =
  | StdioServerEntry
  | HttpUrlEntry
  | HttpUrlGeminiEntry
  | VscodeStdioEntry
  | VscodeHttpEntry;

export interface ClientPaths {
  homeDir: string;
  workspaceDir: string;
  platform: NodeJS.Platform;
  appData?: string;
}

export interface ClientAdapter {
  id: ClientId;
  aliases: string[];
  label: string;
  /** Whether Grane can write a config file for this client. */
  writable: boolean;
  defaultTransport: Transport;
  supportsStdio: boolean;
  supportsHttp: boolean;
  /** Desktop apps that only have a user-level config ignore --global/--project. */
  scope: "project" | "global" | "both" | "none";
  httpField: HttpField;
  serversKey: ServersKey;
  vscodeStyle: boolean;
  configPath(paths: ClientPaths, scope: ConfigScope): string | null;
  nextSteps(input: {
    transport: Transport;
    url?: string;
    configPath: string | null;
    written: boolean;
  }): string[];
}

export interface ResolvedLaunch {
  command: string;
  prefixArgs: string[];
  source: "override" | "dist" | "argv" | "path";
}

export interface ConnectRequest {
  client: ClientId;
  transport?: Transport;
  projectDir: string;
  workspaceDir: string;
  homeDir: string;
  platform: NodeJS.Platform;
  appData?: string;
  env: NodeJS.ProcessEnv;
  serverName: string;
  url?: string;
  port: number;
  scope: ConfigScope;
  includeEnv: boolean;
  dryRun: boolean;
  launch: ResolvedLaunch;
}

export interface ConnectResult {
  client: ClientId;
  label: string;
  transport: Transport;
  serverName: string;
  written: boolean;
  created: boolean;
  path: string | null;
  entry: McpServerEntry;
  config: Record<string, unknown> | null;
  nextSteps: string[];
  warnings: string[];
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  level: "ok" | "warn" | "error";
}

export interface DoctorResult {
  ok: boolean;
  projectDir: string;
  checks: DoctorCheck[];
}
