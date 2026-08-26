import { describe, expect, it } from "vitest";
import { exampleKernel } from "../fixtures.js";
import { WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";
import { gauntletConfig } from "../gauntlet/model.js";
import { GAUNTLET_NOW } from "../gauntlet/types.js";
import { GraneKernel } from "../../src/kernel.js";
import type { DatabaseSchema } from "../../src/connectors/types.js";

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
    expect(compiled.params[0]).toBe("completed");
  });
});

function gauntletAdapterKernel(type: WarehouseType): GraneKernel {
  const config = gauntletConfig();
  config.connection.type = type;
  if (type === "bigquery") {
    config.connection.project = "acme";
    config.connection.dataset = "analytics";
    config.connection.schema = undefined;
  } else if (type === "mysql") {
    config.connection.schema = "shop";
  } else if (type === "duckdb") {
    config.connection.schema = "main";
  } else if (type === "databricks") {
    config.connection.catalog = "main";
    config.connection.schema = "analytics";
  } else {
    config.connection.schema = "public";
  }
  const kernel = new GraneKernel(config, { now: GAUNTLET_NOW, schema: gauntletAdapterSchema() });
  kernel.setSchema(gauntletAdapterSchema());
  return kernel;
}

function gauntletAdapterSchema(): DatabaseSchema {
  const col = (name: string, dataType: string) => ({ name, dataType, nullable: true });
  const table = (name: string, columns: ReturnType<typeof col>[]) => ({
    schema: "public",
    name,
    columns,
  });
  return {
    schemaName: "public",
    foreignKeys: [],
    tables: [
      table("orders", [
        col("id", "integer"),
        col("customer_id", "integer"),
        col("net_amount", "numeric"),
        col("status", "varchar"),
        col("channel", "varchar"),
        col("completed_at", "timestamptz"),
        col("created_at", "timestamptz"),
      ]),
      table("customers", [col("id", "integer"), col("country", "varchar")]),
      table("payments", [col("order_id", "integer"), col("amount", "numeric"), col("status", "varchar")]),
      table("daily_account_snapshots", [
        col("account_id", "integer"),
        col("snapshot_date", "date"),
        col("balance", "numeric"),
      ]),
      table("accounts", [col("id", "integer"), col("name", "varchar")]),
    ],
  };
}

describe("cross-adapter canonical semantics (compile only)", () => {
  it("compiles last-as-of, conversion, this_week, and civil DATE consistently across adapters", () => {
    for (const type of WAREHOUSE_TYPES) {
      const kernel = gauntletAdapterKernel(type);
      const lastAsOf = kernel.compile({
        metrics: ["account_balance"],
        time: { from: "2024-03-01", to: "2024-03-15" },
      }).compiled;
      expect(lastAsOf.sql, type).toMatch(/last_account_balance/);
      expect(lastAsOf.sql, type).not.toMatch(/AT TIME ZONE/i);
      expect(lastAsOf.sql, type).not.toMatch(/CONVERT_TZ/i);

      const conversion = kernel.compile({
        metrics: ["conversion_rate"],
        time: { period: "last_month" },
      }).compiled;
      expect(conversion.sql, type).toMatch(/created_at/);
      expect(conversion.sql, type).toMatch(/completed_at/);
      if (type === "mysql" || type === "bigquery" || type === "clickhouse" || type === "redshift") {
        expect(conversion.sql, type).toMatch(/CASE WHEN/);
      } else {
        expect(conversion.sql, type).toMatch(/FILTER \(WHERE/);
      }

      const week = kernel.compile({
        metrics: ["revenue"],
        time: { period: "this_week" },
      }).compiled;
      expect(week.sql, type).toMatch(/completed_at/);
      expect(week.trust, type).toBe("governed");

      const dated = kernel.compile({
        metrics: ["revenue"],
        dimensions: ["customer_country"],
        time: { period: "last_month" },
      }).compiled;
      expect(dated.sql, type).toMatch(/completed_at/);
      expect(dated.sql, type).toMatch(/country/);
      expect(dated.trust, type).toBe("governed");
    }
  });
});
