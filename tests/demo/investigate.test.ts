import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { demoAnalyticsDir } from "../../src/demo/paths.js";
import { buildDemoWarehouse, duckdbDriverAvailable } from "../../src/demo/warehouse.js";
import { runInvestigation } from "../../src/demo/investigate.js";

const available = await duckdbDriverAvailable();

describe.skipIf(!available)("demo investigation", () => {
  let kernel: GraneKernel;

  afterAll(async () => {
    await kernel?.close();
  });

  it("shows a last-month revenue drop led by Germany and CARD_AUTH_FAILED", async () => {
    const { path } = await buildDemoWarehouse();
    const loaded = loadConfig(demoAnalyticsDir());
    loaded.config.connection = { type: "duckdb", path, schema: "main" };
    kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir });

    const result = await runInvestigation(kernel);
    expect(result.revenueLast).toBeCloseTo(184230, 0);
    expect(result.revenueChangePct).toBeCloseTo(-14.3, 1);

    const germany = result.byCountry.find((row) => row.country === "Germany");
    const uk = result.byCountry.find((row) => row.country === "UK");
    const us = result.byCountry.find((row) => row.country === "US");
    expect(germany?.changePct).toBeCloseTo(-39, 0);
    expect(uk?.changePct).toBeCloseTo(-3, 0);
    expect(us?.changePct).toBeCloseTo(2, 0);

    const auth = result.failures.find((row) => row.code === "CARD_AUTH_FAILED");
    expect(auth).toBeTruthy();
    expect(auth!.changePct).toBeGreaterThan(200);
    expect(result.failures[0]?.code).toBe("CARD_AUTH_FAILED");
    expect(result.transcript).toContain("trust: governed");
    expect(result.transcript).toContain("exploratory");
  });
});
