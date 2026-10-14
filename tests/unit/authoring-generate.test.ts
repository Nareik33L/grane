import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { generateDraftYaml } from "../../src/authoring/generate.js";
import { createSession } from "../../src/authoring/session.js";
import { applyPrimaryKeys, applySingleColumnUniques, type DatabaseSchema } from "../../src/connectors/types.js";
import { PRIMARY_KEY_SKIP, primaryKeyAmbiguityId } from "../../src/authoring/ambiguity.js";
import { loadConfig } from "../../src/config/load.js";
import { validateModel } from "../../src/validate/validate.js";
import { SemanticModel } from "../../src/model/model.js";
import { GraneError } from "../../src/errors.js";
import {
  forbiddenSemiGroupByPrimaryKeyMessage,
  forbiddenSemiGroupByTemporalMessage,
} from "../../src/authoring/ambiguity.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "grane-generate-"));
  temps.push(dir);
  mkdirSync(join(dir, ".grane"), { recursive: true });
  return dir;
}

function productsSchema(): DatabaseSchema {
  return {
    schemaName: "public",
    tables: [
      {
        schema: "public",
        name: "products",
        primaryKey: "product_id",
        primaryKeyColumns: ["product_id"],
        columns: [
          { name: "sku", dataType: "text", nullable: false },
          { name: "product_id", dataType: "integer", nullable: false },
          { name: "net_amount", dataType: "numeric", nullable: true },
          { name: "gross_amount", dataType: "numeric", nullable: true },
          { name: "completed_at", dataType: "timestamp", nullable: true },
        ],
      },
    ],
    foreignKeys: [],
  };
}

function sessionWithRevenue(dir: string) {
  return createSession(dir, {
    warehouse_ref: { type: "postgres", locator: "db" },
    resolved_ambiguities: [
      {
        id: "amb-revenue-like-products",
        kind: "revenue_like_columns",
        question: "Which column on \"products\" is governed revenue?",
        candidates: ["products.net_amount", "products.gross_amount"],
        chosen: "products.net_amount",
      },
    ],
  });
}

function validateFiles(files: Record<string, string>) {
  const dir = tempDir();
  writeFileSync(
    join(dir, "grane.yml"),
    "project: { name: shop, timezone: UTC }\nconnection: { type: postgres, schema: public }\n",
  );
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(dir, name), contents);
  }
  const loaded = loadConfig(dir);
  return validateModel(new SemanticModel(loaded.config));
}

describe("public API", () => {
  it("exports generateDraftYaml", () => {
    expect(publicApi).toHaveProperty("generateDraftYaml");
    expect(publicApi).toHaveProperty("PRIMARY_KEY_SKIP");
    expect(publicApi.PRIMARY_KEY_SKIP).toBe("skip");
  });
});

