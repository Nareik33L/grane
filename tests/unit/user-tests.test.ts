import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import { getDialect } from "../../src/connectors/dialect.js";
import type { WarehouseConnector } from "../../src/connectors/types.js";
import {
  expectedDisposition,
  loadUserTestCases,
  parseUserTestDocument,
  runUserTests,
} from "../../src/cli/user-tests.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function stubConnector(): WarehouseConnector {
  return {
    type: "postgres",
    dialect: getDialect("postgres"),
    async query() {
      return { columns: ["revenue"], rows: [{ revenue: 184230 }] };
    },
    async introspect() {
      return { schemaName: "public", tables: [], foreignKeys: [] };
    },
    async close() {},
  };
}

describe("user YAML scenarios", () => {
  it("parses gauntlet-like execute / refuse / gold shapes", () => {
    const scenarios = parseUserTestDocument(
      {
        scenarios: [
          {
            id: "revenue",
            query: { metrics: ["revenue"] },
            disposition: "EXECUTE",
            expectation: { trust: "governed", gold: 184230 },
          },
          {
            id: "missing",
            query: { metrics: ["nope"] },
            expectation: { kind: "refuse", statuses: ["undefined_metric"] },
          },
        ],
      },
      "suite.yml",
    );
    expect(scenarios).toHaveLength(2);
    expect(expectedDisposition(scenarios[0]!)).toBe("execute");
    expect(expectedDisposition(scenarios[1]!)).toBe("refuse");
  });

  it("runs execute gold and refuse status against the kernel", async () => {
    const kernel = new GraneKernel(exampleConfig(), { connector: stubConnector() });
    const report = await runUserTests(kernel, [
      {
        file: "mem.yml",
        scenario: parseUserTestDocument(
          {
            id: "revenue",
            query: { metrics: ["revenue"] },
            disposition: "execute",
            expectation: { trust: "governed", gold: { kind: "scalar", value: 184230 } },
          },
          "mem.yml",
        )[0]!,
      },
      {
        file: "mem.yml",
        scenario: parseUserTestDocument(
          {
            id: "missing",
            query: { metrics: ["not_a_metric"] },
            disposition: "refuse",
            expectation: { status: "undefined_metric" },
          },
          "mem.yml",
        )[0]!,
      },
    ]);
    expect(report.ok).toBe(true);
    expect(report.passed).toBe(2);
  });

  it("fails when an execute scenario is refused", async () => {
    const kernel = new GraneKernel(exampleConfig(), { connector: stubConnector() });
    const report = await runUserTests(kernel, [
      {
        file: "mem.yml",
        scenario: parseUserTestDocument(
          { id: "oops", query: { metrics: ["not_a_metric"] }, disposition: "execute" },
          "mem.yml",
        )[0]!,
      },
    ]);
    expect(report.ok).toBe(false);
    expect(report.results[0]?.status).toBe("undefined_metric");
  });

  it("loads a YAML file of scenarios", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-user-tests-"));
    dirs.push(dir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "suite.yml"),
      `
scenarios:
  - id: revenue
    query:
      metrics: [revenue]
    disposition: execute
    expectation:
      trust: governed
      gold: 184230
`,
    );
    const cases = loadUserTestCases([dir]);
    expect(cases).toHaveLength(1);
    expect(cases[0]?.scenario.id).toBe("revenue");
  });
});
