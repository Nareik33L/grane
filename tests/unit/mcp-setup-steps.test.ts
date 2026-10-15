import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CORE_MCP_TOOLS } from "../../src/mcp/authoring.js";
import { SETUP_GRANE_PROMPT_TITLE } from "../../src/mcp/server.js";
import {
  claudeDesktopConfigPath,
  listClients,
  resolveClient,
  vscodeUserMcpPath,
} from "../../src/mcp/connect/clients.js";
import { defaultHttpUrl } from "../../src/mcp/connect/entry.js";
import { stdioArgs } from "../../src/mcp/connect/launch.js";
import type { ResolvedLaunch } from "../../src/mcp/connect/types.js";
import { EXPECTED_TOOLS } from "../../src/mcp/connect/doctor.js";
import {
  AUTHORING_CONNECT_STEPS,
  CORE_MCP_TOOLS_DISPLAY,
  coreToolsMatchServer,
  coreToolsPhrase,
} from "../../src/mcp/connect/next-steps.js";
import { connectMcp, formatConnectOutput } from "../../src/mcp/connect/operations.js";
import { skipConnectHint } from "../../src/setup/copy.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const launch: ResolvedLaunch = { command: "grane", prefixArgs: [], source: "override" };

function connectCursor(workspace: string, projectDir: string) {
  return connectMcp({
    client: "cursor",
    transport: "stdio",
    projectDir,
    workspaceDir: workspace,
    homeDir: join(workspace, "home"),
    platform: "linux",
    env: {},
    serverName: "grane",
    port: 8080,
    scope: "project",
    includeEnv: false,
    dryRun: false,
    launch,
  });
}

