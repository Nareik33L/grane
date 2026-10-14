/**
 * V2-11b path (b): authoring against demo Postgres produces a proposal
 * branch/PR plan and writes no production config or pin. Discovery is
 * read-only and audited. Skips when Postgres is not available.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVE_PIN_PATH, PROPOSAL_BRANCH_PREFIX, readActivePin } from "../../src/authoring/git.js";
import {
  authoringStart,
  discoverSchema,
  listAmbiguities,
  proposeDefinitions,
  recordTerm,
  resolveAmbiguity,
  submitProposal,
} from "../../src/authoring/tools.js";
import { createDiscovery } from "../../src/authoring/discover.js";
import { createConnector } from "../../src/connectors/create.js";
import { grainUniqueColumns } from "../../src/connectors/types.js";
import { GraneKernel } from "../../src/kernel.js";
import { loadConfig } from "../../src/config/load.js";
import { ensureDemoAuthoringGitRepo, writeDemoAuthoringProject } from "../../src/setup/demo-postgres.js";
import { postgresCertEngine } from "../helpers/engines/postgres-cert.js";
import { PRIMARY_KEY_SKIP } from "../../src/authoring/ambiguity.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-demo-pg-e2e-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

const pgAvailable = await postgresCertEngine.available();

describe.skipIf(!pgAvailable)("demo Postgres authoring (path b)", () => {
  it("discovers read-only, skips composite/keyless traps, submits a proposal, and writes no pin", async () => {
    const session = await postgresCertEngine.setup();
    const dir = tempDir();
    try {
      await session.execWrite(`
        CREATE TABLE inventory_levels (
          warehouse_id integer NOT NULL,
          sku text NOT NULL,
          loc_code text UNIQUE,
          on_hand numeric NOT NULL,
          as_of date NOT NULL,
          PRIMARY KEY (warehouse_id, sku)
        )`);
      await session.execWrite(`
        CREATE TABLE event_stream (
          payload text,
          ts bigint,
          period varchar,
          as_of text,
          amount numeric
        )`);
      await session.execWrite(`
        CREATE TABLE daily_rollups (
          id integer PRIMARY KEY,
          n numeric
        ) PARTITION BY RANGE (id)`);

      const written = writeDemoAuthoringProject(dir, {
        url: session.readConnection().url,
        schema: session.schemaName,
      });
      ensureDemoAuthoringGitRepo(dir, { log: () => undefined, error: () => undefined });
      const metricsBefore = readFileSync(join(dir, "metrics.yml"), "utf8");
      const yamlBefore = readFileSync(join(dir, "grane.yml"), "utf8");

      const loaded = loadConfig(dir);
      const connector = createConnector(session.readConnection());
      const kernel = new GraneKernel(loaded.config, { projectDir: dir, connector });
      try {
        const schema = await createDiscovery({
          config: loaded.config,
          connector,
          projectDir: dir,
          sessionId: "demo-pg-e2e",
          agent: "setup-demo-pg",
        }).introspectSchema();
        const inventory = schema.tables.find((table) => table.name === "inventory_levels");
        const events = schema.tables.find((table) => table.name === "event_stream");
        const parted = schema.tables.find((table) => table.name === "daily_rollups");
        expect(inventory?.primaryKey).toBeUndefined();
        expect(inventory?.primaryKeyColumns).toEqual(["warehouse_id", "sku"]);
        expect(inventory?.uniqueColumns).toEqual(["loc_code"]);
        expect(grainUniqueColumns(inventory)).toEqual([]);
        expect(events?.primaryKey).toBeUndefined();
        expect(parted?.primaryKey).toBe("id");

        const started = authoringStart(kernel);
        await discoverSchema(kernel, started.session.id);
        const listed = listAmbiguities(kernel, started.session.id);
        expect(listed.some((item) => item.id.includes("inventory_levels") && item.kind === "primary_key")).toBe(
          false,
        );
        const eventPk = listed.find((item) => item.kind === "primary_key" && item.id.includes("event_stream"));
        expect(eventPk?.candidates.at(-1)).toBe(PRIMARY_KEY_SKIP);

        let open = listAmbiguities(kernel, started.session.id);
        let guard = 0;
        while (open.length > 0) {
          if (guard++ > 40) throw new Error("too many ambiguity rounds");
          const item = open[0]!;
          const chosen = pickCandidate(item);
          await resolveAmbiguity(kernel, started.session.id, item.id, chosen);
          open = listAmbiguities(kernel, started.session.id);
        }
        await recordTerm(kernel, started.session.id, "revenue", "Completed order revenue on the demo shop.");
        const proposed = await proposeDefinitions(kernel, started.session.id);
        expect(proposed.skipped_tables).toContain("inventory_levels");
        expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);

        const submitted = submitProposal(kernel, started.session.id, "demo-pg-authoring");
        expect(submitted.proposal.branch.startsWith(PROPOSAL_BRANCH_PREFIX)).toBe(true);
        expect(submitted.github.command).toMatch(/^gh pr create /);
        expect(submitted.github.head).toBe(submitted.proposal.branch);

        const head = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, encoding: "utf8" });
        expect(head.stdout.trim()).toBe("main");
        expect(readFileSync(join(dir, "metrics.yml"), "utf8")).toBe(metricsBefore);
        expect(readFileSync(join(dir, "grane.yml"), "utf8")).toBe(yamlBefore);
        expect(existsSync(join(dir, ACTIVE_PIN_PATH))).toBe(false);
        expect(readActivePin(dir)).toBeNull();

        const audit = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8");
        expect(audit).toMatch(/"kind":"discovery"/);
        expect(audit).toMatch(/"read_only":true/);
        expect(audit).not.toMatch(/SECRET|password/i);
        expect(written.url).toBe(session.readConnection().url);
      } finally {
        await kernel.close();
      }
    } finally {
      await session.teardown();
    }
  });
});

function pickCandidate(item: { kind: string; candidates: string[] }): string {
  if (item.kind === "primary_key" && item.candidates.includes(PRIMARY_KEY_SKIP)) {
    if (item.candidates.some((c) => c.startsWith("event_stream."))) return PRIMARY_KEY_SKIP;
  }
  if (item.candidates.includes("orders.net_amount")) return "orders.net_amount";
  if (item.kind === "non_additive_measure" && item.candidates.includes("unsupported")) return "unsupported";
  if (item.candidates.includes("do_not_join")) return "do_not_join";
  if (item.candidates.includes("[]")) return "[]";
  const first = item.candidates.find((candidate) => candidate !== PRIMARY_KEY_SKIP) ?? item.candidates[0];
  if (!first) throw new Error(`ambiguity ${item.kind} has no candidates`);
  return first;
}
