import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  AUTHORING_MCP_PROMPTS,
  AUTHORING_MCP_TOOLS,
  CORE_MCP_TOOLS,
  SETUP_GRANE_PROMPT_NAME,
  SETUP_GRANE_PROMPT_TITLE,
  buildMcpServer,
  type BuildMcpServerOptions,
} from "../../src/mcp/server.js";
import { SETUP_GRANE_SCRIPT } from "../../src/mcp/prompts/setup-grane.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";

const temps: string[] = [];
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/setup-grane.prompt.txt");

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-mcp-prompts-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

function kernelFor(dir: string, extra: Record<string, unknown> = {}) {
  return new GraneKernel(exampleConfig(extra), { projectDir: dir });
}

function authorGrant() {
  return {
    id: "author",
    metrics: null as string[] | null,
    dimensions: null as string[] | null,
    exploration: true,
    explorationExclude: [] as string[],
  };
}

async function connectClient(kernel: GraneKernel, options?: BuildMcpServerOptions) {
  const server = buildMcpServer(kernel, options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "grane-prompt-test", version: "0.0.1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

async function listPromptNames(kernel: GraneKernel, options?: BuildMcpServerOptions): Promise<string[]> {
  const { client, close } = await connectClient(kernel, options);
  try {
    try {
      const listed = await client.listPrompts();
      return listed.prompts.map((prompt) => prompt.name).sort();
    } catch {
      return [];
    }
  } finally {
    await close();
  }
}

describe("authoring MCP prompts gating", () => {
  it("without the authoring flag lists no setup prompt", async () => {
    const dir = tempDir();
    expect(await listPromptNames(kernelFor(dir), { transport: "stdio" })).toEqual([]);
    expect(await listPromptNames(kernelFor(dir), { transport: "http" })).toEqual([]);
  });

  it("authoring.enabled mode=local lists the prompt on stdio, not anonymous HTTP", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, { authoring: { enabled: true, mode: "local" } });
    expect(await listPromptNames(k, { transport: "stdio" })).toEqual([...AUTHORING_MCP_PROMPTS]);
    expect(await listPromptNames(k, { transport: "http" })).toEqual([]);
  });

  it("prompts/list is hidden from anonymous HTTP callers exactly like tools/list", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "http" });
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
      let prompts: string[] = [];
      try {
        prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort();
      } catch {
        prompts = [];
      }
      expect(tools).toEqual([...CORE_MCP_TOOLS].sort());
      for (const name of AUTHORING_MCP_TOOLS) {
        expect(tools).not.toContain(name);
      }
      expect(prompts).toEqual([]);
      for (const name of AUTHORING_MCP_PROMPTS) {
        expect(prompts).not.toContain(name);
      }
    } finally {
      await close();
    }
  });

  it("authenticated HTTP lists the prompt when authoring is on, matching tools/list", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir).bindAgent(authorGrant()), {
      authoring: true,
      transport: "http",
    });
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
      for (const name of AUTHORING_MCP_TOOLS) {
        expect(tools).toContain(name);
      }
      expect(prompts).toEqual([...AUTHORING_MCP_PROMPTS]);
    } finally {
      await close();
    }
  });

  it("--authoring lists Set up Grane on stdio", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "stdio" });
    try {
      const listed = await client.listPrompts();
      const prompt = listed.prompts.find((item) => item.name === SETUP_GRANE_PROMPT_NAME);
      expect(prompt?.name).toBe(SETUP_GRANE_PROMPT_NAME);
      expect(prompt?.title ?? prompt?.name).toBeTruthy();
      expect(String(prompt?.title ?? SETUP_GRANE_PROMPT_TITLE)).toMatch(/Set up Grane/);
      expect(prompt?.description).toMatch(/plain|pull request|production/i);
    } finally {
      await close();
    }
  });
});

describe("Set up Grane golden transcript", () => {
  const golden = readFileSync(GOLDEN, "utf8");

  it("source script matches the golden fixture", () => {
    expect(SETUP_GRANE_SCRIPT).toBe(golden);
  });

  it("prompts/get returns the golden user script", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "stdio" });
    try {
      const result = await client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME });
      expect(result.messages).toHaveLength(1);
      expect(result.messages[0]!.role).toBe("user");
      const content = result.messages[0]!.content;
      expect(content.type).toBe("text");
      expect("text" in content ? content.text : "").toBe(golden);
    } finally {
      await close();
    }
  });

  it("references only the nine authoring tools, never raw SQL or query", () => {
    const snake = [...new Set(golden.match(/\b[a-z]+_[a-z_]+\b/g) ?? [])].sort();
    expect(snake).toEqual([...AUTHORING_MCP_TOOLS].sort());
    for (const name of AUTHORING_MCP_TOOLS) {
      expect(golden).toContain(name);
    }
    expect(golden).not.toMatch(/\bquery\b/i);
    expect(golden).not.toMatch(/\bSQL\b/i);
    expect(golden).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/);
    expect(golden).not.toMatch(/\b(catalog|explain|validate)\s*\(/);
    expect(golden).not.toMatch(/query\s*\(/);
  });

  it("does not instruct echoing profile_column samples; summarise shape, types, and counts only", () => {
    expect(golden).toMatch(/profile_column/);
    expect(golden).toMatch(/shape/i);
    expect(golden).toMatch(/types/i);
    expect(golden).toMatch(/counts/i);
    expect(golden).toMatch(/Do not echo or repeat sample values to the user/);
    expect(golden).not.toMatch(/show them in this chat/i);
    expect(golden).not.toMatch(/peek at example values/i);
  });

  it("golden transcript contains no sample values, tokens, or credentials", () => {
    expect(golden).not.toMatch(/postgres:\/\//i);
    expect(golden).not.toMatch(/mysql:\/\//i);
    expect(golden).not.toMatch(/password|passwd|token_sha256|\bBearer\b|api[_-]?key|credential/i);
    expect(golden).not.toMatch(/SECRET[_-]/);
    expect(golden).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    expect(golden).not.toMatch(/sk-[A-Za-z0-9]+/);
    expect(JSON.stringify(golden)).not.toContain("SUPERSECRET");
  });

  it("never tells the AI to write production config or pins; PR path only", () => {
    expect(golden).toMatch(/experimental/);
    expect(golden).toMatch(/pull request/i);
    expect(golden).toMatch(/until (a pull request is )?merged/i);
    expect(golden).toMatch(/Do not write it to metrics\.yml/);
    expect(golden).toMatch(/Do not pin \.grane\/active\.json/);
    expect(golden).toMatch(/Do not change production config/);
    expect(golden).not.toMatch(/writeActivePin/);
    expect(golden).not.toMatch(/\bgit add\b/);
    expect(golden).not.toMatch(/\bgit commit\b/);
    expect(golden).not.toMatch(/edit metrics\.yml/);
    expect(golden).not.toMatch(/save (it |the draft )?to (production )?metrics\.yml/);
  });
});
