import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  authoringStart,
  discoverSchema,
  listAmbiguities,
  previewYaml,
  proposeDefinitions,
  recordTerm,
  resolveAmbiguity,
  submitProposal,
} from "../../src/authoring/tools.js";
import { formatProposalPlayback, proposalPlaybackMetrics } from "../../src/authoring/playback.js";
import { loadSession } from "../../src/authoring/session.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { DatabaseSchema, ExecutedRows, WarehouseConnector } from "../../src/connectors/types.js";
import { GraneKernel } from "../../src/kernel.js";
import { GraneError } from "../../src/errors.js";
import { exampleConfig } from "../fixtures.js";
import { setupGranePromptResult, setupGraneScript } from "../../src/mcp/prompts/setup-grane.js";
import { writeSetupTone } from "../../src/setup/local-config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TRANSCRIPT = join(ROOT, "tests/fixtures/setup-grane.transcript.md");
const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-guided-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

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
        { name: "created_at", dataType: "timestamp", nullable: true },
        { name: "completed_at", dataType: "timestamp", nullable: true },
      ],
    },
    {
      schema: "public",
      name: "invoices",
      primaryKey: "id",
      primaryKeyColumns: ["id"],
      columns: [
        { name: "id", dataType: "integer", nullable: false },
        { name: "gross_amount", dataType: "numeric", nullable: true },
        { name: "completed_at", dataType: "timestamp", nullable: true },
      ],
    },
  ],
  foreignKeys: [],
};

function stubConnector(): WarehouseConnector {
  return {
    type: "postgres",
    dialect: getDialect("postgres"),
    async query(): Promise<ExecutedRows> {
      return { columns: ["n"], rows: [{ n: 2 }] };
    },
    async introspect() {
      return SCHEMA;
    },
    async close() {},
  };
}

function kernelFor(dir: string): GraneKernel {
  return new GraneKernel(
    exampleConfig({
      connection: { type: "postgres", schema: "public" },
      audit: { enabled: false },
      authoring: { enabled: true, mode: "local" },
    }),
    { projectDir: dir, connector: stubConnector() },
  );
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if ((result.status ?? 1) !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return (result.stdout ?? "").trim();
}

function initRepo(): string {
  const dir = tempDir();
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@grane.dev"]);
  git(dir, ["config", "user.name", "Grane Test"]);
  writeFileSync(join(dir, ".gitignore"), ".grane/\n");
  writeFileSync(
    join(dir, "grane.yml"),
    "project: { name: shop, timezone: UTC }\nconnection: { type: postgres, schema: public }\n",
  );
  writeFileSync(join(dir, "metrics.yml"), "metrics: {}\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-m", "initial"]);
  return dir;
}

function pickResolvedCandidate(item: { kind: string; candidates: string[] }): string {
  if (item.candidates.includes("orders.net_amount")) return "orders.net_amount";
  if (item.kind === "non_additive_measure" && item.candidates.includes("unsupported")) return "unsupported";
  if (item.candidates.includes("do_not_join")) return "do_not_join";
  const first = item.candidates.find((candidate) => candidate !== "skip") ?? item.candidates[0];
  if (!first) throw new Error(`ambiguity ${item.kind} has no candidates`);
  return first;
}

async function resolveAll(k: GraneKernel, sessionId: string): Promise<void> {
  let listed = listAmbiguities(k, sessionId);
  let guard = 0;
  while (listed.length > 0) {
    if (guard++ > 20) throw new Error("too many ambiguity rounds");
    const item = listed[0]!;
    resolveAmbiguity(k, sessionId, item.id, pickResolvedCandidate(item));
    listed = listAmbiguities(k, sessionId);
  }
}

