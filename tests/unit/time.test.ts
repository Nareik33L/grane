import { describe, expect, it } from "vitest";
import { addDays, formatDate, isValidCivilDate, resolveRelativeRange, startOfFiscalYear, startOfQuarter, startOfWeek, todayInTimeZone } from "../../src/query/time.js";
import { GraneError } from "../../src/errors.js";

// A fixed instant: 2026-08-25T23:30:00Z.
// In Europe/London (UTC+1 in August) this is already 2026-08-26.
const NOW = new Date("2026-08-25T23:30:00Z");
const GAUNTLET_NOW = new Date("2024-03-15T12:00:00.000Z");

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

  it("rejects unsupported specs with a structured invalid_query listing supported periods", () => {
    try {
      resolveRelativeRange("sometime", "UTC", NOW);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toMatch(/Unsupported relative period/);
      expect((err as GraneError).refusal.message).toMatch(/this_fiscal_year/);
    }
  });

  it("resolves last_30d as the last 30 days ending today", () => {
    expect(resolveRelativeRange("last_30d", "UTC", NOW)).toEqual(resolveRelativeRange("30d", "UTC", NOW));
  });

  it("resolves this_fiscal_year from the configured start month through today", () => {
    expect(startOfFiscalYear({ year: 2024, month: 3, day: 15 }, 4)).toEqual({
      year: 2023,
      month: 4,
      day: 1,
    });
    expect(resolveRelativeRange("this_fiscal_year", "Europe/London", GAUNTLET_NOW, { fiscalStartsMonth: 4 })).toEqual({
      from: "2023-04-01",
      to: "2024-03-15",
    });
    expect(resolveRelativeRange("last_fiscal_year", "Europe/London", GAUNTLET_NOW, { fiscalStartsMonth: 4 })).toEqual({
      from: "2022-04-01",
      to: "2023-03-31",
    });
  });

  it("refuses this_fiscal_year when fiscal_year is not configured", () => {
    try {
      resolveRelativeRange("this_fiscal_year", "UTC", NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toMatch(/fiscal_year/);
    }
  });

  it("treats ytd and q1 as ambiguous when a fiscal year is configured", () => {
    try {
      resolveRelativeRange("ytd", "Europe/London", GAUNTLET_NOW, { fiscalStartsMonth: 4 });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("ambiguous_query");
    }
    try {
      resolveRelativeRange("q1", "Europe/London", GAUNTLET_NOW, { fiscalStartsMonth: 4 });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("ambiguous_query");
    }
    try {
      resolveRelativeRange("fy2024", "UTC", NOW);
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("ambiguous_query");
    }
  });

  it("resolves ytd as calendar year-to-date when no fiscal year is configured", () => {
    expect(resolveRelativeRange("ytd", "UTC", NOW)).toEqual({
      from: "2026-01-01",
      to: "2026-08-25",
    });
  });

  it("resolves calendar weeks from project.week.starts", () => {
    expect(startOfWeek({ year: 2024, month: 3, day: 15 }, "monday")).toEqual({
      year: 2024,
      month: 3,
      day: 11,
    });
    expect(startOfWeek({ year: 2024, month: 3, day: 15 }, "sunday")).toEqual({
      year: 2024,
      month: 3,
      day: 10,
    });
    expect(resolveRelativeRange("this_week", "Europe/London", GAUNTLET_NOW, { weekStarts: "monday" })).toEqual({
      from: "2024-03-11",
      to: "2024-03-15",
    });
    expect(resolveRelativeRange("this_week", "Europe/London", GAUNTLET_NOW, { weekStarts: "sunday" })).toEqual({
      from: "2024-03-10",
      to: "2024-03-15",
    });
    expect(resolveRelativeRange("last_week", "Europe/London", GAUNTLET_NOW, { weekStarts: "monday" })).toEqual({
      from: "2024-03-04",
      to: "2024-03-10",
    });
    expect(resolveRelativeRange("last_week", "Europe/London", GAUNTLET_NOW, { weekStarts: "sunday" })).toEqual({
      from: "2024-03-03",
      to: "2024-03-09",
    });
  });

  it("resolves unambiguous calendar quarters without touching q1", () => {
    expect(startOfQuarter({ year: 2024, month: 3, day: 15 })).toEqual({ year: 2024, month: 1, day: 1 });
    expect(resolveRelativeRange("this_quarter", "Europe/London", GAUNTLET_NOW)).toEqual({
      from: "2024-01-01",
      to: "2024-03-15",
    });
    expect(resolveRelativeRange("last_quarter", "Europe/London", GAUNTLET_NOW)).toEqual({
      from: "2023-10-01",
      to: "2023-12-31",
    });
  });

  it("rejects non-existent civil dates", () => {
    expect(isValidCivilDate("2024-02-29")).toBe(true);
    expect(isValidCivilDate("2023-02-29")).toBe(false);
    expect(isValidCivilDate("2024-13-01")).toBe(false);
    expect(formatDate(addDays({ year: 2024, month: 2, day: 28 }, 1))).toBe("2024-02-29");
  });
});

