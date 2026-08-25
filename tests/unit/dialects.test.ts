import { describe, expect, it } from "vitest";
import { exampleKernel } from "../fixtures.js";
import type { WarehouseType } from "../../src/connectors/dialect.js";

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
    expect(compiled.params[0]).toBe("completed");
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
});
