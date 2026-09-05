import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildCliQuery } from "../../src/cli/args.js";

const execFileAsync = promisify(execFile);
const cli = join(dirname(fileURLToPath(import.meta.url)), "../../src/cli/index.ts");

describe("CLI Query Model mapping", () => {
  it("maps --time-dimension onto time.dimension with --last", () => {
    expect(
      buildCliQuery(["revenue"], {
        last: "last_month",
        grain: "month",
        timeDimension: "orders.updated_at",
      }),
    ).toEqual({
      metrics: ["revenue"],
      time: { period: "last_month", grain: "month", dimension: "orders.updated_at" },
    });
  });

  it("maps --time-dimension onto time.dimension with --from/--to", () => {
    expect(
      buildCliQuery(["revenue", "orders"], {
        dimension: ["country"],
        from: "2026-08-01",
        to: "2026-08-31",
        timeDimension: "ordered_at",
      }),
    ).toEqual({
      metrics: ["revenue", "orders"],
      dimensions: ["country"],
      time: { from: "2026-08-01", to: "2026-08-31", dimension: "ordered_at" },
    });
  });

  it("requires a time range before --time-dimension, matching --grain", () => {
    expect(() => buildCliQuery(["revenue"], { timeDimension: "orders.ordered_at" })).toThrow(
      /--time-dimension requires --last or --from\/--to/,
    );
    expect(() => buildCliQuery(["revenue"], { grain: "day" })).toThrow(/--grain requires --last or --from\/--to/);
  });

  it("advertises --time-dimension on grane query --help", async () => {
    const out = await execFileAsync("npx", ["tsx", cli, "query", "--help"], { timeout: 20000 });
    expect(out.stdout).toMatch(/--time-dimension/);
    expect(out.stdout).toMatch(/time\.dimension/);
  });
});
