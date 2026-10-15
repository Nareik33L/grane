import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
import {
  DEFAULT_SETUP_TONE,
  SETUP_GRANE_SCRIPT,
  setupGranePromptResult,
  setupGraneScript,
} from "../../src/mcp/prompts/setup-grane.js";
import { localGraneConfigPath, writeSetupTone } from "../../src/setup/local-config.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";

const temps: string[] = [];
const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/setup-grane.prompt.txt");
const GOLDEN_PLAIN = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/setup-grane.prompt.plain.txt");

function assertAuthoringScriptConstraints(script: string): void {
  const snake = [...new Set(script.match(/\b[a-z]+_[a-z_]+\b/g) ?? [])].sort();
  expect(snake).toEqual([...AUTHORING_MCP_TOOLS].sort());
  for (const name of AUTHORING_MCP_TOOLS) {
    expect(script).toContain(name);
  }
  expect(script).not.toMatch(/\bquery\b/i);
  expect(script).not.toMatch(/\bSQL\b/i);
  expect(script).not.toMatch(/\b(SELECT|INSERT|UPDATE|DELETE|WITH)\b/);
  expect(script).not.toMatch(/\b(catalog|explain|validate)\s*\(/);
  expect(script).not.toMatch(/query\s*\(/);
  expect(script).toMatch(/What metrics are important to you\?/);
  expect(script).toMatch(/unconfirmed until/);
  expect(script).toMatch(/Never settle an ambiguity silently/);
  expect(script).toMatch(/play-back must match the proposal|Play-back must match the proposal/i);
  expect(script).toMatch(/Do not echo or repeat sample values to the user/);
  expect(script).toMatch(/Do not write it to metrics\.yml/);
  expect(script).toMatch(/Do not pin \.grane\/active\.json/);
  expect(script).toMatch(/skip review/);
  expect(script).toMatch(/Never say (the metrics are live|they are live)/);
  expect(script).toMatch(/If they ask you to approve, pin, skip review/);
  expect(script).not.toMatch(/writeActivePin/);
}

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
  const server = buildMcpServer(kernel, {
    ...options,
    homeDir: options?.homeDir ?? kernel.projectDir,
  });
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

  it("anonymous HTTP caller is refused prompts/get for the setup prompt", async () => {
    const dir = tempDir();
    const { client, close } = await connectClient(kernelFor(dir), { authoring: true, transport: "http" });
    try {
      let listed: string[] = [];
      try {
        listed = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
      } catch {
        listed = [];
      }
      expect(listed).not.toContain(SETUP_GRANE_PROMPT_NAME);

      await expect(client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME })).rejects.toThrow(
        /prompt|not found|unknown|invalid|Method not found/i,
      );
    } finally {
      await close();
    }
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
  const goldenPlain = readFileSync(GOLDEN_PLAIN, "utf8");

  it("source scripts match the golden fixtures", () => {
    expect(SETUP_GRANE_SCRIPT).toBe(golden);
    expect(setupGraneScript(DEFAULT_SETUP_TONE)).toBe(golden);
    expect(setupGraneScript("plain")).toBe(goldenPlain);
    expect(setupGraneScript("technical")).not.toBe(setupGraneScript("plain"));
  });

  it("prompts/get returns the golden user script (default technical)", async () => {
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

  it("plain and technical scripts only name the nine authoring tools", () => {
    assertAuthoringScriptConstraints(golden);
    assertAuthoringScriptConstraints(goldenPlain);
  });

  it("does not instruct echoing profile_column samples; summarise shape, types, and counts only", () => {
    for (const script of [golden, goldenPlain]) {
      expect(script).toMatch(/profile_column/);
      expect(script).toMatch(/shape/i);
      expect(script).toMatch(/types/i);
      expect(script).toMatch(/counts/i);
      expect(script).toMatch(/Do not echo or repeat sample values to the user/);
      expect(script).not.toMatch(/show them in this chat/i);
      expect(script).not.toMatch(/peek at example values/i);
    }
  });

  it("golden transcript contains no sample values, tokens, or credentials", () => {
    for (const script of [golden, goldenPlain]) {
      expect(script).not.toMatch(/postgres:\/\//i);
      expect(script).not.toMatch(/mysql:\/\//i);
      expect(script).not.toMatch(/password|passwd|token_sha256|\bBearer\b|api[_-]?key|credential/i);
      expect(script).not.toMatch(/SECRET[_-]/);
      expect(script).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      expect(script).not.toMatch(/sk-[A-Za-z0-9]+/);
      expect(JSON.stringify(script)).not.toContain("SUPERSECRET");
    }
  });

  it("never tells the AI to write production config or pins; PR path only", () => {
    for (const script of [golden, goldenPlain]) {
      expect(script).toMatch(/experimental/);
      expect(script).toMatch(/pull request/i);
      expect(script).toMatch(/until (a pull request is )?merged/i);
      expect(script).toMatch(/Do not write it to metrics\.yml/);
      expect(script).toMatch(/Do not pin \.grane\/active\.json/);
      expect(script).toMatch(/Do not change production config/);
      expect(script).not.toMatch(/writeActivePin/);
      expect(script).not.toMatch(/\bgit add\b/);
      expect(script).not.toMatch(/\bgit commit\b/);
      expect(script).not.toMatch(/edit metrics\.yml/);
      expect(script).not.toMatch(/save (it |the draft )?to (production )?metrics\.yml/);
    }
  });
});

describe("MCP reads setup_tone only", () => {
  it("does not import or call writeSetupTone", () => {
    const mcpRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src/mcp");
    const files = [
      join(mcpRoot, "prompts/setup-grane.ts"),
      join(mcpRoot, "authoring.ts"),
      join(mcpRoot, "server.ts"),
    ];
    for (const file of files) {
      expect(readFileSync(file, "utf8")).not.toMatch(/writeSetupTone/);
    }
  });

  it("getPrompt reads saved tone and does not write the user-local config", async () => {
    const dir = tempDir();
    const home = tempDir();
    writeSetupTone(home, "plain");
    const before = readFileSync(localGraneConfigPath(home), "utf8");
    const { client, close } = await connectClient(kernelFor(dir), {
      authoring: true,
      transport: "stdio",
      homeDir: home,
    });
    try {
      const result = await client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME });
      const text = "text" in result.messages[0]!.content ? result.messages[0]!.content.text : "";
      expect(text).toBe(setupGraneScript("plain"));
      expect(text).not.toBe(SETUP_GRANE_SCRIPT);
    } finally {
      await close();
    }
    expect(readFileSync(localGraneConfigPath(home), "utf8")).toBe(before);
  });

  it("missing config defaults to technical and still does not write", async () => {
    const dir = tempDir();
    const home = tempDir();
    expect(existsSync(localGraneConfigPath(home))).toBe(false);
    const { client, close } = await connectClient(kernelFor(dir), {
      authoring: true,
      transport: "stdio",
      homeDir: home,
    });
    try {
      const result = await client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME });
      const text = "text" in result.messages[0]!.content ? result.messages[0]!.content.text : "";
      expect(text).toBe(SETUP_GRANE_SCRIPT);
    } finally {
      await close();
    }
    expect(existsSync(localGraneConfigPath(home))).toBe(false);
  });

  it("getPrompt refuses a symlink with the same error as the writer", async () => {
    const dir = tempDir();
    const home = tempDir();
    const outside = join(tempDir(), "target.json");
    writeFileSync(outside, '{"setup_tone":"plain"}\n');
    symlinkSync(outside, localGraneConfigPath(home));
    expect(() => setupGranePromptResult(home)).toThrow(/symlink|regular file/);
    const { client, close } = await connectClient(kernelFor(dir), {
      authoring: true,
      transport: "stdio",
      homeDir: home,
    });
    try {
      await expect(client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME })).rejects.toThrow();
    } finally {
      await close();
    }
    expect(readFileSync(outside, "utf8")).toBe('{"setup_tone":"plain"}\n');
  });

  it("getPrompt refuses invalid JSON with the same error as the writer", async () => {
    const dir = tempDir();
    const home = tempDir();
    writeFileSync(localGraneConfigPath(home), "{nope");
    expect(() => setupGranePromptResult(home)).toThrow(/not valid JSON/);
    const { client, close } = await connectClient(kernelFor(dir), {
      authoring: true,
      transport: "stdio",
      homeDir: home,
    });
    try {
      await expect(client.getPrompt({ name: SETUP_GRANE_PROMPT_NAME })).rejects.toThrow();
    } finally {
      await close();
    }
    expect(readFileSync(localGraneConfigPath(home), "utf8")).toBe("{nope");
  });
});
