import { describe, expect, it } from "vitest";
import { exampleKernel } from "../fixtures.js";
import { RESULT_ROW_COLUMN } from "../../src/compile/compiler.js";
import { WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";

function compileFor(type: WarehouseType) {
  const kernel = exampleKernel();
  kernel.config.connection.type = type;
  if (type === "bigquery") {
    kernel.config.connection.project = "acme";
    kernel.config.connection.dataset = "analytics";
    kernel.config.connection.schema = undefined;
  }
  if (type === "mysql") {
    kernel.config.connection.schema = "shop";
  }
  if (type === "duckdb") {
    kernel.config.connection.schema = "main";
  }
  if (type === "databricks") {
    kernel.config.connection.catalog = "main";
    kernel.config.connection.schema = "analytics";
  }
  return kernel.compile({
    metrics: ["revenue"],
    dimensions: ["country"],
    time: { from: "2026-07-01", to: "2026-07-31", grain: "month" },
  }).compiled;
}

describe("warehouse SQL dialects", () => {
  it("emits postgres placeholders and FILTER", () => {
    const sql = compileFor("postgres").sql;
    expect(sql).toContain('FROM "public"."orders"');
    expect(sql).toContain("FILTER (WHERE");
    expect(sql).toContain("$1");
  });

  it("emits mysql backticks, ? placeholders, and CASE filters", () => {
    const compiled = compileFor("mysql");
    expect(compiled.sql).toContain("FROM `shop`.`orders`");
    expect(compiled.sql).toContain("JOIN `shop`.`customers`");
    expect(compiled.sql).toContain("SUM(CASE WHEN");
    expect(compiled.sql).not.toContain("FILTER (WHERE");
    expect(compiled.sql).toContain("?");
    expect(compiled.sql).not.toContain("$1");
    expectPositionalBinds(compiled.sql, compiled.params);
  });

  it("binds ? placeholders in textual order when a join reorders the clauses", () => {
    const kernel = exampleKernel();
    kernel.config.connection.type = "mysql";
    kernel.config.connection.schema = "shop";
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
      filters: [{ field: "customer_type", operator: "=", value: "business" }],
    });
    expectPositionalBinds(compiled.sql, compiled.params);
    // Population CTE (time) → contributing population (metric filter) → result (metric filter, joined filter).
    expect(compiled.params).toEqual(["2026-07-01", "2026-08-01", "completed", "completed", "business"]);
    // The outer wrapper references result aliases, never re-renders aggregates.
    expect(compiled.sql).toMatch(/LEFT JOIN `__grane_result` ON TRUE$/);
    expect(compiled.sql.split("\n").filter((line) => line.includes("SUM(CASE WHEN"))).toHaveLength(1);
  });

  it("emits snowflake DATE_TRUNC and ? binds", () => {
    const sql = compileFor("snowflake").sql;
    expect(sql).toContain("DATE_TRUNC('MONTH'");
    expect(sql).toContain("?");
    expect(sql).toContain("FILTER (WHERE");
  });

  it("emits bigquery named params and TIMESTAMP_TRUNC", () => {
    const compiled = compileFor("bigquery");
    expect(compiled.sql).toContain("`acme`.`analytics`.`orders`");
    expect(compiled.sql).toContain("TIMESTAMP_TRUNC(");
    expect(compiled.sql).toContain("@p1");
    expect(compiled.sql).toContain("SUM(CASE WHEN");
  });

  it("emits clickhouse toStartOf* and {pN:Type} params", () => {
    const compiled = compileFor("clickhouse");
    expect(compiled.sql).toContain("{p1:String}");
    expect(compiled.sql).toContain("SUM(CASE WHEN");
  });

  it("redshift uses $n but not FILTER", () => {
    const sql = compileFor("redshift").sql;
    expect(sql).toContain("$1");
    expect(sql).toContain("SUM(CASE WHEN");
    expect(sql).not.toContain("FILTER (WHERE");
  });

  it("emits duckdb unquoted-main tables, $n placeholders, and FILTER", () => {
    const sql = compileFor("duckdb").sql;
    expect(sql).toContain('FROM "orders"');
    expect(sql).not.toContain('"main"."orders"');
    expect(sql).toContain("FILTER (WHERE");
    expect(sql).toContain("$1");
    expect(sql).toContain("date_trunc('month'");
  });

  it("emits databricks catalog.schema backticks, DATE_TRUNC, and ?", () => {
    const compiled = compileFor("databricks");
    expect(compiled.sql).toContain("FROM `main`.`analytics`.`orders`");
    expect(compiled.sql).toContain("JOIN `main`.`analytics`.`customers`");
    expect(compiled.sql).toContain("DATE_TRUNC('MONTH'");
    expect(compiled.sql).toContain("FILTER (WHERE");
    expect(compiled.sql).toContain("?");
    expect(compiled.sql).not.toContain("$1");
    expectPositionalBinds(compiled.sql, compiled.params);
  });

  it("emits the structural row marker on every dialect and keeps it off plan.columns", () => {
    for (const type of WAREHOUSE_TYPES) {
      const compiled = compileFor(type);
      expect(compiled.sql, type).toMatch(/1 AS [`"]__grane_row[`"]/);
      expect(compiled.plan.columns, type).not.toContain(RESULT_ROW_COLUMN);
    }
  });
});

/**
 * `?` dialects bind by position: the k-th `?` in the text receives params[k-1].
 * The example revenue metric is filtered on `status = 'completed'` and the
 * query is time-bounded, so the text must read time bounds before the filter.
 */
function expectPositionalBinds(sql: string, params: unknown[]): void {
  expect((sql.match(/\?/g) ?? []).length).toBe(params.length);
  // The first `?` in the text is the population CTE's lower time bound; the
  // metric filter's `?` comes later, inside the aggregate.
  const firstMark = sql.indexOf("?");
  const aggregate = sql.search(/CASE WHEN|FILTER \(WHERE/);
  expect(firstMark).toBeGreaterThanOrEqual(0);
  expect(firstMark).toBeLessThan(aggregate);
  expect(params[0]).toBe("2026-07-01");
  expect(params[1]).toBe("2026-08-01");
  expect(params.slice(2)).toContain("completed");
}
