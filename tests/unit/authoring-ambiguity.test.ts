import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import {
  AMBIGUITY_KINDS,
  FANOUT_CANDIDATES,
  GLOBAL_SNAPSHOT_GROUP_BY,
  NON_ADDITIVE_CANDIDATES,
  dateColumnsAmbiguityId,
  detectAmbiguities,
  fanoutAmbiguityId,
  mergeAmbiguities,
  nonAdditiveAmbiguityId,
  parseNonAdditiveAmbiguityId,
  isForbiddenSemiGroupByColumn,
  quoteIdent,
  quoteTableColumn,
  resolvedTimeColumn,
  revenueLikeAmbiguityId,
  semiAdditiveGroupByAmbiguity,
  semiAdditiveGroupById,
} from "../../src/authoring/ambiguity.js";
import { createSession, updateSession } from "../../src/authoring/session.js";
import {
  authoringStart,
  discoverSchema,
  listAmbiguities,
  previewYaml,
  proposeDefinitions,
  resolveAmbiguity,
  submitProposal,
} from "../../src/authoring/tools.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { DatabaseSchema, ExecutedRows, WarehouseConnector } from "../../src/connectors/types.js";
import { GraneKernel } from "../../src/kernel.js";
import { GraneError } from "../../src/errors.js";
import { exampleConfig } from "../fixtures.js";

const temps: string[] = [];
const SECRET_SAMPLE = "SECRET_SAMPLE_VALUE";
const SECRET_PASSWORD = "SUPERSECRET_PASSWORD";

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-ambiguity-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

function table(
  name: string,
  columns: { name: string; dataType: string; nullable?: boolean }[],
): DatabaseSchema["tables"][number] {
  return {
    schema: "public",
    name,
    columns: columns.map((column) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable ?? true,
    })),
  };
}

function schemaOf(
  tables: DatabaseSchema["tables"],
  foreignKeys: DatabaseSchema["foreignKeys"] = [],
): DatabaseSchema {
  return { schemaName: "public", tables, foreignKeys };
}

function stubConnector(schema: DatabaseSchema): WarehouseConnector {
  return {
    type: "postgres",
    dialect: getDialect("postgres"),
    async query(): Promise<ExecutedRows> {
      return { columns: ["v"], rows: [{ v: SECRET_SAMPLE }] };
    },
    async introspect() {
      return schema;
    },
    async close() {},
  };
}

function kernelFor(dir: string, schema: DatabaseSchema): GraneKernel {
  return new GraneKernel(
    exampleConfig({
      connection: {
        type: "postgres",
        schema: "public",
        url: `postgres://grane:${SECRET_PASSWORD}@localhost:5432/grane_demo`,
        password: SECRET_PASSWORD,
      },
      audit: { enabled: false },
    }),
    { projectDir: dir, connector: stubConnector(schema) },
  );
}

