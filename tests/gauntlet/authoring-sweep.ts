/**
 * MCP byte-identical sweep. Calls every tool `listTools` returns (fails if a
 * newly registered tool is missing from the sweep map), plus banned names.
 * Pin bytes, main SHA, and proposal refs must stay identical.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ACTIVE_PIN_PATH,
  createProposal,
  writeActivePin,
} from "../../src/authoring/git.js";
import { AUTHORING_MCP_TOOLS, CORE_MCP_TOOLS } from "../../src/mcp/server.js";
import {
  assertMainUnmoved,
  assertPinBytes,
  assertProposalParent,
  expectCoreAndAuthoring,
  git,
  initAuthoringRepo,
  parseTool,
  recordingConnector,
  SHOP_SCHEMA,
  tryBannedMcpTools,
  withAuthoringMcp,
} from "./authoring.js";
import type { Verdict } from "./types.js";

type SweepCtx = { sessionId: string; query: { metrics: string[] } };

/**
 * Explicit arguments for every registered MCP tool. Adding a tool to the
 * server without adding it here fails the sweep (new tool not included).
 */
export const MCP_SWEEP_TOOL_ARGS: Record<string, (ctx: SweepCtx) => Record<string, unknown>> = {
  catalog: () => ({}),
  validate: (ctx) => ({ query: ctx.query }),
  query: (ctx) => ({ query: ctx.query }),
  explain: (ctx) => ({ query: ctx.query }),
  authoring_start: () => ({}),
  discover_schema: (ctx) => ({ session_id: ctx.sessionId }),
  profile_column: (ctx) => ({ session_id: ctx.sessionId, table: "orders", column: "net_amount" }),
  record_term: (ctx) => ({ session_id: ctx.sessionId, term: "revenue", answer: "net_amount" }),
  list_ambiguities: (ctx) => ({ session_id: ctx.sessionId }),
  resolve_ambiguity: (ctx) => ({
    session_id: ctx.sessionId,
    id: "missing",
    chosen: "orders.net_amount",
  }),
  propose_definitions: (ctx) => ({ session_id: ctx.sessionId }),
  preview_yaml: (ctx) => ({ session_id: ctx.sessionId }),
  submit_proposal: (ctx) => ({ session_id: ctx.sessionId, slug: "sweep-must-not-write" }),
};

const EXPECTED_SWEEP_TOOLS = [...CORE_MCP_TOOLS, ...AUTHORING_MCP_TOOLS].sort();

export async function runAuthoringMcpSweep(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    writeActivePin(repo.dir, {
      ref: "main",
      commit: repo.mainSha,
      approved_by: "Reagent Smith",
      approved_at: "2026-10-14T12:00:00.000Z",
    });
    const open = createProposal(repo.dir, {
      slug: "open-draft",
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
    const mergedProposal = createProposal(repo.dir, {
      slug: "merged-revenue",
      at: new Date("2026-10-15T00:00:00.000Z"),
      files: {
        "metrics.yml": `metrics:
  extra_revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
    status: experimental
`,
      },
    });
    git(repo.dir, [
      "merge",
      "--no-ff",
      "-m",
      `Merge pull request #1 from ${mergedProposal.branch}\n\nGrane-Proposal: ${mergedProposal.id}`,
      mergedProposal.branch,
    ]);
    const mainAfterMerge = git(repo.dir, ["rev-parse", "main"]);
    const pinBytes = readFileSync(join(repo.dir, ACTIVE_PIN_PATH));
    const branchesBefore = git(repo.dir, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads/grane/proposal/",
    ]);

    const connector = recordingConnector(SHOP_SCHEMA);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const listed = (await client.listTools()).tools.map((tool) => tool.name).sort();
        const missingConst = expectCoreAndAuthoring(listed);
        if (missingConst) return missingConst;
        if (listed.join(",") !== EXPECTED_SWEEP_TOOLS.join(",")) {
          return {
            code: "SECURITY CRITICAL",
            detail: `registered MCP tools ${listed.join(",")} !== sweep map ${EXPECTED_SWEEP_TOOLS.join(",")}`,
          };
        }
        const unmapped = listed.filter((name) => !(name in MCP_SWEEP_TOOL_ARGS));
        if (unmapped.length > 0) {
          return {
            code: "SECURITY CRITICAL",
            detail: `sweep has no args for new MCP tool: ${unmapped.join(", ")}`,
          };
        }
        const stale = Object.keys(MCP_SWEEP_TOOL_ARGS).filter((name) => !listed.includes(name));
        if (stale.length > 0) {
          return { code: "FAIL", detail: `sweep args for unregistered tools: ${stale.join(", ")}` };
        }

        const start = await client.callTool({ name: "authoring_start", arguments: {} });
        const startPayload = parseTool(start) as { session: { id: string } };
        const ctx: SweepCtx = { sessionId: startPayload.session.id, query: { metrics: ["revenue"] } };
        for (const name of listed) {
          await client.callTool({ name, arguments: MCP_SWEEP_TOOL_ARGS[name]!(ctx) });
        }
        const banned = await tryBannedMcpTools(client);
        if (banned) return banned;

        const pinFail = assertPinBytes(repo.dir, pinBytes);
        if (pinFail) return pinFail;
        const mainFail = assertMainUnmoved(repo.dir, mainAfterMerge);
        if (mainFail) return mainFail;
        const branchesAfter = git(repo.dir, [
          "for-each-ref",
          "--format=%(refname)",
          "refs/heads/grane/proposal/",
        ]);
        if (branchesAfter !== branchesBefore) {
          return {
            code: "SECURITY CRITICAL",
            detail: `proposal branches moved: ${branchesBefore} -> ${branchesAfter}`,
          };
        }
        const openParent = assertProposalParent(repo.dir, open.branch, repo.mainSha);
        if (openParent) return openParent;
        const mergedParent = assertProposalParent(repo.dir, mergedProposal.branch, repo.mainSha);
        if (mergedParent) return mergedParent;
        if (git(repo.dir, ["rev-parse", `refs/heads/${open.branch}`]) !== open.commit) {
          return { code: "SECURITY CRITICAL", detail: "open proposal commit moved" };
        }
        if (git(repo.dir, ["rev-parse", `refs/heads/${mergedProposal.branch}`]) !== mergedProposal.commit) {
          return { code: "SECURITY CRITICAL", detail: "merged proposal commit moved" };
        }
        return {
          code: "PASS — POLICY",
          detail: "MCP sweep called every registered tool; pin bytes, main, and proposal refs unmoved",
        };
      },
    });
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}
