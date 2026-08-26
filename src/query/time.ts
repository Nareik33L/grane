/**
 * Deterministic time resolution.
 *
 * Relative period specs (used by the CLI's --last flag) are resolved to
 * explicit YYYY-MM-DD ranges in the project timezone before compilation, so
 * generated SQL never depends on database session settings.
 */

import { ambiguousQuery, invalidQuery } from "../errors.js";

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export const MONTH_NUMBERS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Human-readable list of relative periods the kernel can resolve. */
export const SUPPORTED_RELATIVE_PERIODS = [
  "today",
  "yesterday",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
  "this_fiscal_year",
  "last_fiscal_year",
  "<N>d",
  "last_<N>d",
  "<N>w",
  "<N>m",
] as const;

export function todayInTimeZone(timeZone: string, now: Date = new Date()): CalendarDate {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const [year, month, day] = formatter.format(now).split("-").map(Number);
  return { year: year!, month: month!, day: day! };
}

export function formatDate(date: CalendarDate): string {
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${date.year}-${mm}-${dd}`;
}

/** True when `YYYY-MM-DD` is a real civil date (rejects 2023-02-29). */
export function isValidCivilDate(iso: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const year = Number(iso.slice(0, 4));
  const month = Number(iso.slice(5, 7));
  const day = Number(iso.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

export function parseCivilDate(iso: string): CalendarDate {
  if (!isValidCivilDate(iso)) {
    throw invalidQuery(`"${iso}" is not a valid calendar date. Use a real YYYY-MM-DD civil date.`);
  }
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

/** Inclusive civil date → exclusive next-day bound (YYYY-MM-DD). */
export function exclusiveEnd(isoInclusive: string): string {
  return formatDate(addDays(parseCivilDate(isoInclusive), 1));
}

/** Pure calendar-date arithmetic (no timezone involvement). */
export function addDays(date: CalendarDate, days: number): CalendarDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function startOfMonth(date: CalendarDate): CalendarDate {
  return { ...date, day: 1 };
}

function addMonths(date: CalendarDate, months: number): CalendarDate {
  const utc = new Date(Date.UTC(date.year, date.month - 1 + months, date.day));
  return { year: utc.getUTCFullYear(), month: utc.getUTCMonth() + 1, day: utc.getUTCDate() };
}

function compareDates(a: CalendarDate, b: CalendarDate): number {
  return formatDate(a).localeCompare(formatDate(b));
}

function minDate(a: CalendarDate, b: CalendarDate): CalendarDate {
  return compareDates(a, b) <= 0 ? a : b;
}

/** First day of the fiscal year containing `today`. */
export function startOfFiscalYear(today: CalendarDate, startsMonth: number): CalendarDate {
  if (today.month >= startsMonth) {
    return { year: today.year, month: startsMonth, day: 1 };
  }
  return { year: today.year - 1, month: startsMonth, day: 1 };
}

export interface DateRange {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to: string;
}

export interface RelativeRangeOptions {
  /** 1–12. Required for this_fiscal_year / last_fiscal_year. */
  fiscalStartsMonth?: number;
}

/**
 * Resolve a relative period spec to an explicit date range.
 *
 * Supported: `<N>d` (N days ending today), `<N>w`, `<N>m` (calendar months
 * ending today), `today`, `yesterday`, `this_month`, `last_month`,
 * `this_year`, `last_year`, `this_fiscal_year`, `last_fiscal_year`.
 */
export function resolveRelativeRange(
  spec: string,
  timeZone: string,
  now: Date = new Date(),
  options: RelativeRangeOptions = {},
): DateRange {
  const today = todayInTimeZone(timeZone, now);
  const normalized = spec.trim().toLowerCase().replace(/[\s-]+/g, "_");

  switch (normalized) {
    case "today":
      return { from: formatDate(today), to: formatDate(today) };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: formatDate(y), to: formatDate(y) };
    }
    case "this_month":
      return { from: formatDate(startOfMonth(today)), to: formatDate(today) };
    case "last_month": {
      const start = startOfMonth(addMonths(startOfMonth(today), -1));
      const end = addDays(startOfMonth(today), -1);
      return { from: formatDate(start), to: formatDate(end) };
    }
    case "this_year":
      return {
        from: formatDate({ year: today.year, month: 1, day: 1 }),
        to: formatDate(today),
      };
    case "last_year":
      return {
        from: formatDate({ year: today.year - 1, month: 1, day: 1 }),
        to: formatDate({ year: today.year - 1, month: 12, day: 31 }),
      };
    case "this_fiscal_year":
      return resolveThisFiscalYear(today, spec, options.fiscalStartsMonth);
    case "last_fiscal_year":
      return resolveLastFiscalYear(today, spec, options.fiscalStartsMonth);
    case "ytd":
      return resolveYtd(today, options.fiscalStartsMonth);
    case "q1":
      return resolveQ1(today, options.fiscalStartsMonth);
    default: {
      if (/^fy\d{4}$/.test(normalized)) {
        throw ambiguousQuery(
          `"${spec}" is ambiguous: fiscal years can be labelled by the calendar year they start in or the calendar year they end in. Use this_fiscal_year, last_fiscal_year, or an explicit from/to range.`,
          { period: spec },
        );
      }
      const lastN = /^last_(\d+)(d|w|m)$/.exec(normalized);
      const match = lastN ?? /^(\d+)(d|w|m)$/.exec(normalized);
      if (!match) {
        throw invalidQuery(
          `Unsupported relative period "${spec}". Use e.g. ${SUPPORTED_RELATIVE_PERIODS.join(", ")}.`,
          { period: spec, supported: [...SUPPORTED_RELATIVE_PERIODS] },
        );
      }
      const amount = Number(match[1]);
      const unit = match[2]!;
      if (unit === "d") {
        return { from: formatDate(addDays(today, -(amount - 1))), to: formatDate(today) };
      }
      if (unit === "w") {
        return { from: formatDate(addDays(today, -(amount * 7 - 1))), to: formatDate(today) };
      }
      return { from: formatDate(addDays(addMonths(today, -amount), 1)), to: formatDate(today) };
    }
  }
}

function requireFiscalMonth(spec: string, fiscalStartsMonth: number | undefined): number {
  if (fiscalStartsMonth == null || fiscalStartsMonth < 1 || fiscalStartsMonth > 12) {
    throw invalidQuery(
      `"${spec}" requires project.fiscal_year.starts_month in the Grane config.`,
      { period: spec },
    );
  }
  return fiscalStartsMonth;
}

function resolveThisFiscalYear(
  today: CalendarDate,
  spec: string,
  fiscalStartsMonth: number | undefined,
): DateRange {
  const starts = requireFiscalMonth(spec, fiscalStartsMonth);
  return { from: formatDate(startOfFiscalYear(today, starts)), to: formatDate(today) };
}

function resolveLastFiscalYear(
  today: CalendarDate,
  spec: string,
  fiscalStartsMonth: number | undefined,
): DateRange {
  const starts = requireFiscalMonth(spec, fiscalStartsMonth);
  const currentStart = startOfFiscalYear(today, starts);
  const lastStart = addMonths(currentStart, -12);
  const lastEnd = addDays(currentStart, -1);
  return { from: formatDate(lastStart), to: formatDate(lastEnd) };
}

function resolveYtd(today: CalendarDate, fiscalStartsMonth: number | undefined): DateRange {
  if (fiscalStartsMonth != null) {
    throw ambiguousQuery(
      `"ytd" is ambiguous when a fiscal year is configured: calendar year-to-date vs fiscal year-to-date. Use this_year or this_fiscal_year.`,
      { period: "ytd" },
    );
  }
  return {
    from: formatDate({ year: today.year, month: 1, day: 1 }),
    to: formatDate(today),
  };
}

function resolveQ1(today: CalendarDate, fiscalStartsMonth: number | undefined): DateRange {
  if (fiscalStartsMonth != null) {
    throw ambiguousQuery(
      `"q1" is ambiguous when a fiscal year is configured: calendar Q1 vs fiscal Q1. Use an explicit from/to range.`,
      { period: "q1" },
    );
  }
  const start = { year: today.year, month: 1, day: 1 };
  const quarterEnd = { year: today.year, month: 3, day: 31 };
  return { from: formatDate(start), to: formatDate(minDate(today, quarterEnd)) };
}
