import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../src/mcp/connect/jsonc.js";
import { resolveClient, claudeDesktopConfigPath, vscodeUserMcpPath, listClients } from "../../src/mcp/connect/clients.js";
import { buildServerEntry, resolveTransport, defaultHttpUrl } from "../../src/mcp/connect/entry.js";
import { resolveGraneLaunch, stdioArgs, connectionEnv, looksLikeSecret } from "../../src/mcp/connect/launch.js";
import { mergeServerEntry, removeServerEntry, readJsoncFile, writeJsonFile } from "../../src/mcp/connect/config-file.js";
import { findWorkspaceDir } from "../../src/mcp/connect/workspace.js";
import { connectMcp, printMcpConfig, listMcpRegistrations, removeMcpRegistration } from "../../src/mcp/connect/operations.js";
import { runDoctor } from "../../src/mcp/connect/doctor.js";
import type { ResolvedLaunch } from "../../src/mcp/connect/types.js";

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../demo/analytics");
const launch: ResolvedLaunch = { command: "grane", prefixArgs: [], source: "override" };

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "grane-mcp-"));
}

describe("resolveClient", () => {
  it("maps aliases to a canonical client", () => {
    expect(resolveClient("claude-desktop").id).toBe("claude");
    expect(resolveClient("Cursor").id).toBe("cursor");
    expect(resolveClient("gemini-cli").id).toBe("gemini");
    expect(resolveClient("vs-code").id).toBe("vscode");
    expect(resolveClient("gpt").id).toBe("chatgpt");
    expect(resolveClient("codeium").id).toBe("windsurf");
    expect(resolveClient("claude-cli").id).toBe("claude-code");
    expect(resolveClient("json").id).toBe("generic");
  });

  it("rejects unknown clients", () => {
    expect(() => resolveClient("slack")).toThrow(/Unknown MCP client/);
  });

  it("lists every supported client", () => {
    expect(listClients().map((c) => c.id)).toEqual([
      "claude",
      "cursor",
      "gemini",
      "vscode",
      "chatgpt",
      "windsurf",
      "claude-code",
      "generic",
    ]);
  });
});

describe("client config paths", () => {
  it("resolves Claude Desktop paths per OS", () => {
    expect(
      claudeDesktopConfigPath({ homeDir: "/Users/ada", platform: "darwin" }),
    ).toBe("/Users/ada/Library/Application Support/Claude/claude_desktop_config.json");
    expect(
      claudeDesktopConfigPath({ homeDir: "C:\\Users\\ada", platform: "win32", appData: "C:\\Users\\ada\\AppData\\Roaming" }),
    ).toBe(join("C:\\Users\\ada\\AppData\\Roaming", "Claude", "claude_desktop_config.json"));
    expect(
      claudeDesktopConfigPath({ homeDir: "/home/ada", platform: "linux" }),
    ).toBe("/home/ada/.config/Claude/claude_desktop_config.json");
  });

  it("resolves VS Code user mcp.json per OS", () => {
    expect(vscodeUserMcpPath({ homeDir: "/Users/ada", platform: "darwin" })).toBe(
      "/Users/ada/Library/Application Support/Code/User/mcp.json",
    );
    expect(vscodeUserMcpPath({ homeDir: "/home/ada", platform: "linux" })).toBe(
      "/home/ada/.config/Code/User/mcp.json",
    );
  });
});

