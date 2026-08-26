import type { GraneKernel } from "../kernel.js";
import type { QueryResult } from "../execute/executor.js";
import { trustHeadline } from "../query/trust.js";
import {
  addDays,
  addMonths,
  formatDate,
  resolveRelativeRange,
  startOfMonth,
  type DateRange,
} from "../query/time.js";

export interface PeriodPair {
  last: DateRange;
  previous: DateRange;
}

export interface Investigation {
  periods: PeriodPair;
  revenueLast: number;
  revenuePrevious: number;
  revenueChangePct: number;
  byCountry: { country: string; last: number; previous: number; changePct: number }[];
  failures: { code: string; last: number; previous: number; changePct: number }[];
  transcript: string;
}

function money(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function gbp(value: number): string {
  const abs = Math.abs(value);
  const formatted = abs.toLocaleString("en-GB", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
  return `£${formatted}`;
}

function pct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function changePct(last: number, previous: number): number {
  if (previous === 0) return last === 0 ? 0 : 100;
  return (100 * (last - previous)) / previous;
}

function parseDate(iso: string): { year: number; month: number; day: number } {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

export function previousMonth(last: DateRange): DateRange {
  const start = startOfMonth(addMonths(startOfMonth(parseDate(last.from)), -1));
  const end = addDays(startOfMonth(parseDate(last.from)), -1);
  return { from: formatDate(start), to: formatDate(end) };
}

export function demoPeriods(now: Date, timeZone = "UTC"): PeriodPair {
  const last = resolveRelativeRange("last_month", timeZone, now);
  return { last, previous: previousMonth(last) };
}

function scalar(result: QueryResult, column = "revenue"): number {
  return money(result.rows[0]?.[column]);
}

function byKey(result: QueryResult, key: string, value: string): Map<string, number> {
  const map = new Map<string, number>();
  for (const row of result.rows) {
    const name = String(row[key] ?? "");
    if (!name || name === "null") continue;
    map.set(name, money(row[value]));
  }
  return map;
}

export async function runInvestigation(
  kernel: GraneKernel,
  now: Date = new Date(),
): Promise<Investigation> {
  const timeZone = kernel.config.project.timezone || "UTC";
  const periods = demoPeriods(now, timeZone);
  const { last, previous } = periods;

  const [revLast, revPrev, countryLast, countryPrev, failLast, failPrev] = await Promise.all([
    kernel.query({ metrics: ["revenue"], time: { from: last.from, to: last.to } }),
    kernel.query({ metrics: ["revenue"], time: { from: previous.from, to: previous.to } }),
    kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: last.from, to: last.to },
    }),
    kernel.query({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: previous.from, to: previous.to },
    }),
    kernel.query({
      raw_metrics: [{ field: "payments.id", type: "count", alias: "failures" }],
      raw_dimensions: ["payments.failure_code"],
      filters: [
        { field: "country", operator: "=", value: "Germany" },
        { field: "payments.status", operator: "=", value: "failed" },
      ],
      time: { dimension: "payments.paid_at", from: last.from, to: last.to },
    }),
    kernel.query({
      raw_metrics: [{ field: "payments.id", type: "count", alias: "failures" }],
      raw_dimensions: ["payments.failure_code"],
      filters: [
        { field: "country", operator: "=", value: "Germany" },
        { field: "payments.status", operator: "=", value: "failed" },
      ],
      time: { dimension: "payments.paid_at", from: previous.from, to: previous.to },
    }),
  ]);

  const revenueLast = scalar(revLast);
  const revenuePrevious = scalar(revPrev);
  const revenueChangePct = changePct(revenueLast, revenuePrevious);

  const lastByCountry = byKey(countryLast, "country", "revenue");
  const prevByCountry = byKey(countryPrev, "country", "revenue");
  const countries = [...new Set([...lastByCountry.keys(), ...prevByCountry.keys()])];
  const byCountry = countries
    .map((country) => {
      const lastValue = lastByCountry.get(country) ?? 0;
      const previousValue = prevByCountry.get(country) ?? 0;
      return {
        country,
        last: lastValue,
        previous: previousValue,
        changePct: changePct(lastValue, previousValue),
      };
    })
    .sort((a, b) => a.changePct - b.changePct);

  const lastFail = byKey(failLast, "payments.failure_code", "failures");
  const prevFail = byKey(failPrev, "payments.failure_code", "failures");
  const codes = [...new Set([...lastFail.keys(), ...prevFail.keys()])];
  const failures = codes
    .map((code) => {
      const lastValue = lastFail.get(code) ?? 0;
      const previousValue = prevFail.get(code) ?? 0;
      return {
        code,
        last: lastValue,
        previous: previousValue,
        changePct: changePct(lastValue, previousValue),
      };
    })
    .sort((a, b) => b.changePct - a.changePct);

  const transcript = renderTranscript({
    periods,
    revenueLast,
    revenuePrevious,
    revenueChangePct,
    byCountry,
    failures,
    revLast,
    countryLast,
    failLast,
  });

  return {
    periods,
    revenueLast,
    revenuePrevious,
    revenueChangePct,
    byCountry,
    failures,
    transcript,
  };
}

