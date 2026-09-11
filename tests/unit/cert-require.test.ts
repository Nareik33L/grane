import { describe, expect, it } from "vitest";
import type { WarehouseType } from "../../src/config/schema.js";
import {
  CI_REQUIRED_CERT_ENGINES,
  loadAvailableEngines,
  parseRequiredCertEngines,
  type CertCapabilities,
  type CertEngine,
} from "../helpers/cert-engine.js";

const caps: CertCapabilities = {
  readOnlyTransaction: false,
  timestamptz: false,
  fkIntrospection: false,
  postgresReadonlyRole: false,
  mutateSeed: false,
  sessionTimezoneLocal: false,
  mcpCli: false,
  filterClause: false,
};

function stub(type: WarehouseType, available: boolean | (() => Promise<boolean>)): CertEngine {
  return {
    type,
    capabilities: caps,
    available: typeof available === "function" ? available : async () => available,
    async setup() {
      throw new Error("setup unused");
    },
  };
}

describe("GRANE_CERT_REQUIRE", () => {
  it("parses a comma list and ignores blanks", () => {
    expect(parseRequiredCertEngines("")).toEqual([]);
    expect(parseRequiredCertEngines("  ")).toEqual([]);
    expect(parseRequiredCertEngines("postgres, duckdb,mysql, clickhouse")).toEqual([
      ...CI_REQUIRED_CERT_ENGINES,
    ]);
    expect(parseRequiredCertEngines("postgres,,mysql")).toEqual(["postgres", "mysql"]);
  });

  it("rejects unknown engine names", () => {
    expect(() => parseRequiredCertEngines("postgres,oracle")).toThrow(/unknown engine "oracle"/);
  });

  it("throws when a required engine is unavailable instead of dropping it", async () => {
    const engines = [stub("postgres", true), stub("mysql", false), stub("duckdb", true)];
    await expect(
      loadAvailableEngines({ engines, require: ["postgres", "mysql", "duckdb"] }),
    ).rejects.toThrow(/unavailable: mysql/);
    await expect(
      loadAvailableEngines({ engines, require: ["postgres", "mysql", "duckdb"] }),
    ).rejects.toThrow(/GRANE_CERT_REQUIRE/);
  });

  it("throws when a required engine probe fails", async () => {
    const engines = [
      stub("postgres", true),
      stub("clickhouse", async () => {
        throw new Error("ECONNREFUSED 127.0.0.1:8123");
      }),
    ];
    await expect(loadAvailableEngines({ engines, require: ["postgres", "clickhouse"] })).rejects.toThrow(
      /clickhouse.*ECONNREFUSED/,
    );
  });

  it("still skips optional engines that are down", async () => {
    const engines = [stub("postgres", true), stub("mysql", false), stub("snowflake", false)];
    const loaded = await loadAvailableEngines({ engines, require: ["postgres"] });
    expect(loaded.map((e) => e.type)).toEqual(["postgres"]);
  });

  it("still skips optional engines whose probe throws", async () => {
    const engines = [
      stub("postgres", true),
      stub("snowflake", async () => {
        throw new Error("no credentials");
      }),
    ];
    const loaded = await loadAvailableEngines({ engines, require: ["postgres"] });
    expect(loaded.map((e) => e.type)).toEqual(["postgres"]);
  });

  it("throws when a required engine is missing from the registry", async () => {
    const engines = [stub("postgres", true)];
    await expect(loadAvailableEngines({ engines, require: ["postgres", "mysql"] })).rejects.toThrow(
      /unavailable: mysql/,
    );
  });

  it("does not require unselected engines when GRANE_CERTIFY_ENGINE is set", async () => {
    const engines = [stub("postgres", true), stub("mysql", false)];
    const loaded = await loadAvailableEngines({
      engines,
      require: ["postgres", "mysql"],
      only: "postgres",
    });
    expect(loaded.map((e) => e.type)).toEqual(["postgres"]);
  });

  it("throws if the selected required engine is unavailable", async () => {
    const engines = [stub("mysql", false), stub("postgres", true)];
    await expect(
      loadAvailableEngines({ engines, require: ["postgres", "mysql"], only: "mysql" }),
    ).rejects.toThrow(/unavailable: mysql/);
  });

  it("CI required list is the four certified engines", () => {
    expect([...CI_REQUIRED_CERT_ENGINES]).toEqual(["postgres", "duckdb", "mysql", "clickhouse"]);
  });
});
