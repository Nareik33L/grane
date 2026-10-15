import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTHORING_SESSION_VERSION,
  authoringDir,
  createSession,
  listSessions,
  loadSession,
  saveSession,
  sessionDraftSourceHash,
  sessionPath,
  warehouseLocator,
  type AuthoringSession,
} from "../../src/authoring/session.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneError } from "../../src/errors.js";
import { SemanticModel } from "../../src/model/model.js";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../../src");
const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-authoring-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function sampleSession(overrides: Partial<AuthoringSession> = {}): Omit<AuthoringSession, "version"> & {
  version?: typeof AUTHORING_SESSION_VERSION;
} {
  const base: Omit<AuthoringSession, "version"> & { version?: typeof AUTHORING_SESSION_VERSION } = {
    id: "sess-roundtrip",
    created_at: "2026-10-14T12:00:00.000Z",
    updated_at: "2026-10-14T12:30:00.000Z",
    warehouse_ref: { type: "postgres", locator: "analytics.example/shop" },
    discovered_snapshot_hash: "a".repeat(64),
    glossary_answers: [
      { term: "revenue", answer: "Net sales from completed orders." },
      { term: "active customer", answer: "Placed an order in the last 90 days." },
    ],
    open_ambiguities: [
      {
        id: "amb-1",
        kind: "revenue_like_columns",
        question: "Which column is governed revenue?",
        candidates: ["orders.net_amount", "orders.gross_amount"],
      },
    ],
    resolved_ambiguities: [],
    draft_yaml: {
      "grane.yml": "project:\n  name: shop\n",
      "metrics.yml": "metrics:\n  revenue:\n    entity: order\n    type: sum\n    sql: ${orders.net_amount}\n",
    },
    draft_source_hash: null,
    ...overrides,
  };
  if (!("draft_source_hash" in overrides) && Object.keys(base.draft_yaml).length > 0) {
    base.draft_source_hash = sessionDraftSourceHash(base);
  }
  return base;
}

describe("authoring session store", () => {
  it("round-trips: save then load returns the same data", () => {
    const dir = tempDir();
    const created = createSession(dir, sampleSession());
    expect(created.version).toBe(AUTHORING_SESSION_VERSION);
    expect(created).toEqual({
      version: AUTHORING_SESSION_VERSION,
      ...sampleSession(),
    });

    const loaded = loadSession(dir, created.id);
    expect(loaded).toEqual(created);

    const mutated: AuthoringSession = {
      ...loaded,
      updated_at: "2026-10-14T13:00:00.000Z",
      glossary_answers: [...loaded.glossary_answers, { term: "churn", answer: "Cancelled this month." }],
      open_ambiguities: [],
      draft_yaml: { ...loaded.draft_yaml, "dimensions.yml": "dimensions: {}\n" },
    };
    const saved = saveSession(dir, mutated);
    expect(loadSession(dir, created.id)).toEqual(saved);
    expect(saved).toEqual(mutated);

    const onDisk = JSON.parse(readFileSync(sessionPath(dir, created.id), "utf8")) as AuthoringSession;
    expect(onDisk).toEqual(saved);
    expect(authoringDir(dir)).toBe(join(dir, ".grane", "authoring"));
  });

  it("fills defaults and lists sessions by id", () => {
    const dir = tempDir();
    const first = createSession(dir, {
      id: "b-second",
      warehouse_ref: { type: "duckdb", locator: "warehouse.duckdb" },
    });
    expect(first.discovered_snapshot_hash).toBeNull();
    expect(first.glossary_answers).toEqual([]);
    expect(first.open_ambiguities).toEqual([]);
    expect(first.resolved_ambiguities).toEqual([]);
    expect(first.draft_yaml).toEqual({});
    expect(first.draft_source_hash).toBeNull();
    expect(first.created_at).toBe(first.updated_at);

    createSession(dir, {
      id: "a-first",
      warehouse_ref: { type: "mysql", locator: "127.0.0.1/shop" },
      discovered_snapshot_hash: "abc",
    });
    const generated = createSession(dir, {
      warehouse_ref: { type: "clickhouse", locator: "analytics" },
    });
    expect(generated.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );

    expect(listSessions(dir).map((session) => session.id)).toEqual(["a-first", "b-second", generated.id].sort());
    expect(listSessions(tempDir())).toEqual([]);
  });

  it("refuses a missing session, invalid JSON, id mismatch, and unknown version", () => {
    const dir = tempDir();
    expect(() => loadSession(dir, "missing")).toThrow(GraneError);
    expect(() => loadSession(dir, "missing")).toThrow(/No authoring session "missing"/);

    mkdirSync(authoringDir(dir), { recursive: true });
    writeFileSync(sessionPath(dir, "broken"), "{not json");
    expect(() => loadSession(dir, "broken")).toThrow(/not valid JSON/);

    writeFileSync(
      sessionPath(dir, "mismatch"),
      `${JSON.stringify({ version: 1, id: "other", created_at: "t", updated_at: "t", warehouse_ref: { type: "postgres", locator: "db" } })}\n`,
    );
    expect(() => loadSession(dir, "mismatch")).toThrow(/has id "other"/);

    const stale = {
      version: 2,
      id: "stale",
      created_at: "t",
      updated_at: "t",
      warehouse_ref: { type: "postgres", locator: "db" },
    };
    writeFileSync(sessionPath(dir, "stale"), `${JSON.stringify(stale)}\n`);
    expect(() => loadSession(dir, "stale")).toThrow(/Unsupported authoring session version 2/);
    expect(() => listSessions(dir)).toThrow(GraneError);
  });

  it("rejects path-traversal session ids", () => {
    const dir = tempDir();
    const input = { warehouse_ref: { type: "postgres" as const, locator: "db" } };
    expect(() => createSession(dir, { ...input, id: "../escape" })).toThrow(/Invalid authoring session id/);
    expect(() => createSession(dir, { ...input, id: "foo/bar" })).toThrow(/Invalid authoring session id/);
    expect(() => loadSession(dir, "..")).toThrow(/Invalid authoring session id/);
  });

  it("warehouseLocator never includes password or user", () => {
    expect(
      warehouseLocator({
        type: "postgres",
        url: "postgres://grane:SUPERSECRET@db.internal:5432/shop",
      }),
    ).toBe("db.internal:5432/shop");
    expect(warehouseLocator({ type: "duckdb", path: "/data/shop.duckdb" })).toBe("/data/shop.duckdb");
  });
});

