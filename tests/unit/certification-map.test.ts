import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { WAREHOUSE_TYPES, type WarehouseType } from "../../src/connectors/dialect.js";
import {
  CERTIFICATION_CATEGORY,
  CERTIFICATION_STATES,
  README_MARIADB_NOTE,
  WAREHOUSE_CERTIFICATION,
  readmeCertificationLine,
  readmeCertificationMatrix,
  readmeWarehouseStatus,
  uncertifiedWarehouseWarning,
  warehouseCertificationMarkdown,
  warehouseServerInfo,
  type WarehouseCertification,
} from "../../src/connectors/certification.js";
import { CLOUD_CERT_ENGINES } from "../../src/certify/env.js";
import { CI_REQUIRED_CERT_ENGINES } from "../helpers/cert-engine.js";
import { exampleConfig } from "../fixtures.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

function documentationMarkdown(): Array<{ rel: string; text: string }> {
  const files = [
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "certification/README.md",
    ...readdirSync(join(ROOT, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  return files.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
}

/** README, docs/, and CONTRIBUTING — the P2 prose-honesty scan set. */
function honestyMarkdown(): Array<{ rel: string; text: string }> {
  const files = [
    "README.md",
    "CONTRIBUTING.md",
    ...readdirSync(join(ROOT, "docs"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => `docs/${name}`),
  ];
  return files.map((rel) => ({ rel, text: readFileSync(join(ROOT, rel), "utf8") }));
}

function engineAliases(entry: WarehouseCertification): string[] {
  const names = [entry.label, entry.type];
  if (entry.type === "postgres") names.push("Postgres", "PostgreSQL");
  if (entry.type === "redshift") names.push("Redshift");
  return [...new Set(names)];
}

function lineMentionsEngine(line: string, entry: WarehouseCertification): boolean {
  return engineAliases(entry).some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(line);
  });
}

/**
 * Pairing an uncertified engine with any of these is an over-claim unless the
 * line also denies it.
 */
const OVERCLAIM_PHRASE =
  /production[-\s]ready|fully\s+support(?:s|ed)?|supports\b.{0,80}\bin production\b|battle-tested|\bcertified\b/i;

function normalizeProse(line: string): string {
  return line.replace(/\*+/g, "");
}

function lineHasOverclaimPhrase(line: string): boolean {
  return OVERCLAIM_PHRASE.test(normalizeProse(line));
}

/** Lines that mention a claim only to deny it, or to say self_certifiable. */
function lineDeniesCertification(line: string): boolean {
  return /self_certifiable|self-certify|not\s+CI-certified|not(?:\s+\w+){0,3}\s+certified|not\s+CI certified|remain `?self_certifiable|stay `?self_certifiable|does(?:\s+not|n['’]?t)\s+cover|never\s+.*certified|not flipped to|without CI evidence|pending (?:release|dispatch)|skips?(?: cleanly)? without|skip unless|skips unless|do not (?:write|call|claim).*certified|must not include|runtime-certified|compile-supported|not yet certified|not yet runtime-certified|not\s+runtime-certified|not yet tested|isn['’]?t|aren['’]?t|not\s+production[-\s]ready|not\s+fully\s+support|not\s+battle-tested/i.test(
    normalizeProse(line),
  );
}

type UncertifiedSubject = { label: string; aliases: string[] };

function uncertifiedSubjects(): UncertifiedSubject[] {
  const clouds = CLOUD_CERT_ENGINES.map((type) => ({
    label: WAREHOUSE_CERTIFICATION[type].label,
    aliases: engineAliases(WAREHOUSE_CERTIFICATION[type]),
  }));
  return [...clouds, { label: "MariaDB", aliases: ["MariaDB"] }];
}

function lineMentionsAliases(line: string, aliases: string[]): boolean {
  return aliases.some((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "i").test(line);
  });
}

function lineOverclaimsUncertified(line: string, aliases: string[]): boolean {
  const text = normalizeProse(line);
  if (!lineMentionsAliases(text, aliases)) return false;
  if (!lineHasOverclaimPhrase(text)) return false;
  if (lineDeniesCertification(text)) return false;
  return true;
}

function collectProseOverclaims(files: Array<{ rel: string; text: string }>): string[] {
  const overclaims: string[] = [];
  for (const { rel, text } of files) {
    for (const subject of uncertifiedSubjects()) {
      for (const [i, line] of text.split("\n").entries()) {
        if (!lineOverclaimsUncertified(line, subject.aliases)) continue;
        overclaims.push(`${rel}:${i + 1} overclaims ${subject.label}: ${line.trim()}`);
      }
    }
  }
  return overclaims;
}

/** README matrix rows: | Warehouse | `type` | Status |. */
function parseReadmeWarehouseMatrix(readme: string): Array<{
  warehouse: string;
  type: string;
  status: string;
  line: number;
}> {
  const rows: Array<{ warehouse: string; type: string; status: string; line: number }> = [];
  const re = /^\|\s*(.+?)\s*\|\s*`([a-z]+)`\s*\|\s*(.+?)\s*\|$/;
  for (const [i, line] of readme.split("\n").entries()) {
    const match = re.exec(line);
    if (!match) continue;
    const type = match[2]!;
    if (!WAREHOUSE_TYPES.includes(type as WarehouseType)) continue;
    if (match[1]!.includes("connection.type") || match[3] === "---") continue;
    rows.push({ warehouse: match[1]!.trim(), type, status: match[3]!.trim(), line: i + 1 });
  }
  return rows;
}

function statusClaimsCertified(status: string): boolean {
  return /\bcertified\b/i.test(status) && !lineDeniesCertification(status);
}

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
    expect(WAREHOUSE_CERTIFICATION.mysql.label).toBe("MySQL");
    expect(WAREHOUSE_CERTIFICATION.mysql.label).not.toMatch(/MariaDB/i);
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
    expect(docs).not.toMatch(/MariaDB \| `mysql` \| `certified`/);
  });

  it("README honest matrix line matches the map", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const line = readmeCertificationLine();
    const matrix = readmeCertificationMatrix();
    expect(readme).toContain(line);
    expect(readme).toContain(matrix);
    expect(readme).toContain(README_MARIADB_NOTE);
    expect(line).toMatch(/PostgreSQL 16/);
    expect(line).toMatch(/MySQL 8/);
    expect(line).not.toMatch(/MariaDB/);
    expect(WAREHOUSE_CERTIFICATION.mysql.label).toBe("MySQL");
    expect(line).toMatch(/DuckDB 1\.5/);
    expect(line).toMatch(/ClickHouse 24/);
    expect(line).not.toMatch(/Snowflake/i);
    for (const type of CLOUD_CERT_ENGINES) {
      const entry = WAREHOUSE_CERTIFICATION[type];
      expect(matrix).toContain(`| ${entry.label} | \`${type}\` | ${readmeWarehouseStatus(entry)} |`);
      expect(readmeWarehouseStatus(entry)).toMatch(/not yet tested \/ not certified/i);
    }
  });

  it("fails if the README matrix lists an engine as certified that the cert map does not", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toContain(readmeCertificationMatrix());
    const rows = parseReadmeWarehouseMatrix(readme);
    expect(rows.map((row) => row.type).sort()).toEqual([...WAREHOUSE_TYPES].sort());

    const overclaims: string[] = [];
    for (const row of rows) {
      const type = row.type as WarehouseType;
      const entry = WAREHOUSE_CERTIFICATION[type];
      if (statusClaimsCertified(row.status) && entry.certification !== "certified") {
        overclaims.push(
          `README.md:${row.line} lists ${entry.label} as certified but the cert map says ${entry.certification}: ${row.status}`,
        );
      }
      if (entry.certification !== "certified") {
        expect(row.status, `${type} README status must not claim certified`).toBe(readmeWarehouseStatus(entry));
        expect(statusClaimsCertified(row.status), `${type} status overclaims certified`).toBe(false);
      } else {
        expect(row.status).toBe("Certified");
      }
    }
    expect(overclaims, overclaims.join("\n")).toEqual([]);

    for (const [i, line] of readme.split("\n").entries()) {
      if (!/MariaDB/i.test(line)) continue;
      expect(lineDeniesCertification(line), `README.md:${i + 1} must not list MariaDB as certified: ${line.trim()}`).toBe(
        true,
      );
    }

    const fakeOverclaim = "| Snowflake | `snowflake` | Certified |\n";
    const fakeRows = parseReadmeWarehouseMatrix(fakeOverclaim);
    expect(fakeRows).toHaveLength(1);
    expect(statusClaimsCertified(fakeRows[0]!.status)).toBe(true);
    expect(WAREHOUSE_CERTIFICATION.snowflake.certification).not.toBe("certified");
  });

  it("README states BYO warehouse, no hosted version, and no spreadsheets", () => {
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/own read-only data access/i);
    expect(readme).toMatch(/no hosted version/i);
    expect(readme).toMatch(/CSV/);
    expect(readme).toMatch(/Excel/);
    expect(readme).toMatch(/Google Sheets/);
    expect(readme).toMatch(/not supported/i);
    expect(readme).toMatch(/not a spreadsheet/i);
    expect(readme).not.toMatch(/team guide coming/i);
    if (existsSync(join(ROOT, "docs/team-setup.md"))) {
      expect(readme).toMatch(/docs\/team-setup\.md/);
    } else {
      expect(readme).toMatch(/docs\/two-person-test\.md/);
    }
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

  it("docs and README never call a cloud warehouse certified before certify-cloud has passed", () => {
    const wf = readFileSync(join(ROOT, ".github/workflows/certify-cloud.yml"), "utf8");
    expect(wf).toMatch(/Jobs skip when GRANE_CERT_\* secrets are absent/);
    expect(wf).toMatch(/[Dd]ormant/);
    for (const type of CLOUD_CERT_ENGINES) {
      expect(
        WAREHOUSE_CERTIFICATION[type].certification,
        `${type}: map cannot say certified until a credentialed certify-cloud run has actually passed`,
      ).toBe("self_certifiable");
      expect(WAREHOUSE_CERTIFICATION[type].certified_version).toBeNull();
    }

    const overclaims: string[] = [];
    for (const { rel, text } of documentationMarkdown()) {
      for (const type of WAREHOUSE_TYPES) {
        const entry = WAREHOUSE_CERTIFICATION[type];
        if (entry.certification === "certified") continue;
        for (const [i, line] of text.split("\n").entries()) {
          if (!lineMentionsEngine(line, entry)) continue;
          if (!/\bcertified\b/i.test(line)) continue;
          if (lineDeniesCertification(line)) continue;
          overclaims.push(`${rel}:${i + 1} claims ${entry.label} is certified: ${line.trim()}`);
        }
      }
    }
    expect(overclaims, overclaims.join("\n")).toEqual([]);
  });

  it("docs never call uncertified engines production-ready, fully supported, or certified", () => {
    expect(collectProseOverclaims(honestyMarkdown()), collectProseOverclaims(honestyMarkdown()).join("\n")).toEqual([]);
  });

  it("fails on production-ready Snowflake and fully-supports BigQuery in production", () => {
    const snowflake = engineAliases(WAREHOUSE_CERTIFICATION.snowflake);
    const bigquery = engineAliases(WAREHOUSE_CERTIFICATION.bigquery);
    const mariadb = ["MariaDB"];
    expect(lineOverclaimsUncertified("Grane is production-ready on Snowflake.", snowflake)).toBe(true);
    expect(lineOverclaimsUncertified("Grane fully supports BigQuery in production.", bigquery)).toBe(true);
    expect(lineOverclaimsUncertified("Grane is production-ready on MariaDB.", mariadb)).toBe(true);
    expect(lineOverclaimsUncertified("Databricks is battle-tested.", engineAliases(WAREHOUSE_CERTIFICATION.databricks))).toBe(
      true,
    );
    expect(lineOverclaimsUncertified("Redshift is fully supported.", engineAliases(WAREHOUSE_CERTIFICATION.redshift))).toBe(
      true,
    );
    expect(lineOverclaimsUncertified("Snowflake is not production-ready.", snowflake)).toBe(false);
    expect(lineOverclaimsUncertified("Grane isn't production-ready on Snowflake.", snowflake)).toBe(false);
    expect(lineOverclaimsUncertified("BigQuery aren't certified.", bigquery)).toBe(false);
    expect(lineOverclaimsUncertified("MariaDB isn't fully supported.", mariadb)).toBe(false);
  });

  it("every warehouse state table in docs/README matches the certified matrix", () => {
    const row =
      /\|\s*([^|]+?)\s*\|\s*`([a-z]+)`\s*\|\s*`(certified|self_certifiable|compile_only)`\s*\|/g;
    for (const { rel, text } of documentationMarkdown()) {
      for (const match of text.matchAll(row)) {
        const type = match[2] as WarehouseType;
        const state = match[3]!;
        expect(WAREHOUSE_TYPES, `${rel}: unknown warehouse ${type}`).toContain(type);
        expect(state, `${rel}: ${type} state drifted from WAREHOUSE_CERTIFICATION`).toBe(
          WAREHOUSE_CERTIFICATION[type]!.certification,
        );
      }
    }
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const line = readmeCertificationLine();
    const matrix = readmeCertificationMatrix();
    expect(readme).toContain(line);
    expect(readme).toContain(matrix);
    for (const type of CLOUD_CERT_ENGINES) {
      expect(line, `README certified list must not include ${type}`).not.toMatch(
        new RegExp(WAREHOUSE_CERTIFICATION[type].label, "i"),
      );
      expect(statusClaimsCertified(readmeWarehouseStatus(WAREHOUSE_CERTIFICATION[type]))).toBe(false);
    }
  });

  it("docs separate runtime-certified, compile-supported, and not yet certified", () => {
    for (const { rel, text } of documentationMarkdown()) {
      if (!rel.startsWith("docs/") && rel !== "README.md" && rel !== "CHANGELOG.md") continue;
      if (rel === "docs/connect-an-agent.md" || rel === "docs/mcp-setup.md") continue;
    }
    const warehouses = readFileSync(join(ROOT, "docs/warehouses.md"), "utf8");
    const authoring = readFileSync(join(ROOT, "docs/v2-authoring.md"), "utf8");
    const checklist = readFileSync(join(ROOT, "docs/release-checklist.md"), "utf8");
    for (const text of [warehouses, authoring, checklist]) {
      expect(text).toMatch(/runtime-certified/);
      expect(text).toMatch(/compile-supported/);
      expect(text).toMatch(/not yet certified/);
    }
    expect(CERTIFICATION_CATEGORY.certified).toBe("runtime-certified");
    expect(CERTIFICATION_CATEGORY.self_certifiable).toBe("compile-supported");
    expect(CERTIFICATION_CATEGORY.compile_only).toBe("not yet certified");
    const runtimeSection = (warehouses.split("### Runtime-certified")[1] ?? "").split("###")[0] ?? "";
    for (const type of CLOUD_CERT_ENGINES) {
      expect(WAREHOUSE_CERTIFICATION[type].certification).not.toBe("certified");
      expect(CERTIFICATION_CATEGORY[WAREHOUSE_CERTIFICATION[type].certification]).not.toBe("runtime-certified");
      expect(runtimeSection, `${type} listed under runtime-certified`).not.toMatch(
        new RegExp(WAREHOUSE_CERTIFICATION[type].label, "i"),
      );
    }
    expect(checklist).toMatch(/Credentialed `certify-cloud`/);
    expect(checklist).toMatch(/QA independent RC/);
    expect(checklist).toMatch(/npm publish/);
    expect(checklist).toMatch(/Do not (run|attempt)/);
  });

  it("validate --production warning is one line and absent when certified", () => {
    expect(uncertifiedWarehouseWarning("postgres")).toBeNull();
    expect(uncertifiedWarehouseWarning("duckdb")).toBeNull();
    expect(uncertifiedWarehouseWarning("mysql")).toBeNull();
    expect(uncertifiedWarehouseWarning("clickhouse")).toBeNull();
    expect(uncertifiedWarehouseWarning("snowflake")).toMatch(/^snowflake is self_certifiable, not certified\. /);
  });
});