function renderTranscript(input: {
  periods: PeriodPair;
  revenueLast: number;
  revenuePrevious: number;
  revenueChangePct: number;
  byCountry: Investigation["byCountry"];
  failures: Investigation["failures"];
  revLast: QueryResult;
  countryLast: QueryResult;
  failLast: QueryResult;
}): string {
  const countryLines = input.byCountry
    .filter((row) => ["UK", "US", "Germany"].includes(row.country))
    .sort((a, b) => {
      const order = ["UK", "US", "Germany"];
      return order.indexOf(a.country) - order.indexOf(b.country);
    })
    .map((row) => `  ${row.country.padEnd(10)} ${pct(row.changePct).padStart(7)}`)
    .join("\n");

  const failLines = input.failures
    .slice(0, 4)
    .map((row) => `  ${row.code.padEnd(22)} ${pct(row.changePct).padStart(7)}`)
    .join("\n");

  const germany = input.byCountry.find((row) => row.country === "Germany");
  const auth = input.failures.find((row) => row.code === "CARD_AUTH_FAILED");

  return [
    "Why did revenue fall last month?",
    "",
    "Agent → Grane",
    "",
    "  revenue",
    "  period: last_month",
    "",
    "Grane",
    "",
    `  Revenue: ${gbp(input.revenueLast)}`,
    `  Change:  ${pct(input.revenueChangePct)}`,
    "",
    `  ${trustHeadline(input.revLast.trust)}`,
    "",
    "Agent → Grane",
    "",
    "  revenue by country",
    "  period: last_month",
    "",
    "Grane",
    "",
    countryLines,
    "",
    `  ${trustHeadline(input.countryLast.trust)}`,
    "",
    "Agent → Grane",
    "",
    "  failed payments by failure_code",
    "  where country = Germany",
    "  period: last_month",
    "",
    "  (failure_code is not a governed dimension.",
    "   Grane still permits it — the column is allowed.)",
    "",
    "Grane",
    "",
    failLines,
    "",
    `  ${trustHeadline(input.failLast.trust)}`,
    "",
    "  revenue:              governed",
    "  payments.failure_code: exploratory",
    "",
    "Agent",
    "",
    `  Revenue fell ${Math.abs(input.revenueChangePct).toFixed(1)}%, primarily due to ${germany?.country ?? "Germany"}`,
    `  (${pct(germany?.changePct ?? 0)}). The strongest lead is a ${pct(auth?.changePct ?? 0)}`,
    "  increase in card authentication failures among German customers.",
    "",
    "  Revenue and geography are governed. The payment-failure",
    "  analysis is exploratory.",
  ].join("\n");
}
