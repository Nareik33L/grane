/**
 * V2-07 discovery against CI-certified engines (PG16, MySQL8, DuckDB, CH24).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createDiscovery, runDiscoveryQuery } from "../../src/authoring/discover.js";
import { createConnector } from "../../src/connectors/create.js";
import { isWriteSql } from "../../src/connectors/types.js";
import { GraneError } from "../../src/errors.js";
import { CI_REQUIRED_CERT_ENGINES, loadAvailableEngines, type CertSession } from "../helpers/cert-engine.js";

const engines = await loadAvailableEngines();
const sessions: CertSession[] = [];
const dirs: string[] = [];

afterAll(async () => {
  for (const session of sessions) await session.teardown();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("discovery cert engine enrollment", () => {
  it("runs the four CI-required engines when they are available", () => {
    const present = new Set(engines.map((engine) => engine.type));
    if (process.env.GRANE_CERT_REQUIRE) {
      for (const type of CI_REQUIRED_CERT_ENGINES) {
        expect(present.has(type), `required engine ${type}`).toBe(true);
      }
    }
  });
});

for (const engine of engines.filter((item) =>
  (CI_REQUIRED_CERT_ENGINES as readonly string[]).includes(item.type),
)) {
  describe(`discovery on ${engine.type}`, () => {
    it("introspects, infers, profiles, excludes, and refuses writes", async () => {
      const session = await engine.setup();
      sessions.push(session);
      const dir = mkdtempSync(join(tmpdir(), `grane-disc-${engine.type}-`));
      dirs.push(dir);
      mkdirSync(join(dir, ".grane"), { recursive: true });

      const config = {
        ...session.environment(),
        audit: { enabled: true, path: ".grane/audit.jsonl", stdout: false, fail_closed: false },
        exploration: {
          ...session.environment().exploration,
          enabled: true,
          mode: "denylist" as const,
          exclude: ["customers.name"],
        },
        authoring: { sampling: true, sample_rows: 10 },
      };
      const connector = createConnector(session.readConnection());
      try {
        const discovery = createDiscovery({
          config,
          connector,
          projectDir: dir,
          sessionId: "cert-sess",
          agent: "authoring",
        });

        const schema = await discovery.introspectSchema();
        expect(schema.tables.some((table) => table.name === "customers")).toBe(true);
        expect(schema.tables.some((table) => table.name === "orders")).toBe(true);

        const inferred = await discovery.inferRelationships(schema);
        expect(inferred).toEqual(expect.any(Object));

        const profile = await discovery.profileColumn("customers", "status");
        expect(profile.samples.length).toBeGreaterThan(0);
        expect(profile.samples.length).toBeLessThanOrEqual(10);
        expect(profile.sql.every((sql) => !isWriteSql(sql))).toBe(true);
        expect(profile.sql.every((sql) => /^SELECT\b/i.test(sql))).toBe(true);
        const sampleValues = profile.samples.map((value) => String(value));

        await expect(discovery.profileColumn("customers", "name")).rejects.toMatchObject({
          refusal: { status: "column_not_permitted" },
        });

        await expect(
          runDiscoveryQuery(connector, "INSERT INTO customers VALUES (1)", config.limits),
        ).rejects.toMatchObject({ refusal: { status: "unsafe_query" } });

        const raw = readFileSync(join(dir, ".grane", "audit.jsonl"), "utf8");
        for (const value of sampleValues) {
          expect(raw).not.toContain(value);
        }
        expect(raw).not.toContain("Cedar");
        expect(raw).not.toContain("Beta");
        const events = raw
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { kind: string; operation: string; read_only: boolean });
        expect(events.every((event) => event.kind === "discovery" && event.read_only === true)).toBe(true);
        expect(events.map((event) => event.operation)).toEqual(
          expect.arrayContaining(["introspect", "relationships", "profile"]),
        );
      } finally {
        await connector.close();
      }
    });
  });
}
