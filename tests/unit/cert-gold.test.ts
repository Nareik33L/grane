import { describe, expect, it } from "vitest";
import { CUSTOMERS, ORDERS } from "../certification/data.js";
import { PG_CERT_DDL, SQL_TYPE, ddl } from "../certification/ddl.js";
import { GOLD } from "../certification/gold.js";

describe("certification gold (TypeScript reductions)", () => {
  it("locks the published #36 numbers without querying a warehouse", () => {
    expect(GOLD.augRevenue).toBe(576);
    expect(GOLD.aug1Date).toBe(200);
    expect(GOLD.naiveUtcAug1).toBe(200);
    expect(GOLD.naiveNyAug1).toBe(120);
    expect(GOLD.instantUtcAug1).toBe(200);
    expect(GOLD.instantNyAug1).toBe(120);
    expect(GOLD.unmatchedAug).toBe(10);
    expect(GOLD.acmeAug).toBe(336);
    expect(GOLD.orderWeightSafe).toBe(52);
    expect(GOLD.orderWeightAbc).toBe(21);
    expect(GOLD.ukRevenue).toBe(50);
    expect(GOLD.endingMrrAug).toBe(1400);
    expect(GOLD.newMrrJulAugAligned).toBe(321);
    expect(GOLD.weekMonday).toEqual({ "2026-08-24": 3, "2026-08-31": 60, "2026-09-07": 64 });
    expect(GOLD.weekSunday).toEqual({ "2026-08-23": 1, "2026-08-30": 30, "2026-09-06": 96 });
    expect(GOLD.march1m).toBe(3100);
    expect(GOLD.leapMarch).toBe(31);
    expect(GOLD.seedCounts).toMatchObject({
      customers: 8,
      orders: 18,
      snapshots: 9,
      regions: 6,
      items: 3,
      products_safe: 4,
      days: 65,
      weeks: 7,
      types: 1,
    });
  });

  it("does not join orders.account_ref to the customers.id surrogate", () => {
    const hits = ORDERS.filter((o) => CUSTOMERS.some((c) => o.account_ref === String(c.id)));
    expect(hits).toEqual([]);
  });
});

describe("certification ddl(dialect)", () => {
  it("shares one type map and emits Postgres / DuckDB DDL from the same seed", () => {
    expect(SQL_TYPE.postgres.timestamptz).toBe("TIMESTAMPTZ");
    expect(SQL_TYPE.duckdb.timestamp_naive).toBe("TIMESTAMP");
    expect(SQL_TYPE.mysql.timestamp_naive).toBe("DATETIME");
    expect(PG_CERT_DDL).toEqual(ddl("postgres"));
    expect(ddl("postgres").some((s) => s.includes("TIMESTAMPTZ"))).toBe(true);
    expect(ddl("duckdb").some((s) => s.includes("TIMESTAMPTZ"))).toBe(true);
    expect(ddl("postgres").some((s) => s.includes("9007199254740993"))).toBe(true);
    expect(ddl("postgres").some((s) => s.includes("DROP TABLE"))).toBe(true);
    expect(ddl("postgres").filter((s) => s.startsWith("CREATE TABLE")).length).toBe(12);
  });
});
