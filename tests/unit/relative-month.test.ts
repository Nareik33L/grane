/**
 * Calendar-month arithmetic for `<N>m` / `last_<N>m`.
 *
 * Contract preserved: N calendar months ending today =
 *   addDays(addMonths(today, -N), 1) .. today
 * with addMonths clamping the day to the last valid civil day of the
 * target month (no JavaScript Date overflow).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneKernel } from "../../src/kernel.js";
import { exampleConfig } from "../fixtures.js";
import {
  addMonths,
  daysInMonth,
  formatDate,
  resolveRelativeRange,
  type CalendarDate,
} from "../../src/query/time.js";

function civil(iso: string): CalendarDate {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function noonUtc(iso: string): Date {
  return new Date(`${iso}T12:00:00Z`);
}

const MONTH_CASES: { id: string; today: string; spec: string; from: string; to: string }[] = [
  { id: "A1", today: "2026-03-31", spec: "1m", from: "2026-03-01", to: "2026-03-31" },
  { id: "A2", today: "2024-03-31", spec: "1m", from: "2024-03-01", to: "2024-03-31" },
  { id: "A3", today: "2026-05-31", spec: "1m", from: "2026-05-01", to: "2026-05-31" },
  { id: "A4", today: "2026-01-31", spec: "1m", from: "2026-01-01", to: "2026-01-31" },
  { id: "A5", today: "2026-03-30", spec: "1m", from: "2026-03-01", to: "2026-03-30" },
  { id: "A6", today: "2026-03-29", spec: "1m", from: "2026-03-01", to: "2026-03-29" },
  { id: "A7", today: "2026-03-28", spec: "1m", from: "2026-03-01", to: "2026-03-28" },
  { id: "A8", today: "2026-03-15", spec: "1m", from: "2026-02-16", to: "2026-03-15" },
  { id: "A9", today: "2026-08-31", spec: "2m", from: "2026-07-01", to: "2026-08-31" },
  { id: "A10", today: "2026-08-31", spec: "6m", from: "2026-03-01", to: "2026-08-31" },
  { id: "A11", today: "2026-03-31", spec: "6m", from: "2025-10-01", to: "2026-03-31" },
  { id: "A12", today: "2026-12-31", spec: "12m", from: "2026-01-01", to: "2026-12-31" },
  { id: "A13", today: "2024-02-29", spec: "12m", from: "2023-03-01", to: "2024-02-29" },
  { id: "A14", today: "2025-02-28", spec: "12m", from: "2024-02-29", to: "2025-02-28" },
];

describe("calendar-month helper (no Date overflow)", () => {
  it("clamps day-of-month to the target month", () => {
    expect(formatDate(addMonths(civil("2026-03-31"), -1))).toBe("2026-02-28");
    expect(formatDate(addMonths(civil("2024-03-31"), -1))).toBe("2024-02-29");
    expect(formatDate(addMonths(civil("2026-05-31"), -1))).toBe("2026-04-30");
    expect(formatDate(addMonths(civil("2026-01-31"), -1))).toBe("2025-12-31");
    expect(formatDate(addMonths(civil("2026-03-30"), -1))).toBe("2026-02-28");
    expect(formatDate(addMonths(civil("2026-03-28"), -1))).toBe("2026-02-28");
    expect(daysInMonth(2026, 2)).toBe(28);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
    expect(daysInMonth(2000, 2)).toBe(29);
  });
});

describe("relative-period resolution A1–A17", () => {
  for (const c of MONTH_CASES) {
    it(`${c.id}: ${c.today} / ${c.spec} → ${c.from}..${c.to}`, () => {
      const now = noonUtc(c.today);
      expect(resolveRelativeRange(c.spec, "UTC", now)).toEqual({ from: c.from, to: c.to });
      expect(resolveRelativeRange(`last_${c.spec}`, "UTC", now)).toEqual({ from: c.from, to: c.to });
    });
  }

  it("A15: last_month is the previous calendar month (not Nm overflow)", () => {
    expect(resolveRelativeRange("last_month", "UTC", noonUtc("2026-03-31"))).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(resolveRelativeRange("last_month", "UTC", noonUtc("2026-08-25"))).toEqual({
      from: "2026-07-01",
      to: "2026-07-31",
    });
  });

  it("A16: 30d is inclusive day count, not month arithmetic", () => {
    expect(resolveRelativeRange("30d", "UTC", noonUtc("2026-03-31"))).toEqual({
      from: "2026-03-02",
      to: "2026-03-31",
    });
    expect(resolveRelativeRange("last_30d", "UTC", noonUtc("2026-03-31"))).toEqual({
      from: "2026-03-02",
      to: "2026-03-31",
    });
  });

  it("A17: explicit from/to is unchanged at query resolution", () => {
    const kernel = new GraneKernel(exampleConfig(), { now: noonUtc("2026-03-31") });
    const { resolved } = kernel.compile({
      metrics: ["revenue"],
      time: { from: "2026-03-01", to: "2026-03-31" },
    });
    expect(resolved.time?.from).toBe("2026-03-01");
    expect(resolved.time?.to).toBe("2026-03-31");
  });

  it("query-level 1m on 2026-03-31 resolves to March 1..31", () => {
    const kernel = new GraneKernel(exampleConfig(), { now: new Date("2026-03-31T15:00:00Z") });
    const { resolved } = kernel.compile({
      metrics: ["revenue"],
      time: { period: "1m" },
    });
    expect(resolved.time?.from).toBe("2026-03-01");
    expect(resolved.time?.to).toBe("2026-03-31");
    expect(resolved.notes.some((n) => n.includes("2026-03-01") && n.includes("2026-03-31"))).toBe(true);
  });
});

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string, opts?: Record<string, string>) => Promise<{
      connect: () => Promise<{
        run: (sql: string) => Promise<unknown>;
        closeSync?: () => void;
        disconnectSync?: () => void;
      }>;
      closeSync?: () => void;
    }>;
  };
};

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
const duckdbOk = await duckdbAvailable();

const kernels: GraneKernel[] = [];
afterAll(async () => {
  await Promise.all(kernels.map((k) => k.close()));
});

describe.skipIf(!duckdbOk)("executed month-end counterexample (DuckDB DATE)", () => {
  let path: string;
  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-month-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    const values: string[] = [];
    for (let day = 1; day <= 31; day++) {
      const dd = String(day).padStart(2, "0");
      values.push(`(${day}, DATE '2026-03-${dd}', 100)`);
    }
    values.push(`(32, DATE '2026-02-28', 999)`);
    values.push(`(33, DATE '2026-04-01', 999)`);
    await conn.run(`CREATE TABLE t (id INTEGER, d DATE, x NUMERIC)`);
    await conn.run(`INSERT INTO t VALUES ${values.join(", ")}`);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  function kernel(timezone: string, now: Date): GraneKernel {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "month-overflow", timezone },
        connection: { type: "duckdb", path, schema: "main" },
        entities: { fact: { table: "t", primary_key: "id" } },
        metrics: {
          revenue: { entity: "fact", type: "sum", sql: "${t.x}", time_dimension: "${t.d}" },
        },
      }),
      { now },
    );
    kernels.push(k);
    return k;
  }

  it("2026-03-31T15:00Z / 1m sums March (3100), not the overflow window", async () => {
    const k = kernel("UTC", new Date("2026-03-31T15:00:00Z"));
    const result = await k.query({ metrics: ["revenue"], time: { period: "1m" } });
    expect(result.trust).toBe("governed");
    expect(Number(result.rows[0]!.revenue)).toBe(3100);
    const { resolved, compiled } = k.compile({ metrics: ["revenue"], time: { period: "1m" } });
    expect(resolved.time?.from).toBe("2026-03-01");
    expect(resolved.time?.to).toBe("2026-03-31");
    expect(compiled.params).toEqual(["2026-03-01", "2026-04-01"]);
    expect(compiled.sql).toMatch(/::date/);
    expect(compiled.sql).not.toMatch(/AT TIME ZONE/);
  });

  it("DATE + explicit March window is 3100 in every project timezone (PR #20)", async () => {
    for (const tz of ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]) {
      const k = kernel(tz, new Date("2026-03-31T15:00:00Z"));
      const result = await k.query({
        metrics: ["revenue"],
        time: { from: "2026-03-01", to: "2026-03-31" },
      });
      expect(result.trust, tz).toBe("governed");
      expect(Number(result.rows[0]!.revenue), tz).toBe(3100);
      expect(k.compile({
        metrics: ["revenue"],
        time: { from: "2026-03-01", to: "2026-03-31" },
      }).compiled.sql, tz).not.toMatch(/AT TIME ZONE/);
    }
  });

  it("1m at noon UTC is March in UTC / NY / London / Tokyo (same civil day)", async () => {
    const now = noonUtc("2026-03-31");
    for (const tz of ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"]) {
      const k = kernel(tz, now);
      const result = await k.query({ metrics: ["revenue"], time: { period: "1m" } });
      expect(result.trust, tz).toBe("governed");
      expect(Number(result.rows[0]!.revenue), tz).toBe(3100);
      const { resolved } = k.compile({ metrics: ["revenue"], time: { period: "1m" } });
      expect(resolved.time?.from, tz).toBe("2026-03-01");
      expect(resolved.time?.to, tz).toBe("2026-03-31");
    }
  });
});
