import { homedir } from "node:os";
import type { Command } from "commander";
import {
  CLIENT_IDS,
  connectMcp,
  findWorkspaceDir,
  formatConnectOutput,
  listClients,
  listMcpRegistrations,
  printMcpConfig,
  removeMcpRegistration,
  resolveClient,
  resolveGraneLaunch,
  runDoctor,
  type ConfigScope,
  type Transport,
} from "../mcp/connect/index.js";

interface McpCliContext {
  projectDir: () => string;
  fail: (err: unknown) => never;
}

export function registerMcpCommands(program: Command, ctx: McpCliContext): void {
  const mcp = program
    .command("mcp")
    .description("Connect Grane to MCP-compatible agents (Claude, Cursor, Gemini, ChatGPT, VS Code, …)");

  mcp
    .command("clients")
    .description("List supported MCP clients")
    .option("--json", "print JSON")
    .action((options: { json?: boolean }) => {
      const rows = listClients().map((c) => ({
        id: c.id,
        label: c.label,
        aliases: c.aliases,
        defaultTransport: c.defaultTransport,
        stdio: c.supportsStdio,
        http: c.supportsHttp,
        writable: c.writable,
      }));
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      const idWidth = Math.max(...rows.map((r) => r.id.length), "id".length);
      const labelWidth = Math.max(...rows.map((r) => r.label.length), "label".length);
      const header = `${"id".padEnd(idWidth)}  ${"label".padEnd(labelWidth)}  stdio  http  write  default`;
      console.log(header);
      console.log(
        `${"-".repeat(idWidth)}  ${"-".repeat(labelWidth)}  -----  ----  -----  -------`,
      );
      for (const row of rows) {
        console.log(
          `${row.id.padEnd(idWidth)}  ${row.label.padEnd(labelWidth)}  ${yn(row.stdio).padEnd(5)}  ${yn(row.http).padEnd(4)}  ${yn(row.writable).padEnd(5)}  ${row.defaultTransport}`,
        );
      }
      console.log(`\nConnect: grane mcp connect <id>`);
    });

  mcp
    .command("print-config")
    .description("Print a ready-to-paste MCP config snippet for a client")
    .argument("[client]", "claude | cursor | gemini | vscode | chatgpt | windsurf | claude-code | generic", "generic")
    .option("--transport <mode>", "stdio | http")
    .option("--url <url>", "MCP HTTP URL (http transport)")
    .option("--port <port>", "localhost port when --url is omitted", "8080")
    .option("--name <name>", "server name in the client config", "grane")
    .option("--command <cmd>", "override the Grane executable (default: this CLI)")
    .option("--no-env", "do not copy DATABASE_URL into the config")
    .option("--json", "print JSON only")
    .action(
      (
        clientName: string,
        options: {
          transport?: string;
          url?: string;
          port: string;
          name: string;
          command?: string;
          env?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const printed = printMcpConfig({
            client: resolveClient(clientName).id,
            transport: parseTransport(options.transport),
            projectDir: ctx.projectDir(),
            launch: resolveGraneLaunch({ overrideCommand: options.command }),
            url: options.url,
            port: Number(options.port),
            includeEnv: options.env !== false,
            env: process.env,
            serverName: options.name,
          });
          if (options.json) {
            console.log(JSON.stringify({ client: printed.client.id, transport: printed.transport, entry: printed.entry }, null, 2));
            return;
          }
          console.log(printed.snippet);
          for (const warning of printed.warnings) console.error(`warning: ${warning}`);
        } catch (err) {
          ctx.fail(err);
        }
      },
    );

  mcp
    .command("connect")
    .description("Register Grane with an MCP client (writes/merges that client's config)")
    .argument("[client]", `one of: ${CLIENT_IDS.join(", ")}`)
    .option("--transport <mode>", "stdio | http")
    .option("--url <url>", "MCP HTTP URL (http transport)")
    .option("--port <port>", "localhost port when --url is omitted", "8080")
    .option("-g, --global", "write the user-level config instead of the project file")
    .option("--name <name>", "server name in the client config", "grane")
    .option("--command <cmd>", "override the Grane executable (default: this CLI)")
    .option("--dry-run", "print the merged config without writing")
    .option("--no-env", "do not copy DATABASE_URL into the config")
    .option("--json", "print JSON")
    .action(
      (
        clientName: string | undefined,
        options: {
          transport?: string;
          url?: string;
          port: string;
          global?: boolean;
          name: string;
          command?: string;
          dryRun?: boolean;
          env?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          if (!clientName) {
            console.error(`Specify a client: ${CLIENT_IDS.join(", ")}`);
            console.error('Run "grane mcp clients" for details.');
            process.exit(1);
          }
          const projectDir = ctx.projectDir();
          const result = connectMcp({
            client: resolveClient(clientName).id,
            transport: parseTransport(options.transport),
            projectDir,
            workspaceDir: findWorkspaceDir(process.cwd(), projectDir),
            homeDir: homedir(),
            platform: process.platform,
            appData: process.env.APPDATA,
            env: process.env,
            serverName: options.name,
            url: options.url,
            port: Number(options.port),
            scope: options.global ? "global" : "project",
            includeEnv: options.env !== false,
            dryRun: Boolean(options.dryRun),
            launch: resolveGraneLaunch({ overrideCommand: options.command }),
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            return;
          }
          console.log(formatConnectOutput(result));
        } catch (err) {
          ctx.fail(err);
        }
      },
    );

  mcp
    .command("list")
    .description("Show where Grane is registered across known MCP client configs")
    .option("--name <name>", "server name to look for", "grane")
    .option("--json", "print JSON")
    .action((options: { name: string; json?: boolean }) => {
      try {
        const rows = listMcpRegistrations({
          workspaceDir: findWorkspaceDir(process.cwd(), ctx.projectDir()),
          homeDir: homedir(),
          platform: process.platform,
          appData: process.env.APPDATA,
          serverName: options.name,
        });
        if (options.json) {
          console.log(JSON.stringify(rows, null, 2));
          return;
        }
        if (rows.length === 0) {
          console.log("No writable MCP client configs.");
          return;
        }
        const labelWidth = Math.max(...rows.map((r) => r.label.length), 16);
        for (const row of rows) {
          const status = !row.exists ? "missing" : row.configured ? "grane" : row.servers.length > 0 ? row.servers.join(", ") : "empty";
          console.log(`${row.label.padEnd(labelWidth)}  ${row.scope.padEnd(8)}  ${status.padEnd(12)}  ${row.path}`);
        }
      } catch (err) {
        ctx.fail(err);
      }
    });

  mcp
    .command("remove")
    .description("Remove the Grane server entry from a client's MCP config")
    .argument("<client>", `one of: ${CLIENT_IDS.join(", ")}`)
    .option("-g, --global", "edit the user-level config instead of the project file")
    .option("--name <name>", "server name to remove", "grane")
    .option("--dry-run", "show what would be removed without writing")
    .action(
      (
        clientName: string,
        options: { global?: boolean; name: string; dryRun?: boolean },
      ) => {
        try {
          const result = removeMcpRegistration({
            client: clientName,
            serverName: options.name,
            scope: (options.global ? "global" : "project") as ConfigScope,
            workspaceDir: findWorkspaceDir(process.cwd(), ctx.projectDir()),
            homeDir: homedir(),
            platform: process.platform,
            appData: process.env.APPDATA,
            dryRun: Boolean(options.dryRun),
          });
          console.log(
            result.removed
              ? `${options.dryRun ? "Would remove" : "Removed"} "${options.name}" from ${result.path}`
              : `Nothing to remove in ${result.path}`,
          );
        } catch (err) {
          ctx.fail(err);
        }
      },
    );

  mcp
    .command("doctor")
    .description("Check that this Grane project is ready for MCP agents")
    .option("--offline", "skip live database schema checks")
    .option("--skip-mcp", "skip the stdio MCP handshake")
    .option("--url <url>", "also probe a running HTTP MCP endpoint")
    .option("--command <cmd>", "override the Grane executable used for the handshake")
    .option("--json", "print JSON")
    .action(
      async (options: { offline?: boolean; skipMcp?: boolean; url?: string; command?: string; json?: boolean }) => {
        try {
          const result = await runDoctor({
            projectDir: ctx.projectDir(),
            offline: options.offline,
            skipMcp: options.skipMcp,
            url: options.url,
            launch: resolveGraneLaunch({ overrideCommand: options.command }),
          });
          if (options.json) {
            console.log(JSON.stringify(result, null, 2));
            if (!result.ok) process.exit(1);
            return;
          }
          console.log("Grane MCP doctor\n");
          for (const check of result.checks) {
            const tag = check.level === "ok" ? "OK   " : check.level === "warn" ? "WARN " : "ERROR";
            console.log(`${tag} ${check.name.padEnd(10)} ${check.detail}`);
          }
          console.log("");
          if (result.ok) {
            console.log('Status         ready — run: grane mcp connect <client>');
            console.log(`Clients        ${CLIENT_IDS.join(", ")}`);
          } else {
            console.log("Status         not ready");
            process.exit(1);
          }
        } catch (err) {
          ctx.fail(err);
        }
      },
    );
}

function yn(value: boolean): string {
  return value ? "yes" : "no";
}

function parseTransport(value: string | undefined): Transport | undefined {
  if (!value) return undefined;
  if (value === "stdio" || value === "http") return value;
  throw new Error(`Invalid --transport "${value}". Use stdio or http.`);
}