describe("launch resolution", () => {
  it("prefers dist/cli when invoked from src/cli/index.ts", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "src", "cli"), { recursive: true });
    mkdirSync(join(dir, "dist", "cli"), { recursive: true });
    writeFileSync(join(dir, "src", "cli", "index.ts"), "");
    writeFileSync(join(dir, "dist", "cli", "index.js"), "");
    const resolved = resolveGraneLaunch({
      argv: ["node", join(dir, "src", "cli", "index.ts")],
      execPath: "/usr/bin/node",
    });
    expect(resolved.source).toBe("dist");
    expect(resolved.command).toBe("/usr/bin/node");
    expect(resolved.prefixArgs[0]).toBe(join(dir, "dist", "cli", "index.js"));
  });

  it("uses node + argv script for a built CLI", () => {
    const dir = tempDir();
    const script = join(dir, "dist", "cli", "index.js");
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, "");
    const resolved = resolveGraneLaunch({ argv: ["node", script], execPath: "/usr/bin/node" });
    expect(resolved.source).toBe("argv");
    expect(resolved.prefixArgs).toEqual([script]);
  });

  it("honors --command override", () => {
    expect(resolveGraneLaunch({ overrideCommand: "grane" })).toEqual({
      command: "grane",
      prefixArgs: [],
      source: "override",
    });
  });

  it("builds stdio args with an absolute project path", () => {
    const args = stdioArgs(launch, "/tmp/analytics");
    expect(args).toEqual(["-p", "/tmp/analytics", "serve", "--stdio"]);
  });

  it("copies connection env vars only", () => {
    expect(connectionEnv({ DATABASE_URL: "postgres://x", PATH: "/bin", HOME: "/home" })).toEqual({
      DATABASE_URL: "postgres://x",
    });
  });

  it("detects credentials in a URL", () => {
    expect(looksLikeSecret("postgres://readonly:secret@localhost/db")).toBe(true);
    expect(looksLikeSecret("postgres://localhost/db")).toBe(false);
  });
});

describe("jsonc", () => {
  it("strips comments and trailing commas", () => {
    const parsed = parseJsonc(`{
      // cursor-style comment
      "mcpServers": {
        "other": { "command": "echo" },
      },
    }`);
    expect(parsed).toEqual({ mcpServers: { other: { command: "echo" } } });
  });

  it("does not strip comment markers inside strings", () => {
    const parsed = parseJsonc(`{ "url": "http://example.com/path//mcp" }`);
    expect(parsed).toEqual({ url: "http://example.com/path//mcp" });
  });
});

describe("server entries", () => {
  it("builds stdio config for Cursor/Claude", () => {
    const { entry } = buildServerEntry({
      client: resolveClient("cursor"),
      transport: "stdio",
      projectDir: "/proj/analytics",
      launch,
      port: 8080,
      includeEnv: true,
      env: { DATABASE_URL: "postgres://readonly:pw@localhost/db" },
    });
    expect(entry).toEqual({
      command: "grane",
      args: ["-p", "/proj/analytics", "serve", "--stdio"],
      env: { DATABASE_URL: "postgres://readonly:pw@localhost/db" },
    });
  });

  it("uses httpUrl for Gemini HTTP", () => {
    const { entry } = buildServerEntry({
      client: resolveClient("gemini"),
      transport: "http",
      projectDir: "/proj",
      launch,
      url: "https://grane.example/mcp",
      port: 8080,
      includeEnv: false,
      env: {},
    });
    expect(entry).toEqual({ httpUrl: "https://grane.example/mcp" });
  });

  it("uses VS Code servers dialect with type", () => {
    const stdio = buildServerEntry({
      client: resolveClient("vscode"),
      transport: "stdio",
      projectDir: "/proj",
      launch,
      port: 8080,
      includeEnv: false,
      env: {},
    });
    expect(stdio.entry).toEqual({
      type: "stdio",
      command: "grane",
      args: ["-p", "/proj", "serve", "--stdio"],
    });
    const http = buildServerEntry({
      client: resolveClient("vscode"),
      transport: "http",
      projectDir: "/proj",
      launch,
      port: 9000,
      includeEnv: false,
      env: {},
    });
    expect(http.entry).toEqual({ type: "http", url: defaultHttpUrl(9000) });
  });

  it("rejects stdio for ChatGPT", () => {
    expect(() => resolveTransport(resolveClient("chatgpt"), "stdio")).toThrow(/does not support stdio/);
  });

  it("warns when ChatGPT is given a non-HTTPS URL", () => {
    const { warnings } = buildServerEntry({
      client: resolveClient("chatgpt"),
      transport: "http",
      projectDir: "/proj",
      launch,
      url: "http://localhost:8080/mcp",
      port: 8080,
      includeEnv: false,
      env: {},
    });
    expect(warnings.join(" ")).toMatch(/HTTPS/);
  });
});