function assertQuestionHasNoSamples(question: string): void {
  expect(question).not.toContain(SECRET_SAMPLE);
  expect(question).not.toContain(SECRET_PASSWORD);
  expect(question).not.toMatch(/postgres:\/\//i);
  expect(question).not.toMatch(/password|passwd|token_sha256|\bBearer\b|api[_-]?key|credential/i);
  expect(question).not.toMatch(/sk-[A-Za-z0-9]+/);
  expect(question).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
}

const revenueSchema = schemaOf([
  table("orders", [
    { name: "id", dataType: "integer", nullable: false },
    { name: "net_amount", dataType: "numeric" },
    { name: "gross_amount", dataType: "numeric" },
    { name: "completed_at", dataType: "timestamp" },
  ]),
]);

const datesSchema = schemaOf([
  table("orders", [
    { name: "id", dataType: "integer", nullable: false },
    { name: "net_amount", dataType: "numeric" },
    { name: "gross_amount", dataType: "numeric" },
    { name: "created_at", dataType: "timestamp" },
    { name: "completed_at", dataType: "timestamp" },
  ]),
]);

const nonAdditiveSchema = schemaOf([
  table("orders", [
    { name: "id", dataType: "integer", nullable: false },
    { name: "net_amount", dataType: "numeric" },
    { name: "gross_amount", dataType: "numeric" },
    { name: "completed_at", dataType: "timestamp" },
  ]),
  table("inventory", [
    { name: "id", dataType: "integer", nullable: false },
    { name: "warehouse_id", dataType: "integer", nullable: false },
    { name: "balance", dataType: "numeric" },
    { name: "snapshot_at", dataType: "timestamp" },
  ]),
]);

const fanoutSchema = schemaOf(
  [
    table("customers", [
      { name: "id", dataType: "integer", nullable: false },
      { name: "email", dataType: "text" },
    ]),
    table("orders", [
      { name: "id", dataType: "integer", nullable: false },
      { name: "customer_id", dataType: "integer", nullable: false },
      { name: "net_amount", dataType: "numeric" },
      { name: "gross_amount", dataType: "numeric" },
      { name: "completed_at", dataType: "timestamp" },
    ]),
  ],
  [
    {
      constraintName: "orders_customer_id_fkey",
      table: "orders",
      column: "customer_id",
      refTable: "customers",
      refColumn: "id",
    },
  ],
);

const ambiguousFanoutRels = {
  orders_billing: { from: "orders.billing_customer_id", to: "customers.id", type: "many_to_one" },
  orders_shipping: { from: "orders.shipping_customer_id", to: "customers.id", type: "many_to_one" },
};

describe("public API", () => {
  it("exports the ambiguity engine", () => {
    expect(publicApi).toHaveProperty("detectAmbiguities");
    expect(publicApi).toHaveProperty("mergeAmbiguities");
    expect(publicApi.AMBIGUITY_KINDS).toEqual([...AMBIGUITY_KINDS]);
  });
});

describe("revenue-like columns", () => {
  it("asks which column is governed revenue instead of picking the first", () => {
    const found = detectAmbiguities({ schema: revenueSchema });
    const amb = found.find((item) => item.kind === "revenue_like_columns");
    expect(amb).toMatchObject({
      id: revenueLikeAmbiguityId("orders"),
      kind: "revenue_like_columns",
      candidates: ["orders.net_amount", "orders.gross_amount"],
    });
    expect(amb?.question).toMatch(/will not guess/i);
    assertQuestionHasNoSamples(amb!.question);
  });

  it("does not open an ambiguity for a single revenue-like column", () => {
    const found = detectAmbiguities({
      schema: schemaOf([
        table("orders", [
          { name: "id", dataType: "integer", nullable: false },
          { name: "net_amount", dataType: "numeric" },
          { name: "completed_at", dataType: "timestamp" },
        ]),
      ]),
    });
    expect(found.some((item) => item.kind === "revenue_like_columns")).toBe(false);
  });

  it("propose_definitions uses the resolved column, not the other candidate", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, revenueSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const amb = listed.find((item) => item.kind === "revenue_like_columns")!;
    await resolveAmbiguity(k, sessionId, amb.id, "orders.net_amount");
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/sql:\s*\$\{orders\.net_amount\}/);
    expect(proposed.draft_yaml["metrics.yml"]).not.toMatch(/gross_amount/);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/time_dimension:\s*\$\{orders\.completed_at\}/);
  });
});

describe("date columns", () => {
  it("asks which date is the time dimension instead of picking the first _at column", () => {
    const found = detectAmbiguities({ schema: datesSchema });
    const amb = found.find((item) => item.kind === "date_columns");
    expect(amb).toMatchObject({
      id: dateColumnsAmbiguityId("orders"),
      kind: "date_columns",
      candidates: ["orders.created_at", "orders.completed_at"],
    });
    expect(amb?.question).toMatch(/will not pick one/i);
    assertQuestionHasNoSamples(amb!.question);
    expect(
      resolvedTimeColumn({ resolved_ambiguities: [] }, datesSchema, "orders"),
    ).toBeUndefined();
  });

  it("uses a unique temporal column without asking", () => {
    expect(
      resolvedTimeColumn({ resolved_ambiguities: [] }, revenueSchema, "orders"),
    ).toBe("completed_at");
  });

  it("omits time_dimension until the date ambiguity is resolved", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, datesSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const dates = listed.find((item) => item.kind === "date_columns")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    const guessed = await proposeDefinitions(k, sessionId);
    expect(guessed.unresolved).toBe(true);
    expect(guessed.unresolved_ambiguities.some((item) => item.kind === "date_columns")).toBe(true);
    expect(guessed.warning).toMatch(/submit_proposal will refuse/);
    expect(guessed.draft_yaml["metrics.yml"]).not.toMatch(/time_dimension/);
    expect(guessed.draft_yaml["metrics.yml"]).not.toMatch(/created_at/);

    await resolveAmbiguity(k, sessionId, dates.id, "orders.completed_at");
    const resolved = await proposeDefinitions(k, sessionId);
    expect(resolved.draft_yaml["metrics.yml"]).toMatch(/time_dimension:\s*\$\{orders\.completed_at\}/);
    expect(resolved.draft_yaml["metrics.yml"]).not.toMatch(/created_at/);
  });
});

