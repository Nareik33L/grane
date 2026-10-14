import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ACTIVE_PIN_PATH,
  approveProposal,
  createProposal,
  deleteProposalBranch,
  diffProposalAction,
  listProposals,
  listProposalsAction,
  readActivePin,
  rejectProposal,
  rollbackPin,
  writeActivePin,
} from "../../src/authoring/git.js";
import { GraneKernel } from "../../src/kernel.js";
import { buildMcpServer } from "../../src/mcp/server.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { WarehouseConnector } from "../../src/connectors/types.js";
import { exampleConfig } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import { submitProposal } from "../../src/authoring/tools.js";
import { createSession, updateSession } from "../../src/authoring/session.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-proposals-cli-"));
  temps.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

const INITIAL_YML = `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
`;

const DRAFT = `metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
`;

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  mkdirSync(join(dir, ".grane"), { recursive: true });
  writeFileSync(join(dir, "grane.yml"), INITIAL_YML);
  writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function readAudit(dir: string): Record<string, unknown>[] {
  const path = join(dir, ".grane", "audit.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function mergeProposal(dir: string, proposal: { id: string; branch: string }): string {
  git(dir, [
    "merge",
    "--no-ff",
    "-m",
    `Merge pull request #1 from ${proposal.branch}\n\nGrane-Proposal: ${proposal.id}`,
    proposal.branch,
  ]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function runCli(dir: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("npx", ["tsx", "src/cli/index.ts", "-p", dir, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 30_000,
    env: process.env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("grane proposals list|diff|approve|reject|rollback", () => {
  it("lists and diffs a proposal with one audit line each; CLI matches", () => {
    const dir = initRepo();
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    const listed = listProposalsAction(dir);
    expect(listed.map((item) => item.id)).toEqual([proposal.id]);
    const listLines = readAudit(dir).filter((event) => event.kind === "proposal" && event.operation === "list");
    expect(listLines).toHaveLength(1);

    const diff = diffProposalAction(dir, proposal.id);
    expect(diff.semantic?.metrics.added).toEqual(["revenue"]);
    const diffLines = readAudit(dir).filter((event) => event.kind === "proposal" && event.operation === "diff");
    expect(diffLines).toHaveLength(1);

    const cliList = runCli(dir, ["proposals", "list", "--json"]);
    expect(cliList.status).toBe(0);
    expect(cliList.stdout).toContain(proposal.id);
  });

  it("approve requires a TTY or a merged PR, pins the merge commit, and does not move main or the proposal parent", () => {
    const dir = initRepo();
    const mainBefore = git(dir, ["rev-parse", "main"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    expect(git(dir, ["rev-parse", `${proposal.branch}^`])).toBe(mainBefore);

    expect(() => approveProposal(dir, proposal.id, { tty: false })).toThrow(/human TTY or a merged GitHub PR/);
    expect(readActivePin(dir)).toBeNull();
    expect(git(dir, ["rev-parse", "main"])).toBe(mainBefore);

    expect(() => approveProposal(dir, proposal.id, { tty: true })).toThrow(/Merge the GitHub PR/);
    expect(readActivePin(dir)).toBeNull();

    const merged = mergeProposal(dir, proposal);
    const mainAfterMerge = git(dir, ["rev-parse", "main"]);
    expect(mainAfterMerge).toBe(merged);
    expect(git(dir, ["rev-parse", `${proposal.branch}^`])).toBe(mainBefore);

    const pin = approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(pin.commit).toBe(merged);
    expect(pin.ref).toBe("main");
    expect(FULL_SHA(pin.commit)).toBe(true);
    expect(git(dir, ["rev-parse", "main"])).toBe(mainAfterMerge);
    expect(git(dir, ["rev-parse", `${proposal.branch}^`])).toBe(mainBefore);

    const writes = readAudit(dir).filter((event) => event.kind === "pin" && event.operation === "write");
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ commit: merged, approved_by: "octocat" });
  });

  it("rollback re-pins the previous approved commit on the configured base without moving main", () => {
    const dir = initRepo();
    const first = git(dir, ["rev-parse", "main"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    const merged = mergeProposal(dir, proposal);
    writeActivePin(dir, {
      ref: "main",
      commit: first,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    approveProposal(dir, proposal.id, { tty: false, approved_by: "octocat" });
    expect(readActivePin(dir)?.commit).toBe(merged);

    const rolled = rollbackPin(dir, { approved_by: "octocat" });
    expect(rolled.commit).toBe(first);
    expect(rolled.previous_commit).toBe(merged);
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
    expect(git(dir, ["rev-parse", `${proposal.branch}^`])).toBe(first);
    expect(FULL_SHA(rolled.commit)).toBe(true);

    const other = createProposal(dir, {
      slug: "extra",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: {
        "metrics.yml": `metrics:
  extra:
    entity: order
    type: count
    sql: "\${orders.id}"
    status: experimental
`,
      },
    });
    expect(() => rollbackPin(dir, { to: other.commit, approved_by: "octocat" })).toThrow(
      /not reachable from "main"|not on "main"/,
    );
    expect(readActivePin(dir)?.commit).toBe(first);
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
  });

  it("reject deletes the proposal branch and leaves main and the pin untouched", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    writeActivePin(dir, {
      ref: "main",
      commit: main,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const pinBytes = readFileSync(join(dir, ACTIVE_PIN_PATH));
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    expect(() => rejectProposal(dir, proposal.id, { tty: false })).toThrow(/TTY or --yes/);
    const rejected = rejectProposal(dir, proposal.id, { yes: true });
    expect(rejected.branch).toBe(proposal.branch);
    expect(listProposals(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
    expect(readFileSync(join(dir, ACTIVE_PIN_PATH))).toEqual(pinBytes);
    const rejects = readAudit(dir).filter(
      (event) => event.kind === "proposal" && event.operation === "reject" && event.branch,
    );
    expect(rejects).toHaveLength(1);
  });

  it("CLI approve after merge and rollback keep main SHA and write the pin atomically", () => {
    const dir = initRepo();
    const first = git(dir, ["rev-parse", "main"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    const merged = mergeProposal(dir, proposal);
    writeActivePin(dir, {
      ref: "main",
      commit: first,
      approved_by: "octocat",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const approved = runCli(dir, ["proposals", "approve", proposal.id, "--json", "--approved-by", "octocat"]);
    expect(approved.status).toBe(0);
    const pin = JSON.parse(approved.stdout) as { commit: string; ref: string };
    expect(pin.commit).toBe(merged);
    expect(pin.ref).toBe("main");
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);

    const rolled = runCli(dir, ["proposals", "rollback", "--json", "--approved-by", "octocat"]);
    expect(rolled.status).toBe(0);
    expect(JSON.parse(rolled.stdout).commit).toBe(first);
    expect(git(dir, ["rev-parse", "main"])).toBe(merged);
    expect(git(dir, ["rev-parse", `${proposal.branch}^`])).toBe(first);
  });
});

describe("authoring fail-closed preflight", () => {
  it("createProposal does not create a branch when fail_closed audit cannot write", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    writeFileSync(join(dir, "blocked"), "not a directory");
    writeFileSync(
      join(dir, "grane.yml"),
      `${INITIAL_YML}audit: { enabled: true, fail_closed: true, path: blocked/audit.jsonl }\n`,
    );
    git(dir, ["add", "grane.yml"]);
    git(dir, ["commit", "-m", "fail-closed audit"]);
    const afterCommit = git(dir, ["rev-parse", "main"]);
    expect(() =>
      createProposal(dir, {
        slug: "revenue",
        at: new Date("2026-10-14T00:00:00.000Z"),
        files: { "metrics.yml": DRAFT },
      }),
    ).toThrow(/fail_closed/);
    expect(listProposals(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(afterCommit);
    expect(afterCommit).not.toBe(main);
    expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
  });

  it("MCP submit_proposal under fail_closed does not leave a proposal branch", async () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    writeFileSync(join(dir, "blocked"), "not a directory");
    const kernel = new GraneKernel(
      exampleConfig({
        audit: { enabled: true, path: "blocked/audit.jsonl", fail_closed: true },
        authoring: { enabled: true, mode: "local" },
      }),
      {
        projectDir: dir,
        connector: {
          type: "postgres",
          dialect: getDialect("postgres"),
          async query() {
            return { columns: ["n"], rows: [{ n: 1 }] };
          },
          async introspect() {
            return { schemaName: "public", tables: [], foreignKeys: [] };
          },
          async close() {},
        } satisfies WarehouseConnector,
      },
    );
    const server = buildMcpServer(kernel, { authoring: true, transport: "stdio" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "grane-fail-closed", version: "0.0.1" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "submit_proposal", arguments: { session_id: "nope" } });
      expect(result.isError).toBe(true);
      expect((result.content as { text: string }[])[0]!.text).toMatch(/fail_closed/);
    } finally {
      await client.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
    expect(listProposals(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
    expect(readActivePin(dir)).toBeNull();
  });

  it("submitProposal library path rolls back if a branch existed only after a failed audit preflight", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "demo" },
    });
    updateSession(dir, session.id, {
      draft_yaml: { "metrics.yml": DRAFT },
      open_ambiguities: [],
    });
    writeFileSync(join(dir, "blocked"), "not a directory");
    writeFileSync(
      join(dir, "grane.yml"),
      `${INITIAL_YML}audit: { enabled: true, fail_closed: true, path: blocked/audit.jsonl }\n`,
    );
    const kernel = new GraneKernel(exampleConfig({ audit: { enabled: true, fail_closed: true, path: "blocked/audit.jsonl" } }), {
      projectDir: dir,
    });
    expect(() => submitProposal(kernel, session.id, "nope")).toThrow(/fail_closed|validate|Draft/);
    expect(listProposals(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
  });
});

describe("deleteProposalBranch", () => {
  it("only deletes a proposal ref", () => {
    const dir = initRepo();
    const main = git(dir, ["rev-parse", "main"]);
    const proposal = createProposal(dir, {
      slug: "revenue",
      at: new Date("2026-10-14T00:00:00.000Z"),
      files: { "metrics.yml": DRAFT },
    });
    expect(deleteProposalBranch(dir, proposal.id)).toBe(proposal.branch);
    expect(listProposals(dir)).toEqual([]);
    expect(git(dir, ["rev-parse", "main"])).toBe(main);
    expect(() => deleteProposalBranch(dir, "main")).toThrow(/proposal/);
  });
});

function FULL_SHA(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}