describe("loadConfig and model loading isolation from .grane/", () => {
  it("never reads authoring state or other files under .grane/", () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "grane.yml"),
      `
project: { name: isolation }
connection: { type: postgres }
entities:
  order: { table: orders, primary_key: id }
metrics:
  revenue:
    entity: order
    type: sum
    sql: "\${orders.net_amount}"
`,
    );

    mkdirSync(join(dir, ".grane", "authoring"), { recursive: true });
    writeFileSync(join(dir, ".grane", "broken.yml"), "::: this is not yaml {[[[");
    writeFileSync(
      join(dir, ".grane", "metrics.yml"),
      `
metrics:
  leaked_from_dot_grane:
    entity: order
    type: sum
    sql: "\${orders.secret}"
`,
    );
    createSession(dir, {
      id: "authoring-1",
      warehouse_ref: { type: "postgres", locator: "analytics.example/shop" },
      draft_yaml: {
        "metrics.yml": "metrics:\n  leaked_from_session:\n    entity: order\n    type: sum\n    sql: ${orders.secret}\n",
      },
    });

    const loaded = loadConfig(dir);
    expect(loaded.files).toEqual(["grane.yml"]);
    expect(loaded.files.every((file) => !file.includes(".grane"))).toBe(true);
    expect(loaded.config.project.name).toBe("isolation");
    expect(Object.keys(loaded.config.metrics)).toEqual(["revenue"]);
    expect(loaded.config.metrics.leaked_from_dot_grane).toBeUndefined();
    expect(loaded.config.metrics.leaked_from_session).toBeUndefined();

    const model = new SemanticModel(loaded.config);
    expect([...model.metrics.keys()]).toEqual(["revenue"]);
    expect(model.metrics.has("leaked_from_dot_grane")).toBe(false);
    expect(model.metrics.has("leaked_from_session")).toBe(false);
  });

  it("SemanticModel has no filesystem import and loadConfig only scans project-root YAML", () => {
    const modelSrc = readFileSync(join(srcRoot, "model/model.ts"), "utf8");
    expect(modelSrc).not.toMatch(/from ["']node:fs["']/);
    expect(modelSrc).not.toMatch(/from ["']fs["']/);
    expect(modelSrc).not.toMatch(/from ["']node:fs\/promises["']/);

    const loadSrc = readFileSync(join(srcRoot, "config/load.ts"), "utf8");
    expect(loadSrc).not.toMatch(/\.grane/);
    expect(loadSrc).toMatch(/readdirSync\(dir\)/);
    expect(loadSrc).not.toMatch(/recursive:\s*true/);
  });
});