describe("non-additive measures", () => {
  it("asks semi vs unsupported and never offers additive:none", () => {
    const found = detectAmbiguities({ schema: nonAdditiveSchema });
    const amb = found.find((item) => item.kind === "non_additive_measure");
    expect(amb).toMatchObject({
      id: nonAdditiveAmbiguityId("inventory", "balance"),
      kind: "non_additive_measure",
      candidates: [...NON_ADDITIVE_CANDIDATES],
    });
    expect(amb?.candidates).toEqual(["semi", "unsupported"]);
    expect(amb?.candidates).not.toContain("none");
    expect(amb?.question).toMatch(/refuse additive:none/i);
    expect(amb?.question).toMatch(/will not default to SUM/i);
    assertQuestionHasNoSamples(amb!.question);
    expect(parseNonAdditiveAmbiguityId(amb!.id)).toEqual({ table: "inventory", column: "balance" });
  });

  it("refuses resolving additive:none and does not SUM an unresolved snapshot", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, nonAdditiveSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const snapshot = listed.find((item) => item.kind === "non_additive_measure")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    await expect(resolveAmbiguity(k, sessionId, snapshot.id, "none")).rejects.toBeInstanceOf(GraneError);
    await expect(resolveAmbiguity(k, sessionId, snapshot.id, "none")).rejects.toThrow(/not a candidate/);

    const unresolved = await proposeDefinitions(k, sessionId);
    expect(unresolved.draft_yaml["metrics.yml"]).not.toMatch(/balance/);
    expect(unresolved.draft_yaml["metrics.yml"]).not.toMatch(/additive:\s*none/);

    await resolveAmbiguity(k, sessionId, snapshot.id, "unsupported");
    const refused = await proposeDefinitions(k, sessionId);
    expect(refused.draft_yaml["metrics.yml"]).not.toMatch(/balance/);
    expect(refused.draft_yaml["metrics.yml"]).not.toMatch(/additive:\s*none/);
  });

  it("asks for group_by after semi; emitted YAML validates (not vacuous_semi_additive_group_by)", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, nonAdditiveSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const snapshot = listed.find((item) => item.kind === "non_additive_measure")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    await resolveAmbiguity(k, sessionId, snapshot.id, "semi");
    const follow = listAmbiguities(k, sessionId).find((item) => item.kind === "semi_additive_group_by");
    expect(follow).toMatchObject({
      id: semiAdditiveGroupById("inventory", "balance"),
      candidates: expect.arrayContaining([GLOBAL_SNAPSHOT_GROUP_BY]),
    });
    expect(follow?.candidates).not.toContain("entity");
    expect(follow?.candidates).not.toContain("inventory.id");
    expect(follow?.candidates).not.toContain("inventory.snapshot_at");
    expect(follow?.candidates).toContain("inventory.warehouse_id");
    expect(follow?.question).toContain(quoteTableColumn("inventory", "balance"));
    expect(follow?.question).toMatch(/vacuous_semi_additive_group_by/);
    assertQuestionHasNoSamples(follow!.question);

    const beforeGroup = await proposeDefinitions(k, sessionId);
    expect(beforeGroup.unresolved).toBe(true);
    expect(beforeGroup.draft_yaml["metrics.yml"]).not.toMatch(/balance/);

    await resolveAmbiguity(k, sessionId, follow!.id, GLOBAL_SNAPSHOT_GROUP_BY);
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/sql:\s*\$\{inventory\.balance\}/);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/additive:\s*semi/);
    expect(proposed.draft_yaml["metrics.yml"]).toMatch(/group_by:\s*\[\]/);
    expect(proposed.draft_yaml["metrics.yml"]).not.toMatch(/additive:\s*none/);
    expect(proposed.draft_yaml["metrics.yml"]).not.toMatch(/group_by:\s*entity/);

    const preview = previewYaml(k, sessionId);
    expect(preview.validation.ok).toBe(true);
    expect(preview.validation.issues.some((issue) => issue.code === "vacuous_semi_additive_group_by")).toBe(
      false,
    );
  });

  it("does not offer or accept snapshot_at as group_by", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, nonAdditiveSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const snapshot = listed.find((item) => item.kind === "non_additive_measure")!;
    await resolveAmbiguity(k, sessionId, snapshot.id, "semi");
    const follow = listAmbiguities(k, sessionId).find((item) => item.kind === "semi_additive_group_by")!;
    expect(follow.candidates).not.toContain("inventory.snapshot_at");
    expect(follow.candidates.some((item) => item.includes("snapshot_at"))).toBe(false);
    expect(
      isForbiddenSemiGroupByColumn(nonAdditiveSchema, "inventory", "balance", "snapshot_at", "snapshot_at"),
    ).toBe(true);
    expect(
      semiAdditiveGroupByAmbiguity(nonAdditiveSchema, "inventory", "balance", "snapshot_at").candidates,
    ).not.toContain("inventory.snapshot_at");

    await expect(resolveAmbiguity(k, sessionId, follow.id, "inventory.snapshot_at")).rejects.toThrow(
      /time dimension|temporal|every snapshot|double count/i,
    );
    expect(listAmbiguities(k, sessionId).some((item) => item.id === follow.id)).toBe(true);
  });
});

