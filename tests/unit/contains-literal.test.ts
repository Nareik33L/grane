/**
 * `contains` is literal substring containment, not a user-supplied LIKE pattern.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleKernel } from "../fixtures.js";
import {
  escapeLikeLiteral,
  getDialect,
  LIKE_ESCAPE_CHAR,
  WAREHOUSE_TYPES,
  type WarehouseType,
} from "../../src/connectors/dialect.js";

describe("LIKE literal escape helper", () => {
  it("escapes %, _, and the escape character", () => {
    expect(escapeLikeLiteral("ABC")).toBe("ABC");
    expect(escapeLikeLiteral("A_B")).toBe("A!_B");
    expect(escapeLikeLiteral("A%B")).toBe("A!%B");
    expect(escapeLikeLiteral("%")).toBe("!%");
    expect(escapeLikeLiteral("_")).toBe("!_");
    expect(escapeLikeLiteral("!")).toBe("!!");
    expect(escapeLikeLiteral("!%")).toBe("!!!%");
    expect(escapeLikeLiteral("A\\B")).toBe("A\\B");
    expect(escapeLikeLiteral("")).toBe("");
    expect(escapeLikeLiteral("café")).toBe("café");
    expect(LIKE_ESCAPE_CHAR).toBe("!");
  });
});

function compileContains(type: WarehouseType, value: string) {
  const kernel = exampleKernel();
  kernel.config.connection.type = type;
  if (type === "bigquery") {
    kernel.config.connection.project = "acme";
    kernel.config.connection.dataset = "analytics";
    kernel.config.connection.schema = undefined;
  }
  if (type === "mysql") kernel.config.connection.schema = "shop";
  if (type === "duckdb") kernel.config.connection.schema = "main";
  if (type === "databricks") {
    kernel.config.connection.catalog = "main";
    kernel.config.connection.schema = "analytics";
  }
  return kernel.compile({
    metrics: ["revenue"],
    filters: [{ field: "country", operator: "contains", value }],
    time: { from: "2026-07-01", to: "2026-07-31" },
  });
}

describe("contains compile-inspect (every dialect)", () => {
  const literals = ["ABC", "A_B", "A%B", "%", "_", "\\", "A\\B", "'", "", "café", "!"];

  for (const type of WAREHOUSE_TYPES) {
    it(`${type}: ESCAPE, SQL-side replace, raw bound value`, () => {
      for (const value of literals) {
        const { compiled } = compileContains(type, value);
        expect(compiled.sql, `${type} ${JSON.stringify(value)}`).toMatch(/ESCAPE '!'/);
        expect(compiled.sql, `${type} ${JSON.stringify(value)}`).toMatch(/replace/i);
        expect(compiled.params).toContain(value);
        expect(compiled.sql).not.toMatch(/ILIKE '%' \|\| \$[0-9]+ \|\| '%'(?! ESCAPE)/);
      }
    });
  }

  it("refuses a non-string contains value", () => {
    try {
      exampleKernel().compile({
        metrics: ["revenue"],
        filters: [{ field: "country", operator: "contains", value: 10 }],
      });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toMatch(/string value/);
    }
  });

  it("dialect.contains keeps the placeholder and does not inline the user string", () => {
    for (const type of WAREHOUSE_TYPES) {
      const d = getDialect(type);
      const ph = d.placeholder(1, "A_B");
      const sql = d.contains('"sku"', ph);
      expect(sql).toContain(ph);
      expect(sql).not.toContain("A_B");
      expect(sql).toMatch(/ESCAPE '!'/);
    }
  });
});

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string, opts?: Record<string, string>) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
        closeSync?: () => void;
        disconnectSync?: () => void;
      }>;
      closeSync?: () => void;
    }>;
  };
};

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
const duckdbOk = await duckdbAvailable();

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

describe.skipIf(!duckdbOk)("contains executed literal matrix (DuckDB)", () => {
  let path: string;
  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-contains-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(`
      CREATE TABLE sales (
        id INTEGER,
        sku VARCHAR,
        amount NUMERIC,
        sold_on DATE,
        store_id INTEGER
      );
      CREATE TABLE stores (
        id INTEGER,
        name VARCHAR
      );
      INSERT INTO stores VALUES (1, 'North_Hub'), (2, 'South%Yard');
      INSERT INTO sales VALUES
        (1,  'A_B',   10,    DATE '2026-03-10', 1),
        (2,  'AXB',   1100,  DATE '2026-03-10', 1),
        (3,  'A%B',   1000,  DATE '2026-03-10', 1),
        (4,  'ABC',   10000, DATE '2026-03-10', 1),
        (5,  'A\\B',  7,     DATE '2026-03-10', 1),
        (6,  'A''B',  3,     DATE '2026-03-10', 1),
        (7,  'café',  5,     DATE '2026-03-10', 1),
        (8,  NULL,    2,     DATE '2026-03-10', 1),
        (9,  'abc',   4,     DATE '2026-03-10', 1),
        (10, '%',     8,     DATE '2026-03-10', 1),
        (11, '_',     9,     DATE '2026-03-10', 1),
        (12, '!',     11,    DATE '2026-03-10', 1),
        (13, '',      13,    DATE '2026-03-10', 1),
        (14, 'A_B',   20,    DATE '2026-02-01', 2)
    `);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  function kernel(timezone = "UTC"): GraneKernel {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "contains-literal", timezone },
        connection: { type: "duckdb", path, schema: "main" },
        entities: {
          sale: { table: "sales", primary_key: "id" },
          store: { table: "stores", primary_key: "id" },
        },
        metrics: {
          revenue: { entity: "sale", type: "sum", sql: "${sales.amount}", time_dimension: "${sales.sold_on}" },
          all_revenue: { entity: "sale", type: "sum", sql: "${sales.amount}" },
          ab_underscore: {
            entity: "sale",
            type: "sum",
            sql: "${sales.amount}",
            time_dimension: "${sales.sold_on}",
            filters: [{ field: "sales.sku", operator: "contains", value: "A_B" }],
          },
        },
        dimensions: {
          sku: { entity: "sale", sql: "${sales.sku}" },
          store_name: { entity: "store", sql: "${stores.name}" },
        },
        relationships: {
          sales_stores: { from: "sales.store_id", to: "stores.id", type: "many_to_one" },
        },
      }),
    );
    kernels.push(k);
    return k;
  }

  async function total(filters: { field: string; operator: "contains"; value: string }[], extra: Record<string, unknown> = {}) {
    const k = kernel();
    const result = await k.query({
      metrics: ["all_revenue"],
      filters,
      ...extra,
    } as never);
    return { result, k };
  }

  it("B1: contains ABC is ABC+abc (ILIKE), not every A.B", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "ABC" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(10004);
  });

  it("B2: contains A_B is literal 30 (Mar+Feb), not AXB", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "A_B" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(30);
  });

  it("B3: contains A%B is 1000, not the A.B family", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "A%B" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(1000);
  });

  it("B4: contains % is only rows whose sku contains a percent", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "%" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(1008);
  });

  it("B5: contains _ is only rows whose sku contains an underscore", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "_" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(39);
  });

  it("B6 / B7: backslash is a literal character", async () => {
    const slash = await total([{ field: "sku", operator: "contains", value: "\\" }]);
    expect(slash.result.trust).toBe("governed");
    expect(Number(slash.result.rows[0]!.all_revenue)).toBe(7);
    const pair = await total([{ field: "sku", operator: "contains", value: "A\\B" }]);
    expect(Number(pair.result.rows[0]!.all_revenue)).toBe(7);
  });

  it("B8: contains quote is parameterized", async () => {
    const { result, k } = await total([{ field: "sku", operator: "contains", value: "'" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(3);
    const { compiled } = k.compile({
      metrics: ["all_revenue"],
      filters: [{ field: "sku", operator: "contains", value: "'" }],
    });
    expect(compiled.params).toContain("'");
    expect(compiled.sql).not.toMatch(/sku.*=.*''/);
  });

  it("B9: empty string matches every non-NULL sku", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "" }]);
    expect(result.trust).toBe("governed");
    // 10+1100+1000+10000+7+3+5+4+8+9+11+13+20 = 12190; NULL 2 excluded
    expect(Number(result.rows[0]!.all_revenue)).toBe(12190);
  });

  it("B10: Unicode café", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "café" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(5);
    const accent = await total([{ field: "sku", operator: "contains", value: "é" }]);
    expect(Number(accent.result.rows[0]!.all_revenue)).toBe(5);
  });

  it("B11: NULL sku is not matched by contains A", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "A" }]);
    expect(result.trust).toBe("governed");
    const n = Number(result.rows[0]!.all_revenue);
    // A_B + AXB + A%B + ABC + A\B + A'B + café + abc + Feb A_B. NULL excluded.
    expect(n).toBe(10 + 1100 + 1000 + 10000 + 7 + 3 + 5 + 4 + 20);
  });

  it("B12: case-insensitive (ILIKE) control", async () => {
    const { result } = await total([{ field: "sku", operator: "contains", value: "abc" }]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(10004);
  });

  it("B13: multiple contains filters AND", async () => {
    const { result } = await total([
      { field: "sku", operator: "contains", value: "A" },
      { field: "sku", operator: "contains", value: "_" },
    ]);
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.all_revenue)).toBe(30);
  });

  it("B14: contains as a metric-definition filter", async () => {
    const k = kernel();
    const result = await k.query({ metrics: ["ab_underscore"] });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.ab_underscore)).toBe(30);
  });

  it("B15: contains on a joined dimension", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["all_revenue"],
      filters: [{ field: "store_name", operator: "contains", value: "North_Hub" }],
    });
    expect(result.trust).toBe("governed");
    // All March/NULL/empty rows are store 1 except the Feb A_B (store 2).
    expect(Number(result.rows[0]!.all_revenue)).toBe(10 + 1100 + 1000 + 10000 + 7 + 3 + 5 + 2 + 4 + 8 + 9 + 11 + 13);
    const wild = await k.query({
      metrics: ["all_revenue"],
      filters: [{ field: "store_name", operator: "contains", value: "South%Yard" }],
    });
    expect(Number(wild.rows[0]!.all_revenue)).toBe(20);
  });

  it("B16: contains combined with a time filter", async () => {
    const k = kernel();
    const result = await k.query({
      metrics: ["revenue"],
      filters: [{ field: "sku", operator: "contains", value: "A_B" }],
      time: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.revenue)).toBe(10);
    const { resolved, compiled } = k.compile({
      metrics: ["revenue"],
      filters: [{ field: "sku", operator: "contains", value: "A_B" }],
      time: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(resolved.time?.from).toBe("2026-03-01");
    expect(compiled.params).toContain("A_B");
    expect(compiled.sql).toMatch(/ESCAPE '!'/);
    expect(compiled.sql).not.toMatch(/AT TIME ZONE/);
  });

  it("DATE timezone does not change a contains + time result", async () => {
    for (const tz of ["UTC", "America/New_York"]) {
      const result = await kernel(tz).query({
        metrics: ["revenue"],
        filters: [{ field: "sku", operator: "contains", value: "A_B" }],
        time: { from: "2026-03-01", to: "2026-03-31" },
      });
      expect(result.trust, tz).toBe("governed");
      expect(Number(result.rows[0]!.revenue), tz).toBe(10);
    }
  });
});