describe("generateDraftYaml", () => {
  it("is deterministic: the same session yields the same bytes", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    const first = generateDraftYaml({ session, schema, inferred: {} });
    const second = generateDraftYaml({ session, schema, inferred: {} });
    expect(first.files).toEqual(second.files);
    expect(first.files["metrics.yml"]).toBe(second.files["metrics.yml"]);
    expect(first.files["entities.yml"]).toBe(second.files["entities.yml"]);
  });

  it("emits YAML that loadConfig + validateModel accept with zero errors", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const { files } = generateDraftYaml({ session, schema: productsSchema(), inferred: {} });
    const report = validateFiles(files);
    expect(report.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("uses introspected PRIMARY KEY metadata, not id or the first column", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const { files } = generateDraftYaml({ session, schema: productsSchema(), inferred: {} });
    expect(files["entities.yml"]).toMatch(/primary_key:\s*product_id/);
    expect(files["entities.yml"]).not.toMatch(/primary_key:\s*sku/);
    expect(files["entities.yml"]).not.toMatch(/primary_key:\s*id\b/);
  });

  it("refuses to guess a grain when PRIMARY KEY metadata is missing and lists the skipped table", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    delete schema.tables[0]!.primaryKey;
    delete schema.tables[0]!.primaryKeyColumns;
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(GraneError);
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(/Nothing to propose/);
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(
      /Skipped tables without a usable primary key: products/,
    );
  });

  it("skips a composite PRIMARY KEY instead of using one key column as grain", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    schema.tables[0]!.primaryKey = undefined;
    schema.tables[0]!.primaryKeyColumns = ["tenant_id", "product_id"];
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(/products/);
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(/primary_key/);

    const pickedCompositeColumn = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      resolved_ambiguities: [
        ...session.resolved_ambiguities,
        {
          id: primaryKeyAmbiguityId("products"),
          kind: "primary_key",
          question: "composite",
          candidates: ["products.tenant_id", "products.product_id"],
          chosen: "products.product_id",
        },
      ],
    });
    expect(() => generateDraftYaml({ session: pickedCompositeColumn, schema, inferred: {} })).toThrow(/products/);
  });

  it("uses a single-column UNIQUE constraint as grain on a composite-PK table", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    schema.tables[0]!.primaryKey = undefined;
    schema.tables[0]!.primaryKeyColumns = ["tenant_id", "product_id"];
    schema.tables[0]!.uniqueColumns = ["product_id"];
    const resolved = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      resolved_ambiguities: [
        ...session.resolved_ambiguities,
        {
          id: primaryKeyAmbiguityId("products"),
          kind: "primary_key",
          question: "unique",
          candidates: ["products.product_id", PRIMARY_KEY_SKIP],
          chosen: "products.product_id",
        },
      ],
    });
    const { files } = generateDraftYaml({ session: resolved, schema, inferred: {} });
    expect(files["entities.yml"]).toMatch(/primary_key:\s*product_id/);
    expect(files["entities.yml"]).not.toMatch(/primary_key:\s*tenant_id/);
  });

  it("refuses a nullable UNIQUE column as grain", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    schema.tables[0]!.primaryKey = undefined;
    schema.tables[0]!.primaryKeyColumns = ["tenant_id", "product_id"];
    schema.tables[0]!.uniqueColumns = ["sku"];
    schema.tables[0]!.columns[0]!.nullable = true;
    const resolved = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      resolved_ambiguities: [
        ...session.resolved_ambiguities,
        {
          id: primaryKeyAmbiguityId("products"),
          kind: "primary_key",
          question: "nullable unique",
          candidates: ["products.sku", PRIMARY_KEY_SKIP],
          chosen: "products.sku",
        },
      ],
    });
    expect(() => generateDraftYaml({ session: resolved, schema, inferred: {} })).toThrow(/products/);
  });

  it("honours skip on a keyless table", () => {
    const dir = tempDir();
    const schema = productsSchema();
    delete schema.tables[0]!.primaryKey;
    delete schema.tables[0]!.primaryKeyColumns;
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      resolved_ambiguities: [
        {
          id: "amb-revenue-like-products",
          kind: "revenue_like_columns",
          question: "Which column?",
          candidates: ["products.net_amount", "products.gross_amount"],
          chosen: "products.net_amount",
        },
        {
          id: primaryKeyAmbiguityId("products"),
          kind: "primary_key",
          question: "grain",
          candidates: ["products.sku", PRIMARY_KEY_SKIP],
          chosen: PRIMARY_KEY_SKIP,
        },
      ],
    });
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(
      /Skipped tables without a usable primary key: products/,
    );
  });

  it("honours skip on a composite-PK table that has a UNIQUE column", () => {
    const dir = tempDir();
    const schema = productsSchema();
    schema.tables[0]!.primaryKey = undefined;
    schema.tables[0]!.primaryKeyColumns = ["tenant_id", "product_id"];
    schema.tables[0]!.uniqueColumns = ["product_id"];
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      resolved_ambiguities: [
        {
          id: "amb-revenue-like-products",
          kind: "revenue_like_columns",
          question: "Which column?",
          candidates: ["products.net_amount", "products.gross_amount"],
          chosen: "products.net_amount",
        },
        {
          id: primaryKeyAmbiguityId("products"),
          kind: "primary_key",
          question: "composite unique",
          candidates: ["products.product_id", PRIMARY_KEY_SKIP],
          chosen: PRIMARY_KEY_SKIP,
        },
      ],
    });
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(
      /Skipped tables without a usable primary key: products/,
    );
  });

  it("binds a glossary term to the unique revenue-like column (no revenue_like ambiguity)", () => {
    const dir = tempDir();
    const schema: DatabaseSchema = {
      schemaName: "public",
      tables: [
        {
          schema: "public",
          name: "orders",
          primaryKey: "id",
          primaryKeyColumns: ["id"],
          columns: [
            { name: "id", dataType: "integer", nullable: false },
            { name: "net_amount", dataType: "numeric", nullable: false },
            { name: "completed_at", dataType: "timestamptz", nullable: true },
          ],
        },
        {
          schema: "public",
          name: "products",
          primaryKey: "id",
          primaryKeyColumns: ["id"],
          columns: [
            { name: "id", dataType: "integer", nullable: false },
            { name: "price", dataType: "numeric", nullable: false },
          ],
        },
      ],
      foreignKeys: [],
    };
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      glossary_answers: [{ term: "revenue", answer: "Completed order revenue on the demo shop." }],
    });
    const { files } = generateDraftYaml({ session, schema, inferred: {} });
    expect(files["metrics.yml"]).toMatch(/revenue:/);
    expect(files["metrics.yml"]).toMatch(/sql:\s*\$\{orders\.net_amount\}/);
    expect(files["metrics.yml"]).toMatch(/description:\s*Completed order revenue on the demo shop\./);
    expect(files["metrics.yml"]).not.toMatch(/products\.price/);
    expect(files["entities.yml"]).toMatch(/primary_key:\s*id/);
  });

  it("includes the glossary answer as the metric description", () => {
    const dir = tempDir();
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      glossary_answers: [{ term: "revenue", answer: "Net from completed orders." }],
      resolved_ambiguities: [
        {
          id: "amb-revenue-like-products",
          kind: "revenue_like_columns",
          question: "Which column?",
          candidates: ["products.net_amount", "products.gross_amount"],
          chosen: "products.net_amount",
        },
      ],
    });
    const { files } = generateDraftYaml({ session, schema: productsSchema(), inferred: {} });
    expect(files["metrics.yml"]).toMatch(/description:\s*Net from completed orders\./);
  });

  it("merges new entities and metrics with existing file maps instead of replacing them", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const { files } = generateDraftYaml({
      session,
      schema: productsSchema(),
      inferred: {},
      fileEntities: { category: { table: "categories", primary_key: "id" } },
      fileMetrics: {
        orders: { entity: "order", type: "count", sql: "${orders.id}", status: "approved" },
      },
    });
    expect(files["entities.yml"]).toMatch(/category:/);
    expect(files["entities.yml"]).toMatch(/products:/);
    expect(files["metrics.yml"]).toMatch(/orders:/);
    expect(files["metrics.yml"]).toMatch(/revenue:/);
  });

  it("refuses when a generated entity conflicts with the file map", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    expect(() =>
      generateDraftYaml({
        session,
        schema: productsSchema(),
        inferred: {},
        fileEntities: { products: { table: "products", primary_key: "sku" } },
      }),
    ).toThrow(/overwrite existing entity "products"/);
  });

  it("never emits an exploration allow-list wildcard", () => {
    const dir = tempDir();
    const session = createSession(dir, {
      warehouse_ref: { type: "postgres", locator: "db" },
      glossary_answers: [{ term: "exploration", answer: "yes, allow *" }],
      resolved_ambiguities: [
        {
          id: "amb-revenue-like-products",
          kind: "revenue_like_columns",
          question: "Which column?",
          candidates: ["products.net_amount", "products.gross_amount"],
          chosen: "products.net_amount",
        },
      ],
    });
    const { files } = generateDraftYaml({ session, schema: productsSchema(), inferred: {} });
    expect(Object.keys(files).some((name) => /exploration/i.test(name))).toBe(false);
    for (const contents of Object.values(files)) {
      const parsed = parseYaml(contents);
      expect(parsed).toBeTypeOf("object");
      expect(parsed).not.toHaveProperty("exploration");
      expect(JSON.stringify(parsed)).not.toMatch(/"include"\s*:\s*\[[^\]]*"\*/);
    }
  });

  it("writes relationships through planRelationshipWrite", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const inferred = {
      products_to_categories: {
        from: "products.category_id",
        to: "categories.id",
        type: "many_to_one",
      },
    };
    const written = generateDraftYaml({ session, schema: productsSchema(), inferred });
    expect(written.files["relationships.yml"]).toMatch(/products_to_categories/);
    expect(written.files["relationships.yml"]).toMatch(/products\.category_id/);

    const skipped = generateDraftYaml({
      session,
      schema: productsSchema(),
      inferred,
      catalogRelationships: inferred,
    });
    expect(skipped.files["relationships.yml"]).toBeUndefined();

    const renamed = generateDraftYaml({
      session,
      schema: productsSchema(),
      inferred,
      fileRelationships: {
        products_to_categories: { from: "other.a", to: "other.b", type: "many_to_one" },
      },
    });
    expect(renamed.files["relationships.yml"]).toMatch(/products_to_categories_2/);
    expect(renamed.files["relationships.yml"]).toMatch(/other\.a/);
    expect(renamed.files["relationships.yml"]).toMatch(/products\.category_id/);

    const merged = generateDraftYaml({
      session,
      schema: productsSchema(),
      inferred,
      fileRelationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    });
    expect(merged.files["relationships.yml"]).toMatch(/orders_to_customers/);
    expect(merged.files["relationships.yml"]).toMatch(/products_to_categories/);
  });
});