describe("MCP setup steps match server behaviour", () => {
  it("displayed core tools are exactly the tools the server registers", () => {
    expect(coreToolsMatchServer()).toBe(true);
    expect([...CORE_MCP_TOOLS_DISPLAY].sort()).toEqual([...CORE_MCP_TOOLS].sort());
    expect(EXPECTED_TOOLS).toEqual([...CORE_MCP_TOOLS]);
    expect(coreToolsPhrase()).toBe("catalog, query, validate, explain");
  });

  it("stdio args written to client config are -p <project> serve --stdio", () => {
    const args = stdioArgs(launch, "/analytics");
    expect(args).toEqual(["-p", "/analytics", "serve", "--stdio"]);
  });

  it("HTTP default URL is localhost:8080/mcp; serve binds 127.0.0.1", () => {
    expect(defaultHttpUrl(8080)).toBe("http://localhost:8080/mcp");
    const transportSrc = readFileSync(join(ROOT, "src/mcp/transport.ts"), "utf8");
    expect(transportSrc).toMatch(/options\.host \?\? "127.0.0.1"/);
    const cliSrc = readFileSync(join(ROOT, "src/cli/index.ts"), "utf8");
    expect(cliSrc).toMatch(/"--host <host>", "HTTP bind address", "127.0.0.1"/);
    expect(cliSrc).toMatch(/"--port <port>", "HTTP port", "8080"/);
  });

  it("connect cursor writes the project path the steps name, with real stdio args", () => {
    const workspace = mkdtempSync(join(tmpdir(), "grane-steps-"));
    mkdirSync(join(workspace, ".cursor"), { recursive: true });
    const projectDir = "/tmp/grane-analytics-project";
    const result = connectCursor(workspace, projectDir);
    const expectedPath = join(workspace, ".cursor", "mcp.json");
    expect(result.path).toBe(expectedPath);
    expect(result.written).toBe(true);
    const written = JSON.parse(readFileSync(expectedPath, "utf8")) as {
      mcpServers: { grane: { command: string; args: string[] } };
    };
    expect(written.mcpServers.grane.command).toBe("grane");
    expect(written.mcpServers.grane.args).toEqual(stdioArgs(launch, projectDir));
    expect(result.nextSteps.some((s) => s.includes(expectedPath))).toBe(true);
    const output = formatConnectOutput(result);
    expect(output).toMatch(/^\s*1\. /m);
    expect(output).toContain("Developer: Reload Window");
    expect(output).toContain(coreToolsPhrase());
  });

  it("every client's next steps are numbered and name the real config path", () => {
    const home = "/home/ada";
    const workspace = "/work";
    const paths = { homeDir: home, workspaceDir: workspace, platform: "linux" as const };
    for (const client of listClients()) {
      const configPath = client.configPath(paths, "project");
      const steps = client.nextSteps({
        transport: client.defaultTransport,
        url: "https://grane.example/mcp",
        configPath,
        written: true,
      });
      expect(steps.length, client.id).toBeGreaterThanOrEqual(2);
      for (const [i, step] of steps.entries()) {
        expect(step, `${client.id} step ${i}`).toMatch(new RegExp(`^${i + 1}\\. `));
      }
      expect(steps.join("\n"), client.id).toContain(coreToolsPhrase());
      if (configPath) {
        expect(steps.join("\n"), client.id).toContain(configPath);
      }
    }
    expect(resolveClient("cursor").configPath(paths, "project")).toBe(join(workspace, ".cursor", "mcp.json"));
    expect(resolveClient("cursor").configPath(paths, "global")).toBe(join(home, ".cursor", "mcp.json"));
    expect(resolveClient("gemini").configPath(paths, "global")).toBe(join(home, ".gemini", "settings.json"));
    expect(claudeDesktopConfigPath({ homeDir: "/Users/ada", platform: "darwin" })).toBe(
      "/Users/ada/Library/Application Support/Claude/claude_desktop_config.json",
    );
    expect(vscodeUserMcpPath({ homeDir: "/home/ada", platform: "linux" })).toBe(
      "/home/ada/.config/Code/User/mcp.json",
    );
  });

  it("authoring steps name both switches and do not treat them as substitutes", () => {
    const text = AUTHORING_CONNECT_STEPS.join("\n");
    expect(text).toContain("grane serve --stdio --authoring");
    expect(text).toContain("authoring.enabled");
    expect(text).toMatch(/this process/);
    expect(text).toMatch(/project/);
    expect(text).toMatch(/One does not set the other/);
    expect(text).toContain(SETUP_GRANE_PROMPT_TITLE);
    expect(text).toMatch(/only propose/);
    expect(text).toMatch(/merges and pins/);
    const cursor = resolveClient("cursor")
      .nextSteps({ transport: "stdio", configPath: "/tmp/mcp.json", written: true })
      .join("\n");
    expect(cursor).toContain(SETUP_GRANE_PROMPT_TITLE);
    expect(cursor).toContain("grane serve --stdio --authoring");
    expect(cursor).toContain("authoring.enabled");
  });

  it("skip-connect hint commands are the real CLI shape", () => {
    const dir = "/tmp/shop";
    const lines = skipConnectHint(dir);
    expect(lines.some((l) => l.includes(`grane -p ${dir} mcp connect cursor`))).toBe(true);
    expect(lines.some((l) => l.includes(`grane -p ${dir} mcp doctor`))).toBe(true);
    expect(lines.filter((l) => /^\d+\. /.test(l)).length).toBeGreaterThanOrEqual(2);
  });

  it("README and docs show the same paths, args, tools, and authoring honesty", () => {
    const docs = [
      "README.md",
      "docs/mcp-setup.md",
      "docs/connect-an-agent.md",
      "docs/first-week.md",
      "docs/v2-authoring.md",
    ].map((rel) => readFileSync(join(ROOT, rel), "utf8"));
    const blob = docs.join("\n");
    expect(blob).toContain("mcp connect cursor");
    expect(blob).toContain('"-p"');
    expect(blob).toContain('"serve"');
    expect(blob).toContain('"--stdio"');
    expect(blob).toContain(".cursor/mcp.json");
    expect(blob).toContain("http://127.0.0.1:8080/mcp");
    expect(blob).toContain(coreToolsPhrase());
    expect(blob).toContain("grane serve --stdio --authoring");
    expect(blob).toContain("authoring.enabled");
    expect(blob).toMatch(/not a substitute|One does not set the other|not the same as/);
    expect(blob).toMatch(/propose/);
    expect(blob).toMatch(/merge/);
    expect(blob).toMatch(/pin/);
    expect(blob).not.toMatch(/`--authoring` \(or `authoring\.enabled`/);
  });
});