describe("fanout joins", () => {
  it("asks how to combine a parent→child one-to-many join", () => {
    const found = detectAmbiguities({
      schema: fanoutSchema,
      relationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    });
    const amb = found.find((item) => item.kind === "fanout_join");
    expect(amb).toMatchObject({
      id: fanoutAmbiguityId("customers", "orders"),
      kind: "fanout_join",
      candidates: [...FANOUT_CANDIDATES],
    });
    expect(amb?.question).toMatch(/multiplies rows/i);
    expect(amb?.question).toContain(quoteIdent("customers"));
    expect(amb?.question).toContain(quoteIdent("orders"));
    expect(amb?.question).toMatch(/will not guess/i);
    assertQuestionHasNoSamples(amb!.question);
  });

  it("asks which path when RelationshipGraph finds multiple routes", () => {
    const found = detectAmbiguities({
      schema: schemaOf([
        table("customers", [{ name: "id", dataType: "integer", nullable: false }]),
        table("orders", [
          { name: "id", dataType: "integer", nullable: false },
          { name: "billing_customer_id", dataType: "integer", nullable: false },
          { name: "shipping_customer_id", dataType: "integer", nullable: false },
        ]),
      ]),
      relationships: ambiguousFanoutRels,
    });
    const pathAsk = found.find((item) => item.id === fanoutAmbiguityId("orders", "customers"));
    expect(pathAsk?.kind).toBe("fanout_join");
    expect(pathAsk?.question).toMatch(/Multiple join paths/i);
    expect(pathAsk?.question).toMatch(/YAML or BFS order is not a discriminator/i);
    expect(pathAsk?.candidates.length).toBeGreaterThanOrEqual(2);
    assertQuestionHasNoSamples(pathAsk!.question);
    for (const candidate of pathAsk!.candidates) {
      assertQuestionHasNoSamples(candidate);
    }
  });

  it("omits unresolved and do_not_join fan-out; preaggregate writes the relationship", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, fanoutSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const fanout = listed.find((item) => item.kind === "fanout_join")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    const unresolved = await proposeDefinitions(k, sessionId);
    expect(unresolved.draft_yaml["relationships.yml"] ?? "").not.toMatch(/customers/);
    expect(unresolved.unresolved).toBe(true);

    await resolveAmbiguity(k, sessionId, fanout.id, "preaggregate");
    const preagg = await proposeDefinitions(k, sessionId);
    expect(preagg.draft_yaml["relationships.yml"]).toMatch(/orders_to_customers|customers/);
    expect(preagg.draft_yaml["relationships.yml"]).toMatch(/preaggregate/);
    expect(preagg.unresolved).toBe(false);
  });

  it("omits a do_not_join relationship from draft YAML", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, fanoutSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const fanout = listed.find((item) => item.kind === "fanout_join")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    await resolveAmbiguity(k, sessionId, fanout.id, "do_not_join");
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.draft_yaml["relationships.yml"] ?? "").not.toMatch(/customers/);
  });
});