describe("applyPrimaryKeys / refusal messages", () => {
  it("records a single-column PRIMARY KEY", () => {
    const tables = [
      { schema: "public", name: "orders", columns: [] as { name: string; dataType: string; nullable: boolean }[] },
    ];
    applyPrimaryKeys(tables, [{ table: "orders", column: "order_id" }]);
    expect(tables[0]!.primaryKey).toBe("order_id");
    expect(tables[0]!.primaryKeyColumns).toEqual(["order_id"]);
  });

  it("does not truncate a composite PRIMARY KEY to the first column", () => {
    const tables = [
      { schema: "public", name: "orders", columns: [] as { name: string; dataType: string; nullable: boolean }[] },
    ];
    applyPrimaryKeys(tables, [
      { table: "orders", column: "tenant_id" },
      { table: "orders", column: "order_id" },
    ]);
    expect(tables[0]!.primaryKey).toBeUndefined();
    expect(tables[0]!.primaryKeyColumns).toEqual(["tenant_id", "order_id"]);
  });

  it("records only single-column UNIQUE constraints", () => {
    const tables = [
      { schema: "public", name: "orders", columns: [] as { name: string; dataType: string; nullable: boolean }[] },
    ];
    applySingleColumnUniques(tables, [
      { table: "orders", column: "order_id", constraint: "orders_order_id_key" },
      { table: "orders", column: "tenant_id", constraint: "orders_composite_key" },
      { table: "orders", column: "region_id", constraint: "orders_composite_key" },
    ]);
    expect(tables[0]!.uniqueColumns).toEqual(["order_id"]);
  });

  it("looks up Postgres PRIMARY KEY via pg_constraint including partitioned parents", () => {
    const src = readFileSync(new URL("../../src/connectors/postgres/client.ts", import.meta.url), "utf8");
    expect(src).toMatch(/contype = 'p'/);
    expect(src).toMatch(/contype = 'u'/);
    expect(src).toMatch(/relkind IN \('r', 'p'\)/);
    expect(src).not.toMatch(/\b(FROM|JOIN)\s+information_schema\.table_constraints\b/i);
  });

  it("gives the primary-key refusal a message distinct from the temporal one", () => {
    const pk = forbiddenSemiGroupByPrimaryKeyMessage("inventory.id");
    const temporal = forbiddenSemiGroupByTemporalMessage("inventory.snapshot_at");
    expect(pk).not.toBe(temporal);
    expect(pk).toMatch(/primary key|introspected grain/i);
    expect(pk).not.toMatch(/time dimension|every snapshot|double count/i);
    expect(temporal).toMatch(/time dimension|every snapshot|double count/i);
    expect(temporal).not.toMatch(/introspected grain/i);
  });
});
