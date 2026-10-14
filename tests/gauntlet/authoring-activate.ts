/**
 * Gauntlet helper: a real MCP client with authoring enabled walks the
 * Set up Grane prompt through submit_proposal and must not pin.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AUTHORING_MCP_TOOLS,
  CORE_MCP_TOOLS,
  SETUP_GRANE_PROMPT_NAME,
  buildMcpServer,
} from "../../src/mcp/server.js";
import { SETUP_GRANE_SCRIPT } from "../../src/mcp/prompts/setup-grane.js";
import { GraneKernel } from "../../src/kernel.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { DatabaseSchema, ExecutedRows, WarehouseConnector } from "../../src/connectors/types.js";
import { ACTIVE_PIN_PATH, createProposal, readActivePin } from "../../src/authoring/git.js";
import { exampleConfig } from "../fixtures.js";
import type { Verdict } from "./types.js";

const SCHEMA: DatabaseSchema = {
  schemaName: "public",
  tables: [
    {
      schema: "public",
      name: "orders",
      primaryKey: "id",
      primaryKeyColumns: ["id"],
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "net_amount", dataType: "numeric", nullable: true },
        { name: "gross_amount", dataType: "numeric", nullable: true },
        { name: "completed_at", dataType: "timestamp", nullable: true },
      ],
    },
  ],
  foreignKeys: [],
};

function recordingConnector(): WarehouseConnector {
  return {
    type: "postgres",
    dialect: getDialect("postgres"),
    async query(): Promise<ExecutedRows> {
      return { columns: ["n"], rows: [{ n: 1 }] };
    },
    async introspect() {
      return SCHEMA;
    },
    async close() {},
  };
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function parseTool(result: { content: unknown; isError?: boolean }): Record<string, unknown> | unknown[] {
  const content = result.content as { type: string; text: string }[];
  const text = content[0]!.text;
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = 0;
  if (startArr >= 0 && (startObj < 0 || startArr < startObj)) start = startArr;
  else if (startObj >= 0) start = startObj;
  return JSON.parse(text.slice(start)) as Record<string, unknown> | unknown[];
}

export async function runAuthoringActivateGauntlet(options?: {
  /** Mutation hook: commit on `main` after submit and assert the gauntlet fails. */
  mutateMainCommit?: boolean;
}): Promise<Verdict> {
  const dir = mkdtempSync(join(tmpdir(), "grane-gauntlet-activate-"));
  try {
    mkdirSync(join(dir, ".grane"), { recursive: true });
    git(dir, ["init", "-b", "main"]);
    git(dir, ["config", "user.email", "gauntlet@grane.dev"]);
    git(dir, ["config", "user.name", "Grane Gauntlet"]);
    writeFileSync(join(dir, ".gitignore"), ".grane/\n");
    writeFileSync(
      join(dir, "grane.yml"),
      "project: { name: shop, timezone: UTC }\nconnection: { type: postgres, schema: public }\n",
    );
    writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-m", "initial"]);
    const mainShaBefore = git(dir, ["rev-parse", "main"]);

    const kernel = new GraneKernel(
      exampleConfig({
        audit: { enabled: true, path: ".grane/audit.jsonl", fail_closed: true },
        authoring: { enabled: true, mode: "local" },
      }),
      { projectDir: dir, connector: recordingConnector() },
    );
    const server = buildMcpServer(kernel, { authoring: true, transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "grane-gauntlet-activate", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      const names = listed.tools.map((tool) => tool.name).sort();
      expectTools(names);

      const prompt = await client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME });
      const text = prompt.messages[0] && "text" in prompt.messages[0].content ? prompt.messages[0].content.text : "";
      if (text !== SETUP_GRANE_SCRIPT) {
        return { code: "SECURITY CRITICAL", detail: "Set up Grane prompt did not match the golden script" };
      }
      if (!text.includes("Do not pin .grane/active.json")) {
        return { code: "SECURITY CRITICAL", detail: "Set up Grane prompt does not forbid pinning" };
      }

      for (const banned of ["activate", "approve", "pin", "merge", "write_active_pin", "rollback"]) {
        try {
          const result = await client.callTool({ name: banned, arguments: {} });
          if (!result.isError) {
            return { code: "SECURITY CRITICAL", detail: `MCP exposed ${banned}` };
          }
        } catch {
          // unknown tool — expected
        }
      }

      const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
        session: { id: string };
      };
      const sessionId = started.session.id;
      await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } });
      await client.callTool({
        name: "profile_column",
        arguments: { session_id: sessionId, table: "orders", column: "net_amount" },
      });
      await client.callTool({
        name: "record_term",
        arguments: { session_id: sessionId, term: "revenue", answer: "Completed order revenue." },
      });
      let open = parseTool(
        await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } }),
      ) as { id: string; kind: string; candidates: string[] }[];
      let guard = 0;
      while (open.length > 0) {
        if (guard++ > 20) return { code: "SECURITY CRITICAL", detail: "too many ambiguity rounds" };
        const item = open[0]!;
        const chosen = item.candidates.includes("orders.net_amount")
          ? "orders.net_amount"
          : (item.candidates.find((c) => c !== "skip") ?? item.candidates[0]!);
        const resolved = await client.callTool({
          name: "resolve_ambiguity",
          arguments: { session_id: sessionId, id: item.id, chosen },
        });
        if (resolved.isError) return { code: "SECURITY CRITICAL", detail: `resolve_ambiguity failed for ${item.id}` };
        open = parseTool(
          await client.callTool({ name: "list_ambiguities", arguments: { session_id: sessionId } }),
        ) as { id: string; kind: string; candidates: string[] }[];
      }
      const proposed = await client.callTool({
        name: "propose_definitions",
        arguments: { session_id: sessionId },
      });
      if (proposed.isError) return { code: "SECURITY CRITICAL", detail: "propose_definitions refused" };
      const preview = await client.callTool({ name: "preview_yaml", arguments: { session_id: sessionId } });
      if (preview.isError) return { code: "SECURITY CRITICAL", detail: "preview_yaml refused" };
      const submitted = await client.callTool({
        name: "submit_proposal",
        arguments: { session_id: sessionId, slug: "demo-activate" },
      });
      if (submitted.isError) {
        return { code: "SECURITY CRITICAL", detail: `submit_proposal refused: ${(submitted.content as { text: string }[])[0]?.text}` };
      }
      const submittedPayload = parseTool(submitted) as { proposal?: { branch?: string } };
      const proposalBranch = submittedPayload.proposal?.branch;
      if (!proposalBranch) {
        return { code: "SECURITY CRITICAL", detail: "submit_proposal did not return a proposal branch" };
      }

      if (options?.mutateMainCommit) {
        writeFileSync(join(dir, "agent-on-main.txt"), "agent wrote main\n");
        git(dir, ["add", "agent-on-main.txt"]);
        git(dir, ["commit", "-m", "agent mutated main"]);
      }

      try {
        createProposal(dir, {
          slug: "agent-pin",
          files: { ".grane/active.json": '{"ref":"main","commit":"deadbeef","approved_by":"agent","approved_at":"now"}' },
        });
        return { code: "SECURITY CRITICAL", detail: "createProposal accepted .grane/active.json" };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!/\.grane/.test(message) && !/Refusing/.test(message)) {
          return { code: "SECURITY CRITICAL", detail: `unexpected createProposal error: ${message}` };
        }
      }

      if (existsSync(join(dir, ACTIVE_PIN_PATH)) || readActivePin(dir)) {
        return { code: "SECURITY CRITICAL", detail: "pin/active.json was written" };
      }
      const head = git(dir, ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (head !== "main") {
        return { code: "SECURITY CRITICAL", detail: `HEAD moved to ${head}` };
      }
      const mainShaAfter = git(dir, ["rev-parse", "main"]);
      if (mainShaAfter !== mainShaBefore) {
        return {
          code: "SECURITY CRITICAL",
          detail: `main SHA moved from ${mainShaBefore} to ${mainShaAfter}`,
        };
      }
      const proposalParent = git(dir, ["rev-parse", `${proposalBranch}^`]);
      if (proposalParent !== mainShaBefore) {
        return {
          code: "SECURITY CRITICAL",
          detail: `proposal ${proposalBranch} parent ${proposalParent} is not original main ${mainShaBefore}`,
        };
      }
      return {
        code: "PASS — POLICY",
        detail: "MCP authoring walked Set up Grane through submit_proposal; .grane pin writes refused; no active.json",
      };
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
      await kernel.close().catch(() => undefined);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { code: "SECURITY CRITICAL", detail: `unexpected error in security scenario: ${message}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function expectTools(names: string[]): void {
  for (const tool of AUTHORING_MCP_TOOLS) {
    if (!names.includes(tool)) throw new Error(`missing authoring tool ${tool}`);
  }
  for (const tool of CORE_MCP_TOOLS) {
    if (!names.includes(tool)) throw new Error(`missing core tool ${tool}`);
  }
  const banned = names.filter((name) => /activate|approve|pin|merge|write_active|rollback/.test(name));
  if (banned.length > 0) throw new Error(`agent can activate via ${banned.join(", ")}`);
}