describe("merge and remove", () => {
  it("merges without clobbering other servers", () => {
    const merged = mergeServerEntry(
      { mcpServers: { filesystem: { command: "npx" } }, extra: true },
      "mcpServers",
      "grane",
      { command: "grane", args: ["serve", "--stdio"] },
    );
    expect(merged["extra"]).toBe(true);
    expect(merged["mcpServers"]).toEqual({
      filesystem: { command: "npx" },
      grane: { command: "grane", args: ["serve", "--stdio"] },
    });
  });

  it("removes only the named server", () => {
    const { config, removed } = removeServerEntry(
      { mcpServers: { grane: { command: "grane" }, other: { command: "echo" } } },
      "mcpServers",
      "grane",
    );
    expect(removed).toBe(true);
    expect(config["mcpServers"]).toEqual({ other: { command: "echo" } });
  });
});

describe("connect / print / list / remove", () => {
  it("prints a generic snippet without writing", () => {
    const printed = printMcpConfig({
      client: "generic",
      transport: "stdio",
      projectDir: "/analytics",
      launch,
      port: 8080,
      includeEnv: false,
      env: {},
      serverName: "grane",
    });
    expect(printed.snippet).toContain('"mcpServers"');
    expect(printed.snippet).toContain("serve");
    expect(printed.snippet).toContain("--stdio");
  });

  it("writes project-local Cursor config and preserves siblings", () => {
    const workspace = tempDir();
    mkdirSync(join(workspace, ".cursor"), { recursive: true });
    writeFileSync(
      join(workspace, ".cursor", "mcp.json"),
      `{
        // existing
        "mcpServers": { "time": { "command": "python" } },
      }`,
    );
    const result = connectMcp({
      client: "cursor",
      transport: "stdio",
      projectDir: "/analytics",
      workspaceDir: workspace,
      homeDir: join(workspace, "home"),
      platform: "linux",
      env: { DATABASE_URL: "postgres://readonly:pw@localhost/db" },
      serverName: "grane",
      port: 8080,
      scope: "project",
      includeEnv: true,
      dryRun: false,
      launch,
    });
    expect(result.written).toBe(true);
    expect(result.path).toBe(join(workspace, ".cursor", "mcp.json"));
    const written = JSON.parse(readFileSync(result.path!, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(written.mcpServers["time"]?.command).toBe("python");
    expect(written.mcpServers["grane"]?.command).toBe("grane");
    expect(result.warnings.some((w) => w.includes("credentials"))).toBe(true);
  });

  it("replaces a leftover Cursor HTTP entry in the other config scope", () => {
    const workspace = tempDir();
    const home = tempDir();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { grane: { url: "http://localhost:8080/mcp" } },
      }),
    );
    const result = connectMcp({
      client: "cursor",
      transport: "stdio",
      projectDir: "/analytics",
      workspaceDir: workspace,
      homeDir: home,
      platform: "linux",
      env: {},
      serverName: "grane",
      port: 8080,
      scope: "project",
      includeEnv: false,
      dryRun: false,
      launch,
    });
    const globalPath = join(home, ".cursor", "mcp.json");
    const globalConfig = JSON.parse(readFileSync(globalPath, "utf8")) as {
      mcpServers: Record<string, { command?: string; url?: string; args?: string[] }>;
    };
    expect(globalConfig.mcpServers.grane?.url).toBeUndefined();
    expect(globalConfig.mcpServers.grane?.command).toBe("grane");
    expect(globalConfig.mcpServers.grane?.args).toContain("--stdio");
    expect(result.warnings.some((w) => w.includes(globalPath) && w.includes("8080"))).toBe(true);
  });

  it("does not write ChatGPT config; prints HTTPS instructions", () => {
    const result = connectMcp({
      client: "chatgpt",
      transport: "http",
      projectDir: "/analytics",
      workspaceDir: tempDir(),
      homeDir: tempDir(),
      platform: "linux",
      env: {},
      serverName: "grane",
      url: "https://grane.example/mcp",
      port: 8080,
      scope: "project",
      includeEnv: false,
      dryRun: false,
      launch,
    });
    expect(result.written).toBe(false);
    expect(result.path).toBeNull();
    expect(result.nextSteps.join("\n")).toMatch(/Developer Mode/);
    expect(result.nextSteps.join("\n")).toContain("https://grane.example/mcp");
  });

  it("writes Claude Desktop config even when --project is requested", () => {
    const home = tempDir();
    const result = connectMcp({
      client: "claude",
      transport: "stdio",
      projectDir: "/analytics",
      workspaceDir: tempDir(),
      homeDir: home,
      platform: "linux",
      env: {},
      serverName: "grane",
      port: 8080,
      scope: "project",
      includeEnv: false,
      dryRun: false,
      launch,
    });
    expect(result.path).toBe(join(home, ".config", "Claude", "claude_desktop_config.json"));
    expect(existsSync(result.path!)).toBe(true);
  });

  it("dry-run does not create a file", () => {
    const workspace = tempDir();
    const result = connectMcp({
      client: "cursor",
      transport: "stdio",
      projectDir: "/analytics",
      workspaceDir: workspace,
      homeDir: join(workspace, "home"),
      platform: "linux",
      env: {},
      serverName: "grane",
      port: 8080,
      scope: "project",
      includeEnv: false,
      dryRun: true,
      launch,
    });
    expect(result.written).toBe(false);
    expect(existsSync(join(workspace, ".cursor", "mcp.json"))).toBe(false);
  });

  it("lists configured vs missing clients", () => {
    const workspace = tempDir();
    const home = join(workspace, "home");
    mkdirSync(join(workspace, ".cursor"), { recursive: true });
    writeJsonFile(join(workspace, ".cursor", "mcp.json"), {
      mcpServers: { grane: { command: "grane" } },
    });
    const rows = listMcpRegistrations({
      workspaceDir: workspace,
      homeDir: home,
      platform: "linux",
      serverName: "grane",
    });
    const cursorProject = rows.find((r) => r.client === "cursor" && r.scope === "project");
    expect(cursorProject?.configured).toBe(true);
    const cursorGlobal = rows.find((r) => r.client === "cursor" && r.scope === "global");
    expect(cursorGlobal?.configured).toBe(false);
  });

  it("removes a Grane entry", () => {
    const workspace = tempDir();
    mkdirSync(join(workspace, ".cursor"), { recursive: true });
    writeJsonFile(join(workspace, ".cursor", "mcp.json"), {
      mcpServers: { grane: { command: "grane" }, other: { command: "echo" } },
    });
    const removed = removeMcpRegistration({
      client: "cursor",
      serverName: "grane",
      scope: "project",
      workspaceDir: workspace,
      homeDir: join(workspace, "home"),
      platform: "linux",
      dryRun: false,
    });
    expect(removed.removed).toBe(true);
    expect(readJsoncFile(removed.path)["mcpServers"]).toEqual({ other: { command: "echo" } });
  });
});

describe("workspace root", () => {
  it("walks up to the git directory", () => {
    const root = tempDir();
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "example", "analytics"), { recursive: true });
    expect(findWorkspaceDir(join(root, "example", "analytics"), join(root, "example", "analytics"))).toBe(root);
  });
});

describe("doctor", () => {
  it("validates the example project offline without an MCP handshake", async () => {
    const result = await runDoctor({
      projectDir: exampleDir,
      offline: true,
      skipMcp: true,
      launch,
    });
    expect(result.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "model")?.ok).toBe(true);
    expect(result.checks.find((c) => c.name === "mcp")?.detail).toMatch(/skipped/);
  });
});