describe("suggested meanings stay unconfirmed until the user picks", () => {
  it("does not settle an ambiguity silently; submit_proposal refuses; playback matches the proposal", async () => {
    const dir = initRepo();
    const k = kernelFor(dir);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    recordTerm(k, sessionId, "revenue", "Completed order revenue.");

    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns");
    expect(revenue).toBeTruthy();
    expect(revenue!.candidates).toEqual(
      expect.arrayContaining(["orders.net_amount", "invoices.gross_amount"]),
    );
    expect(revenue!.candidates.length).toBeGreaterThanOrEqual(2);

    const before = loadSession(dir, sessionId);
    expect(before.resolved_ambiguities.filter((item) => item.kind === "revenue_like_columns")).toEqual([]);

    try {
      await proposeDefinitions(k, sessionId);
      expect.unreachable("propose_definitions must not invent a revenue column");
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/Nothing to propose|Unresolved|ambiguity/i);
    }

    const stillOpen = loadSession(dir, sessionId);
    expect(stillOpen.resolved_ambiguities.filter((item) => item.kind === "revenue_like_columns")).toEqual([]);
    expect(stillOpen.draft_yaml["metrics.yml"] ?? "").not.toMatch(/net_amount|gross_amount/);

    try {
      submitProposal(k, sessionId);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/No draft YAML|Unresolved ambiguities/);
    }

    await resolveAll(k, sessionId);
    expect(listAmbiguities(k, sessionId)).toEqual([]);
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.unresolved).toBe(false);
    const draft = proposed.draft_yaml;
    expect(draft["metrics.yml"]).toMatch(/net_amount/);
    expect(draft["metrics.yml"]).not.toMatch(/gross_amount/);
    expect(proposed.playback).toBe(formatProposalPlayback(draft));
    const rows = proposalPlaybackMetrics(draft);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(proposed.playback).toContain(row.name);
      expect(proposed.playback).toContain(row.sql);
      expect(draft["metrics.yml"]).toContain(row.name);
      expect(draft["metrics.yml"]).toContain(row.sql);
      expect(proposed.playback).toContain(`calculation ${row.calculation}`);
      expect(proposed.playback).toContain(`filters ${row.filters}`);
      expect(proposed.playback).toContain(`grain ${row.grain}`);
      expect(proposed.playback).toContain(`description ${row.description}`);
    }
    expect(proposed.playback).toContain("description Completed order revenue.");
    const preview = previewYaml(k, sessionId);
    expect(formatProposalPlayback(preview.files)).toBe(proposed.playback);
  });
});

describe("stale draft after propose_definitions", () => {
  it("resolve-after-propose then submit refuses (does not commit invoices.gross_amount)", async () => {
    const dir = initRepo();
    const k = kernelFor(dir);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    recordTerm(k, sessionId, "revenue", "Completed order revenue.");
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns");
    expect(revenue).toBeTruthy();
    expect(revenue!.candidates).toEqual(
      expect.arrayContaining(["orders.net_amount", "invoices.gross_amount"]),
    );
    await resolveAmbiguity(k, sessionId, revenue!.id, "orders.net_amount");
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.unresolved).toBe(true);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/net_amount/);
    expect(proposed.draft_yaml["metrics.yml"]).not.toMatch(/gross_amount/);

    await resolveAll(k, sessionId);
    expect(listAmbiguities(k, sessionId)).toEqual([]);
    try {
      submitProposal(k, sessionId, "stale-resolve");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/Session changed after propose_definitions/);
      expect((err as GraneError).message).toMatch(/Call propose_definitions again/);
    }
    expect(git(dir, ["branch", "--list", "grane/proposal/*"]).trim()).toBe("");
    expect(loadSession(dir, sessionId).draft_yaml["metrics.yml"]).not.toMatch(/gross_amount/);
  });

  it("record_term-after-propose then submit refuses", async () => {
    const dir = initRepo();
    const k = kernelFor(dir);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    recordTerm(k, sessionId, "revenue", "Completed order revenue.");
    await resolveAll(k, sessionId);
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.unresolved).toBe(false);
    expect(proposed.playback).toContain("description Completed order revenue.");

    recordTerm(k, sessionId, "revenue", "Net after refunds.");
    try {
      submitProposal(k, sessionId, "stale-term");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).message).toMatch(/Session changed after propose_definitions/);
    }
    expect(git(dir, ["branch", "--list", "grane/proposal/*"]).trim()).toBe("");
    expect(loadSession(dir, sessionId).draft_yaml["metrics.yml"]).toMatch(/Completed order revenue/);
    expect(loadSession(dir, sessionId).draft_yaml["metrics.yml"]).not.toMatch(/Net after refunds/);

    const rebuilt = await proposeDefinitions(k, sessionId);
    expect(rebuilt.playback).toContain("description Net after refunds.");
    expect(rebuilt.draft_yaml["metrics.yml"]).toMatch(/Net after refunds/);
    const submitted = submitProposal(k, sessionId, "fresh-term");
    expect(submitted.proposal.branch).toMatch(/^grane\/proposal\//);
    const blob = git(dir, ["show", `${submitted.proposal.branch}:metrics.yml`]);
    expect(blob).toMatch(/Net after refunds/);
    expect(blob).not.toMatch(/Completed order revenue/);
  });
});

