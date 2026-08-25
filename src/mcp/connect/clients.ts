import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ClientAdapter,
  ClientId,
  ClientPaths,
  ConfigScope,
  Transport,
} from "./types.js";
import { CLIENT_IDS } from "./types.js";

function restartChat(app: string): string[] {
  return [
    `Fully restart ${app} so it reloads MCP config.`,
    "Start a new chat. Grane tools: catalog, query, validate, explain.",
  ];
}

function withConfig(lines: string[], configPath: string | null): string[] {
  return configPath ? [...lines, `Config: ${configPath}`] : lines;
}

export const CLIENTS: ClientAdapter[] = [
  {
    id: "claude",
    aliases: ["claude-desktop", "claude_desktop", "anthropic"],
    label: "Claude Desktop",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "global",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths) => claudeDesktopConfigPath(paths),
    nextSteps: ({ configPath, transport, url }) => {
      if (transport === "http") {
        return withConfig(
          [
            "In Claude Desktop: Settings → Connectors → Add custom connector.",
            `Enter the MCP URL: ${url ?? "https://your-host/mcp"}`,
            "Or add the HTTP entry below, then fully restart Claude Desktop.",
            "Start a new chat so Grane tools appear.",
          ],
          configPath,
        );
      }
      return withConfig(restartChat("Claude Desktop"), configPath);
    },
  },
  {
    id: "cursor",
    aliases: ["cursor-ide"],
    label: "Cursor",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths, scope) =>
      scope === "global"
        ? join(paths.homeDir, ".cursor", "mcp.json")
        : join(paths.workspaceDir, ".cursor", "mcp.json"),
    nextSteps: ({ configPath }) =>
      withConfig(
        [
          "Reload MCP in Cursor Settings → MCP, or run Developer: Reload Window.",
          "Start a new chat so the agent picks up Grane's tools.",
        ],
        configPath,
      ),
  },
  {
    id: "gemini",
    aliases: ["gemini-cli", "google", "google-gemini"],
    label: "Gemini CLI",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "httpUrl",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths, scope) =>
      scope === "global"
        ? join(paths.homeDir, ".gemini", "settings.json")
        : join(paths.workspaceDir, ".gemini", "settings.json"),
    nextSteps: ({ configPath }) =>
      withConfig(
        [
          "Restart Gemini CLI.",
          "Run /mcp list (or `gemini mcp list`) and confirm grane is connected.",
        ],
        configPath,
      ),
  },
  {
    id: "vscode",
    aliases: ["vs-code", "code", "visual-studio-code"],
    label: "VS Code",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "url",
    serversKey: "servers",
    vscodeStyle: true,
    configPath: (paths, scope) =>
      scope === "global" ? vscodeUserMcpPath(paths) : join(paths.workspaceDir, ".vscode", "mcp.json"),
    nextSteps: ({ configPath }) =>
      withConfig(
        ["Reload the VS Code window.", "Open the MCP view and confirm Grane is listed."],
        configPath,
      ),
  },
  {
    id: "chatgpt",
    aliases: ["gpt", "openai", "chat-gpt"],
    label: "ChatGPT",
    writable: false,
    defaultTransport: "http",
    supportsStdio: false,
    supportsHttp: true,
    scope: "none",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: () => null,
    nextSteps: ({ url }) => [
      "ChatGPT only accepts remote HTTPS MCP (not stdio, not localhost).",
      "1. Deploy Grane behind HTTPS. Endpoint: https://your-host/mcp",
      `2. Connector URL: ${url && url.startsWith("https://") ? url : "https://your-host/mcp"}`,
      "3. ChatGPT → Settings → Apps & Connectors → enable Developer Mode.",
      "4. Create a connector named Grane with that URL, then enable it in a new chat.",
    ],
  },
  {
    id: "windsurf",
    aliases: ["codeium"],
    label: "Windsurf",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths, scope) =>
      scope === "global"
        ? join(paths.homeDir, ".codeium", "windsurf", "mcp_config.json")
        : join(paths.workspaceDir, ".windsurf", "mcp.json"),
    nextSteps: ({ configPath }) => withConfig(restartChat("Windsurf"), configPath),
  },
  {
    id: "claude-code",
    aliases: ["claudecode", "claude-cli"],
    label: "Claude Code",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths, scope) =>
      scope === "global" ? join(paths.homeDir, ".claude.json") : join(paths.workspaceDir, ".mcp.json"),
    nextSteps: ({ configPath, transport, url }) =>
      withConfig(
        transport === "http"
          ? [
              "Restart Claude Code (or run `claude mcp list`).",
              `Remote MCP URL: ${url ?? "https://your-host/mcp"}`,
              "Start a new session so tools load.",
            ]
          : [
              "Restart Claude Code or run `claude mcp list`.",
              "Start a new session so Grane tools load.",
            ],
        configPath,
      ),
  },
  {
    id: "generic",
    aliases: ["json", "other", "any"],
    label: "Generic MCP client",
    writable: true,
    defaultTransport: "stdio",
    supportsStdio: true,
    supportsHttp: true,
    scope: "both",
    httpField: "url",
    serversKey: "mcpServers",
    vscodeStyle: false,
    configPath: (paths, scope) =>
      scope === "global" ? join(paths.homeDir, ".mcp.json") : join(paths.workspaceDir, ".mcp.json"),
    nextSteps: ({ configPath }) =>
      withConfig(
        [
          "Copy this JSON into your agent's MCP config if it uses a different file.",
          "Reload the agent and start a new chat.",
        ],
        configPath,
      ),
  },
];

const BY_NAME = new Map<string, ClientAdapter>();
for (const client of CLIENTS) {
  BY_NAME.set(client.id, client);
  for (const alias of client.aliases) BY_NAME.set(alias, client);
}

export function resolveClient(name: string): ClientAdapter {
  const client = BY_NAME.get(name.trim().toLowerCase());
  if (!client) {
    throw new Error(
      `Unknown MCP client "${name}". Supported: ${CLIENT_IDS.join(", ")}. Run "grane mcp clients".`,
    );
  }
  return client;
}

export function listClients(): ClientAdapter[] {
  return CLIENTS;
}

export function claudeDesktopConfigPath(paths: Pick<ClientPaths, "homeDir" | "platform" | "appData">): string {
  if (paths.platform === "darwin") {
    return join(paths.homeDir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (paths.platform === "win32") {
    const appData = paths.appData ?? join(paths.homeDir, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(paths.homeDir, ".config", "Claude", "claude_desktop_config.json");
}

export function vscodeUserMcpPath(paths: Pick<ClientPaths, "homeDir" | "platform" | "appData">): string {
  if (paths.platform === "darwin") {
    return join(paths.homeDir, "Library", "Application Support", "Code", "User", "mcp.json");
  }
  if (paths.platform === "win32") {
    const appData = paths.appData ?? join(paths.homeDir, "AppData", "Roaming");
    return join(appData, "Code", "User", "mcp.json");
  }
  return join(paths.homeDir, ".config", "Code", "User", "mcp.json");
}

export function defaultClientPaths(): ClientPaths {
  return {
    homeDir: homedir(),
    workspaceDir: process.cwd(),
    platform: process.platform,
    appData: process.env.APPDATA,
  };
}

export function effectiveScope(client: ClientAdapter, requested: ConfigScope): ConfigScope {
  if (client.scope === "global") return "global";
  if (client.scope === "none") return requested;
  if (client.scope === "project") return "project";
  return requested;
}
