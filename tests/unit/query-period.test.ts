import { describe, expect, it } from "vitest";
import { GraneKernel } from "../../src/kernel.js";
import { GraneError } from "../../src/errors.js";
import { exampleConfig } from "../fixtures.js";
import { resolveRelativeRange } from "../../src/query/time.js";

const NOW = new Date("2026-08-25T23:30:00Z");
const kernel = new GraneKernel(exampleConfig(), { now: NOW });

describe("Query Model time.period", () => {
  it("resolves last_month in the project timezone", () => {
    const { compiled, resolved } = kernel.compile({
      metrics: ["revenue"],
      time: { period: "last_month" },
    });
    expect(resolved.time?.from).toBe("2026-07-01");
    expect(resolved.time?.to).toBe("2026-07-31");
    expect(resolved.notes.some((n) => n.includes("last_month") && n.includes("2026-07-01"))).toBe(true);
    expect(compiled.params).toEqual(["completed", "2026-07-01", "2026-08-01"]);
  });

  it("accepts last_30d as an alias of 30d", () => {
    expect(resolveRelativeRange("last_30d", "UTC", NOW)).toEqual(resolveRelativeRange("30d", "UTC", NOW));
    const { resolved } = kernel.compile({
      metrics: ["revenue"],
      time: { period: "last_30d", grain: "day" },
    });
    expect(resolved.time?.from).toBe("2026-07-27");
    expect(resolved.time?.to).toBe("2026-08-25");
    expect(resolved.time?.grain).toBe("day");
  });

  it("refuses combining period with from/to", () => {
    try {
      kernel.compile({
        metrics: ["revenue"],
        time: { period: "last_month", from: "2026-07-01", to: "2026-07-31" },
      });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toMatch(/period cannot be combined/);
    }
  });
});