describe("setup_tone changes wording only", () => {
  it("plain vs technical prompts differ; the same glossary yields identical YAML and playback", async () => {
    const homePlain = tempDir();
    const homeTech = tempDir();
    writeSetupTone(homePlain, "plain");
    writeSetupTone(homeTech, "technical");
    const plainText = setupGranePromptResult(homePlain).messages[0]!.content.text;
    const techText = setupGranePromptResult(homeTech).messages[0]!.content.text;
    expect(plainText).toBe(setupGraneScript("plain"));
    expect(techText).toBe(setupGraneScript("technical"));
    expect(plainText).not.toBe(techText);
    expect(plainText).toMatch(/friendly data engineer/);
    expect(techText).toMatch(/Be concise/);

    async function walk(): Promise<{ yaml: Record<string, string>; playback: string }> {
      const dir = initRepo();
      const k = kernelFor(dir);
      const sessionId = authoringStart(k).session.id;
      await discoverSchema(k, sessionId);
      recordTerm(k, sessionId, "revenue", "Completed order revenue.");
      await resolveAll(k, sessionId);
      const proposed = await proposeDefinitions(k, sessionId);
      return { yaml: proposed.draft_yaml, playback: proposed.playback };
    }

    const a = await walk();
    const b = await walk();
    expect(a.yaml).toEqual(b.yaml);
    expect(a.playback).toEqual(b.playback);
    expect(a.playback).toBe(formatProposalPlayback(a.yaml));
    const blob = Object.values(a.yaml).join("\n");
    expect(blob).not.toMatch(/setup_tone/);
    expect(blob).not.toMatch(/friendly data engineer/);
    expect(blob).not.toMatch(/Be concise/);
  });
});

describe("example transcript", () => {
  it("labels spoken lines abridged and embeds verbatim tool payloads", async () => {
    const fixture = readFileSync(TRANSCRIPT, "utf8");
    expect(fixture).toMatch(/Spoken lines below are \*\*abridged\*\*/);
    expect(fixture).toMatch(/Tool request\/response payloads are \*\*verbatim\*\*/);

    const dir = initRepo();
    const k = kernelFor(dir);
    const sessionId = authoringStart(k).session.id;
    const discovered = await discoverSchema(k, sessionId);
    const recorded = recordTerm(k, sessionId, "revenue", "Completed order revenue.");
    await resolveAll(k, sessionId);
    const proposed = await proposeDefinitions(k, sessionId);

    expect(fixture).toContain(proposed.playback);
    expect(fixture).toContain(proposed.draft_yaml["metrics.yml"]!.trim());
    expect(discovered).toMatchObject({
      session_id: sessionId,
      schema: expect.any(Object),
      relationships: expect.any(Object),
    });
    expect(fixture).toContain('"schema"');
    expect(fixture).toContain('"relationships"');
    expect(fixture).toContain('"snapshot_hash"');
    expect(fixture).toContain('"open_ambiguities"');
    expect(fixture).toContain('"glossary_answers"');
    expect(Object.keys(recorded).sort().join(" ")).toMatch(/glossary_answers/);
    expect(fixture).toMatch(/exploration_disabled/);
    expect(fixture).toContain('"commit"');
    expect(fixture).toContain('"base_branch"');
    expect(fixture).toContain('"base_commit"');
    expect(fixture).toContain('"title"');
    expect(fixture).toContain('"head"');
    expect(fixture).toContain('"repo"');
    expect(fixture).not.toMatch(/your metrics are live/i);
    expect(fixture).not.toMatch(/samples_omitted/);
  });
});