describe("merge and samples", () => {
  it("keeps open items and skips resolved ids", () => {
    const detected = detectAmbiguities({ schema: datesSchema });
    expect(detected.length).toBeGreaterThan(1);
    const merged = mergeAmbiguities(detected, [], detected);
    expect(merged).toHaveLength(detected.length);
    const after = mergeAmbiguities([], [{ id: detected[0]!.id }], detected);
    expect(after.map((item) => item.id)).not.toContain(detected[0]!.id);
    expect(after).toHaveLength(detected.length - 1);
  });

  it("quotes identifiers in question text", () => {
    const found = detectAmbiguities({ schema: nonAdditiveSchema });
    const revenue = found.find((item) => item.kind === "revenue_like_columns")!;
    const dates = detectAmbiguities({ schema: datesSchema }).find((item) => item.kind === "date_columns")!;
    const snapshot = found.find((item) => item.kind === "non_additive_measure")!;
    expect(revenue.question).toContain(quoteIdent("orders"));
    expect(dates.question).toContain(quoteIdent("orders"));
    expect(snapshot.question).toContain(quoteTableColumn("inventory", "balance"));
  });

  it("resolve_ambiguity requires a non-empty candidate list", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, revenueSchema);
    const created = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
    });
    updateSession(dir, created.id, {
      open_ambiguities: [
        {
          id: "amb-empty",
          kind: "revenue_like_columns",
          question: `Which column on ${quoteIdent("orders")} is governed revenue?`,
          candidates: [],
        },
      ],
    });
    await expect(resolveAmbiguity(k, created.id, "amb-empty", "orders.net_amount")).rejects.toThrow(
      /no candidates/i,
    );
  });

  it("never embeds sample values, tokens, or credentials in question text", () => {
    const found = [
      ...detectAmbiguities({ schema: revenueSchema }),
      ...detectAmbiguities({ schema: datesSchema }),
      ...detectAmbiguities({ schema: nonAdditiveSchema }),
      ...detectAmbiguities({
        schema: fanoutSchema,
        relationships: {
          orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        },
      }),
    ];
    expect(found.length).toBeGreaterThan(3);
    for (const item of found) {
      assertQuestionHasNoSamples(item.question);
      for (const candidate of item.candidates) {
        expect(candidate).not.toContain(SECRET_SAMPLE);
        expect(candidate).not.toContain(SECRET_PASSWORD);
      }
    }
  });
});

describe("unresolved ambiguities and invalid drafts", () => {
  it("flags open ambiguities on propose_definitions and preview_yaml; submit_proposal refuses with the list", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, fanoutSchema);
    const sessionId = authoringStart(k).session.id;
    await discoverSchema(k, sessionId);
    const listed = listAmbiguities(k, sessionId);
    const revenue = listed.find((item) => item.kind === "revenue_like_columns")!;
    const fanout = listed.find((item) => item.kind === "fanout_join")!;
    await resolveAmbiguity(k, sessionId, revenue.id, "orders.net_amount");
    const proposed = await proposeDefinitions(k, sessionId);
    expect(proposed.unresolved).toBe(true);
    expect(proposed.unresolved_ambiguities.map((item) => item.id)).toContain(fanout.id);
    expect(proposed.warning).toMatch(/submit_proposal will refuse/);
    expect(proposed.warning).toContain(fanout.id);

    const preview = previewYaml(k, sessionId);
    expect(preview.unresolved).toBe(true);
    expect(preview.unresolved_ambiguities.map((item) => item.id)).toContain(fanout.id);
    expect(preview.warning).toMatch(/submit_proposal will refuse/);

    try {
      submitProposal(k, sessionId);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("config_error");
      expect((err as GraneError).message).toMatch(/Unresolved ambiguities/);
      expect((err as GraneError).message).toContain(fanout.id);
      expect((err as GraneError).refusal.details).toMatchObject({
        unresolved_ambiguities: expect.arrayContaining([expect.objectContaining({ id: fanout.id })]),
      });
    }
  });

  it("submit_proposal refuses when preview YAML does not validate", async () => {
    const dir = tempDir();
    const k = kernelFor(dir, nonAdditiveSchema);
    const created = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
    });
    updateSession(dir, created.id, {
      open_ambiguities: [],
      draft_yaml: {
        "entities.yml": "entities:\n  inventory:\n    table: inventory\n    primary_key: id\n",
        "metrics.yml":
          "metrics:\n  balance:\n    entity: inventory\n    type: sum\n    sql: ${inventory.balance}\n" +
          "    time_dimension: ${inventory.snapshot_at}\n    additive: semi\n    status: experimental\n",
      },
    });
    try {
      submitProposal(k, created.id);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("config_error");
      expect((err as GraneError).message).toMatch(/does not validate/i);
      const issues = ((err as GraneError).refusal.details as { issues?: { code: string }[] } | undefined)?.issues;
      expect(issues?.some((issue) => issue.code === "vacuous_semi_additive_group_by")).toBe(true);
    }
  });
});
