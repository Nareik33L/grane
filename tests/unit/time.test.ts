import { describe, expect, it } from "vitest";
import { resolveRelativeRange, todayInTimeZone } from "../../src/query/time.js";

// A fixed instant: 2026-08-25T23:30:00Z.
// In Europe/London (UTC+1 in August) this is already 2026-08-26.
const NOW = new Date("2026-08-25T23:30:00Z");

describe("deterministic time resolution", () => {
  it("resolves today per project timezone, not server timezone", () => {
    expect(todayInTimeZone("UTC", NOW)).toEqual({ year: 2026, month: 8, day: 25 });
    expect(todayInTimeZone("Europe/London", NOW)).toEqual({ year: 2026, month: 8, day: 26 });
  });

  it("resolves Nd as the N days ending today (inclusive)", () => {
    expect(resolveRelativeRange("30d", "UTC", NOW)).toEqual({
      from: "2026-07-27",
      to: "2026-08-25",
    });
    expect(resolveRelativeRange("1d", "UTC", NOW)).toEqual({
      from: "2026-08-25",
      to: "2026-08-25",
    });
  });

  it("resolves last_month as the previous calendar month", () => {
    expect(resolveRelativeRange("last_month", "UTC", NOW)).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
    // "last month" (with a space) normalises too.
    expect(resolveRelativeRange("last month", "UTC", NOW)).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("resolves calendar keywords", () => {
    expect(resolveRelativeRange("this_month", "UTC", NOW)).toEqual({
      from: "2026-08-01",
      to: "2026-08-25",
    });
    expect(resolveRelativeRange("yesterday", "UTC", NOW)).toEqual({
      from: "2026-08-24",
      to: "2026-08-24",
    });
    expect(resolveRelativeRange("last_year", "UTC", NOW)).toEqual({
      from: "2025-01-01",
      to: "2025-12-31",
    });
  });

  it("rejects unsupported specs", () => {
    expect(() => resolveRelativeRange("sometime", "UTC", NOW)).toThrow(/Unsupported/);
  });

  it("resolves last_30d as the last 30 days ending today", () => {
    expect(resolveRelativeRange("last_30d", "UTC", NOW)).toEqual({
      from: "2026-07-27",
      to: "2026-08-25",
    });
  });
});
