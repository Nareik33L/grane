import { homedir } from "node:os";
import { join } from "node:path";
import {
  authoringConnectSteps,
  coreToolsPhrase,
  numbered,
  reloadAndChatSteps,
  withConfigStep,
} from "./next-steps.js";
import type { ClientAdapter, ClientPaths, ConfigScope } from "./types.js";
import { CLIENT_IDS } from "./types.js";

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
        return withConfigStep(
          [
            "Settings → Connectors → Add custom connector (or fully restart Claude Desktop).",
            `MCP URL: ${url ?? "https://your-host/mcp"}`,
            "Start a new chat.",
            `Use ${coreToolsPhrase()}.`,
            ...authoringConnectSteps("http"),
          ],
          configPath,
        );
      }
      return withConfigStep(
        [
          "Fully restart Claude Desktop.",
          "Start a new chat.",
          `Use ${coreToolsPhrase()}.`,
          ...authoringConnectSteps("stdio"),
        ],
        configPath,
      );
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
    nextSteps: ({ configPath, transport }) =>
      withConfigStep(
        [
          "Reload Cursor: Settings → MCP, or Developer: Reload Window.",
          "Start a new chat.",
          `Use ${coreToolsPhrase()}.`,
          ...authoringConnectSteps(transport),
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
      withConfigStep(
        [
          "Restart Gemini CLI.",
          "Run /mcp list (or `gemini mcp list`) and confirm grane is connected.",
          `Use ${coreToolsPhrase()}.`,
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
      withConfigStep(
        ["Reload the VS Code window.", "Open the MCP view and confirm Grane is listed.", `Use ${coreToolsPhrase()}.`],
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
    nextSteps: ({ url }) =>
      numbered([
        "ChatGPT needs public HTTPS MCP (not stdio, not localhost).",
        `Deploy Grane. Endpoint: /mcp. Connector URL: ${url && url.startsWith("https://") ? url : "https://your-host/mcp"}`,
        "Settings → Apps & Connectors → enable Developer Mode.",
        "Create a connector named Grane with that URL, then enable it in a new chat.",
        `Use ${coreToolsPhrase()}.`,
      ]),
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
    nextSteps: ({ configPath }) => withConfigStep(reloadAndChatSteps("Windsurf"), configPath),
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
      withConfigStep(
        transport === "http"
          ? [
              "Restart Claude Code (or run `claude mcp list`).",
              `Remote MCP URL: ${url ?? "https://your-host/mcp"}`,
              "Start a new session.",
              `Use ${coreToolsPhrase()}.`,
            ]
          : [
              "Restart Claude Code or run `claude mcp list`.",
              "Start a new session.",
              `Use ${coreToolsPhrase()}.`,
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
      withConfigStep(
        [
          "Copy this JSON into your agent's MCP config if it uses a different file.",
          "Reload the agent and start a new chat.",
          `Use ${coreToolsPhrase()}.`,
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
