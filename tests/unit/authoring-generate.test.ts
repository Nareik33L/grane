import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import * as publicApi from "../../src/index.js";
import { generateDraftYaml } from "../../src/authoring/generate.js";
import { createSession } from "../../src/authoring/session.js";
import { applyPrimaryKeys, type DatabaseSchema } from "../../src/connectors/types.js";
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

  it("refuses to guess a grain when PRIMARY KEY metadata is missing", () => {
    const dir = tempDir();
    const session = sessionWithRevenue(dir);
    const schema = productsSchema();
    delete schema.tables[0]!.primaryKey;
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(GraneError);
    expect(() => generateDraftYaml({ session, schema, inferred: {} })).toThrow(/Nothing to propose/);
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
  });
});

describe("applyPrimaryKeys / refusal messages", () => {
  it("records the first introspected PRIMARY KEY column per table", () => {
    const tables = [
      { schema: "public", name: "orders", columns: [] as { name: string; dataType: string; nullable: boolean }[] },
    ];
    applyPrimaryKeys(tables, [
      { table: "orders", column: "order_id" },
      { table: "orders", column: "tenant_id" },
    ]);
    expect(tables[0]!.primaryKey).toBe("order_id");
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
