import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";
import {
  CERTIFICATION_STATES,
  WAREHOUSE_CERTIFICATION,
  readmeCertificationLine,
  uncertifiedWarehouseWarning,
  warehouseCertificationMarkdown,
  warehouseServerInfo,
} from "../../src/connectors/certification.js";
import { CI_REQUIRED_CERT_ENGINES } from "../helpers/cert-engine.js";
import { exampleConfig } from "../fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function ciExercisesCertifiedEngine(ci: string, type: WarehouseType): boolean {
  const unit = /npm run test:unit/.test(ci);
  const requireList = /GRANE_CERT_REQUIRE:\s*postgres,duckdb,mysql,clickhouse/.test(ci);
  if (!requireList) return false;
  switch (type) {
    case "postgres":
      return unit && /image:\s*postgres:16\b/.test(ci) && /GRANE_PG_WRITE_URL/.test(ci);
    case "duckdb":
      return unit && /DuckDB is a devDependency/.test(ci);
    case "mysql":
      return (
        unit &&
        /image:\s*mysql:8/.test(ci) &&
        /GRANE_MYSQL_WRITE_URL/.test(ci) &&
        /mysql_tzinfo_to_sql/.test(ci) &&
        /CONVERT_TZ/.test(ci)
      );
    case "clickhouse":
      return (
        unit &&
        /image:\s*clickhouse\/clickhouse-server:24/.test(ci) &&
        /GRANE_CLICKHOUSE_URL/.test(ci) &&
        /join_use_nulls/.test(ci)
      );
    default:
      return false;
  }
}

describe("warehouse certification map", () => {
  it("covers every warehouse type and only those", () => {
    expect(Object.keys(WAREHOUSE_CERTIFICATION).sort()).toEqual([...WAREHOUSE_TYPES].sort());
    expect(CERTIFICATION_STATES).toEqual(["certified", "self_certifiable", "compile_only"]);
  });

  it("marks Postgres, MySQL, DuckDB, and ClickHouse certified; does not overclaim clouds", async () => {
    const certified = WAREHOUSE_TYPES.filter((type) => WAREHOUSE_CERTIFICATION[type].certification === "certified");
    expect(certified).toEqual(["postgres", "mysql", "duckdb", "clickhouse"]);
    expect(WAREHOUSE_CERTIFICATION.postgres.certified_version).toBe("16");
    expect(WAREHOUSE_CERTIFICATION.mysql.certified_version).toBe("8");
    expect(WAREHOUSE_CERTIFICATION.duckdb.certified_version).toBe("1.5");
    expect(WAREHOUSE_CERTIFICATION.clickhouse.certified_version).toBe("24");
    expect(WAREHOUSE_CERTIFICATION.snowflake.certification).not.toBe("certified");
    expect(WAREHOUSE_CERTIFICATION.bigquery.certification).not.toBe("certified");
    expect(WAREHOUSE_CERTIFICATION.redshift.certification).not.toBe("certified");
    expect(WAREHOUSE_CERTIFICATION.databricks.certification).not.toBe("certified");
  });

  it("fails if a certified engine is not exercised in CI", () => {
    const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    expect(ci).toContain(`GRANE_CERT_REQUIRE: ${CI_REQUIRED_CERT_ENGINES.join(",")}`);
    expect([...CI_REQUIRED_CERT_ENGINES]).toEqual(["postgres", "duckdb", "mysql", "clickhouse"]);
    for (const type of WAREHOUSE_TYPES) {
      const entry = WAREHOUSE_CERTIFICATION[type];
      if (entry.certification !== "certified") continue;
      expect(ciExercisesCertifiedEngine(ci, type), `${type} is certified but not exercised in CI`).toBe(true);
      expect(CI_REQUIRED_CERT_ENGINES, `${type} is certified so it must be GRANE_CERT_REQUIRE`).toContain(type);
      if (type === "duckdb") {
        expect(pkg.devDependencies?.["@duckdb/node-api"], "certified DuckDB requires the CI driver").toBeTruthy();
      }
      if (type === "mysql") {
        expect(pkg.devDependencies?.mysql2, "certified MySQL requires mysql2 in CI").toBeTruthy();
        const doctor = readFileSync(join(ROOT, "src/mcp/connect/doctor.ts"), "utf8");
        expect(doctor, "grane mcp doctor must probe MySQL timezone tables").toMatch(/CONVERT_TZ/);
      }
      if (type === "clickhouse") {
        expect(pkg.devDependencies?.["@clickhouse/client"], "certified ClickHouse requires the CI driver").toBeTruthy();
      }
    }
  });

  it("docs/warehouses.md three-state tables match the map", () => {
    const docs = readFileSync(join(ROOT, "docs/warehouses.md"), "utf8");
    expect(docs).toContain(warehouseCertificationMarkdown());
  });

  it("README honest matrix line matches the map", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const line = readmeCertificationLine();
    expect(readme).toContain(line);
    expect(line).toMatch(/PostgreSQL 16/);
    expect(line).toMatch(/MySQL \/ MariaDB 8/);
    expect(line).toMatch(/DuckDB 1\.5/);
    expect(line).toMatch(/ClickHouse 24/);
    expect(line).not.toMatch(/Snowflake.*certified in CI/i);
  });

  it("serverInfo().warehouse matches the map for the configured engine", () => {
    const postgres = new GraneKernel(exampleConfig()).serverInfo();
    expect(postgres.warehouse).toEqual(warehouseServerInfo("postgres"));
    expect(postgres.warehouse).toEqual({
      type: "postgres",
      certification: "certified",
      certified_version: "16",
    });
    const mysql = new GraneKernel(exampleConfig({ connection: { type: "mysql", schema: "shop" } })).serverInfo();
    expect(mysql.warehouse).toEqual({
      type: "mysql",
      certification: "certified",
      certified_version: "8",
    });
    const clickhouse = new GraneKernel(
      exampleConfig({ connection: { type: "clickhouse", url: "http://localhost:8123", schema: "analytics" } }),
    ).serverInfo();
    expect(clickhouse.warehouse).toEqual({
      type: "clickhouse",
      certification: "certified",
      certified_version: "24",
    });
  });

  it("validate --production warning is one line and absent when certified", () => {
    expect(uncertifiedWarehouseWarning("postgres")).toBeNull();
    expect(uncertifiedWarehouseWarning("duckdb")).toBeNull();
    expect(uncertifiedWarehouseWarning("mysql")).toBeNull();
    expect(uncertifiedWarehouseWarning("clickhouse")).toBeNull();
    expect(uncertifiedWarehouseWarning("snowflake")).toMatch(/^snowflake is self_certifiable, not certified\. /);
  });
});
