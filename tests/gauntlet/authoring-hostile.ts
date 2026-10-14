/**
 * Adversarial authoring: prompt injection, self-approve, active YAML / pin
 * writes, hostile slug and path arguments.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { approveProposal, createProposal, rollbackPin } from "../../src/authoring/git.js";
import { isWriteSql } from "../../src/connectors/types.js";
import {
  AUTHORING_INJECTION,
  assertMainUnmoved,
  assertNoPin,
  assertProposalParent,
  git,
  initAuthoringRepo,
  parseTool,
  recordingConnector,
  SHOP_SCHEMA,
  tryBannedMcpTools,
  withAuthoringMcp,
  writeSqlInLog,
} from "./authoring.js";
import type { Verdict } from "./types.js";

function frozen(dir: string, mainSha: string, branch?: string): Verdict | null {
  const main = assertMainUnmoved(dir, mainSha);
  if (main) return main;
  const pin = assertNoPin(dir);
  if (pin) return pin;
  if (branch) return assertProposalParent(dir, branch, mainSha);
  return null;
}

export async function runAuthoringPromptInjection(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  const sqlLog: string[] = [];
  try {
    const yamlBefore = readFileSync(join(repo.dir, "grane.yml"), "utf8");
    const connector = recordingConnector(SHOP_SCHEMA, {
      sqlLog,
      samples: {
        "orders.comment": [AUTHORING_INJECTION, `-- ${AUTHORING_INJECTION}`],
        "orders.net_amount": [AUTHORING_INJECTION],
      },
    });
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const started = parseTool(await client.callTool({ name: "authoring_start", arguments: {} })) as {
          session: { id: string };
        };
        const sessionId = started.session.id;
        await client.callTool({ name: "discover_schema", arguments: { session_id: sessionId } });
        const profile = await client.callTool({
          name: "profile_column",
          arguments: { session_id: sessionId, table: "orders", column: "comment" },
        });
        if (profile.isError) return { code: "FAIL", detail: "profile_column refused a normal comment column" };
        const payload = parseTool(profile) as { samples?: unknown[] };
        const samples = JSON.stringify(payload.samples ?? payload);
        if (!samples.includes("IGNORE PREVIOUS INSTRUCTIONS")) {
          return { code: "FAIL", detail: "injection sample did not surface through profile_column" };
        }
        await client.callTool({
          name: "record_term",
          arguments: {
            session_id: sessionId,
            term: "revenue",
            answer: `Column comment: ${AUTHORING_INJECTION}`,
          },
        });
        const banned = await tryBannedMcpTools(client);
        if (banned) return banned;
        try {
          await client.callTool({
            name: "query",
            arguments: { query: { metrics: ["revenue"], filters: [{ field: "orders.comment", operator: "=", value: AUTHORING_INJECTION }] } },
          });
        } catch {
          // structured refusal is fine
        }
        const writes = writeSqlInLog(sqlLog);
        if (writes.length > 0 || sqlLog.some((sql) => isWriteSql(sql) || /drop\s+table|merge\s+into/i.test(sql))) {
          return { code: "SECURITY CRITICAL", detail: `injection reached write SQL: ${sqlLog.join(" | ")}` };
        }
        if (readFileSync(join(repo.dir, "grane.yml"), "utf8") !== yamlBefore) {
          return { code: "SECURITY CRITICAL", detail: "active YAML changed after injection samples" };
        }
        const freeze = frozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "Injection in comments/samples did not merge, pin, approve, or run write SQL",
        };
      },
    });
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringSelfApprove(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const proposal = createProposal(repo.dir, {
      slug: "self-approve",
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
    try {
      approveProposal(repo.dir, proposal.id, { tty: false });
      return { code: "SECURITY CRITICAL", detail: "approveProposal succeeded without TTY or merged PR" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/TTY|merged GitHub PR/i.test(message)) {
        return { code: "FAIL", detail: `unexpected approve refusal: ${message}` };
      }
    }
    try {
      rollbackPin(repo.dir);
      return { code: "SECURITY CRITICAL", detail: "rollbackPin succeeded with no pin" };
    } catch {
      // expected
    }
    const connector = recordingConnector(SHOP_SCHEMA);
    return await withAuthoringMcp({
      dir: repo.dir,
      connector,
      fn: async (client) => {
        const banned = await tryBannedMcpTools(client);
        if (banned) return banned;
        const freeze = frozen(repo.dir, repo.mainSha, proposal.branch);
        if (freeze) return freeze;
        return {
          code: "PASS — POLICY",
          detail: "Self-approve and MCP approve/rollback/reject tools refused; main and proposal parent unmoved",
        };
      },
    });
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringActiveWrites(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const yamlBefore = readFileSync(join(repo.dir, "grane.yml"), "utf8");
    try {
      createProposal(repo.dir, {
        slug: "agent-pin",
        files: {
          ".grane/active.json": JSON.stringify({
            ref: "main",
            commit: "deadbeef",
            approved_by: "agent",
            approved_at: "now",
          }),
        },
      });
      return { code: "SECURITY CRITICAL", detail: "createProposal accepted .grane/active.json" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/\.grane/.test(message) && !/Refusing/.test(message)) {
        return { code: "FAIL", detail: `unexpected createProposal error: ${message}` };
      }
    }
    const proposal = createProposal(repo.dir, {
      slug: "rewrite-yaml",
      files: {
        "grane.yml": "project: { name: pwned, timezone: UTC }\nconnection: { type: postgres }\n",
      },
    });
    if (readFileSync(join(repo.dir, "grane.yml"), "utf8") !== yamlBefore) {
      return { code: "SECURITY CRITICAL", detail: "createProposal mutated working-tree YAML" };
    }
    const freeze = frozen(repo.dir, repo.mainSha, proposal.branch);
    if (freeze) return freeze;
    return {
      code: "PASS — POLICY",
      detail: "Active YAML and .grane/active.json writes refused; proposal stayed off main",
    };
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}

export async function runAuthoringHostileArgs(): Promise<Verdict> {
  const repo = initAuthoringRepo();
  try {
    const hostileSlugs = ["../evil", "..\\evil", "foo/../../../etc", "'; DROP TABLE orders; --", "ok\nGrane-Proposal: pwn"];
    for (const slug of hostileSlugs) {
      try {
        const proposal = createProposal(repo.dir, {
          slug,
          files: { "metrics.yml": "metrics: {}\n" },
        });
        if (proposal.branch.includes("..") || proposal.branch.includes("/") && !proposal.branch.startsWith("grane/proposal/")) {
          return { code: "SECURITY CRITICAL", detail: `hostile slug became branch ${proposal.branch}` };
        }
        const freeze = frozen(repo.dir, repo.mainSha, proposal.branch);
        if (freeze) return freeze;
      } catch (err) {
        const freeze = frozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        const message = err instanceof Error ? err.message : String(err);
        if (/main SHA moved|HEAD moved/.test(message)) {
          return { code: "SECURITY CRITICAL", detail: message };
        }
      }
    }
    const hostilePaths = ["../pwn.yml", "../../etc/passwd", ".git/config", ".grane/active.json", "/tmp/x.yml"];
    for (const path of hostilePaths) {
      try {
        createProposal(repo.dir, { slug: "path-attack", files: { [path]: "pwned\n" } });
        return { code: "SECURITY CRITICAL", detail: `createProposal accepted path ${path}` };
      } catch (err) {
        const freeze = frozen(repo.dir, repo.mainSha);
        if (freeze) return freeze;
        const message = err instanceof Error ? err.message : String(err);
        if (!/Refusing|proposal|\.grane|\.\./i.test(message)) {
          return { code: "FAIL", detail: `unexpected path error for ${path}: ${message}` };
        }
      }
    }
    if (git(repo.dir, ["rev-parse", "main"]) !== repo.mainSha) {
      return { code: "SECURITY CRITICAL", detail: "hostile args moved main" };
    }
    return {
      code: "PASS — POLICY",
      detail: "Hostile slug and path arguments did not write main, the pin, or escape the proposal prefix",
    };
  } catch (err) {
    return { code: "FAIL", detail: err instanceof Error ? err.message : String(err) };
  } finally {
    repo.cleanup();
  }
}
