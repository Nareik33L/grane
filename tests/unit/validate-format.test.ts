import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeInitProject } from "../../src/cli/init-project.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { formatValidateReport } from "../../src/validate/format.js";

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("formatValidateReport", () => {
  it("matches main's grane validate --offline output for a zero-metric init project", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-validate-golden-"));
    temps.push(dir);
    writeInitProject(dir);
    const loaded = loadConfig(dir, {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://ro@localhost/app" },
    });
    const kernel = new GraneKernel(loaded.config, {
      projectDir: loaded.projectDir,
      providerWarnings: loaded.warnings,
    });
    try {
      const report = kernel.validate();
      const body = `${formatValidateReport(report, {
        providers: kernel.serverInfo().semantic_providers,
        providerWarnings: kernel.providerWarnings,
        schemaLive: false,
      }).join("\n")}\n`;
      const golden = readFileSync(
        join("tests/unit/fixtures/validate-zero-metrics-offline.golden.txt"),
        "utf8",
      );
      expect(body).toBe(golden);
    } finally {
      await kernel.close();
    }
  });

  it("matches main's grane validate --offline output for zero metrics plus a non-metric issue", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-validate-golden-"));
    temps.push(dir);
    writeInitProject(dir);
    writeFileSync(
      join(dir, "dimensions.yml"),
      `dimensions:
  country:
    entity: order
    sql: "\${orders.country}"
`,
    );
    const loaded = loadConfig(dir, {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL ?? "postgres://ro@localhost/app" },
    });
    const kernel = new GraneKernel(loaded.config, {
      projectDir: loaded.projectDir,
      providerWarnings: loaded.warnings,
    });
    try {
      const report = kernel.validate();
      expect(report.ok).toBe(false);
      expect(report.metrics).toEqual([]);
      expect(report.issues.some((issue) => issue.subject === "dimension:country")).toBe(true);
      const body = `${formatValidateReport(report, {
        providers: kernel.serverInfo().semantic_providers,
        providerWarnings: kernel.providerWarnings,
        schemaLive: false,
      }).join("\n")}\n`;
      const golden = readFileSync(
        join("tests/unit/fixtures/validate-zero-metrics-nonmetric-issue.golden.txt"),
        "utf8",
      );
      expect(body).toBe(golden);
    } finally {
      await kernel.close();
    }
  });
});
