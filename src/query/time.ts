/**
 * Deterministic time resolution.
 *
 * Relative period specs (used by the CLI's --last flag) are resolved to
 * explicit YYYY-MM-DD ranges in the project timezone before compilation, so
 * generated SQL never depends on database session settings.
 */

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

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

export interface DateRange {
  /** Inclusive start date (YYYY-MM-DD). */
  from: string;
  /** Inclusive end date (YYYY-MM-DD). */
  to: string;
}

/**
 * Resolve a relative period spec to an explicit date range.
 *
 * Supported: `<N>d` (N days ending today), `<N>w`, `<N>m` (calendar months
 * ending today), `today`, `yesterday`, `this_month`, `last_month`,
 * `this_year`, `last_year`.
 */
export function resolveRelativeRange(
  spec: string,
  timeZone: string,
  now: Date = new Date(),
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
    default: {
      const match = /^(\d+)(d|w|m)$/.exec(normalized);
      if (!match) {
        throw new Error(
          `Unsupported relative period "${spec}". Use e.g. 30d, 12w, 6m, today, yesterday, this_month, last_month, this_year, last_year.`,
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
