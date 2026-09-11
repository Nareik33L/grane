/**
 * Engine-independent gold values: TypeScript reductions over the shared seed
 * arrays. Never query the warehouse under test for these numbers.
 */
import {
  CUSTOMERS,
  DAYS,
  ITEMS,
  ORDERS,
  PRODUCTS_SAFE,
  SNAPSHOTS,
  WEEKS,
  AUG,
  AUG_PARTIAL,
  SEED_COUNTS,
  type CertOrderRow,
} from "./data.js";

export function inInclusive(isoDate: string, from: string, to: string): boolean {
  return isoDate >= from && isoDate <= to;
}

export function sumAmount(rows: CertOrderRow[]): number {
  return rows.reduce((s, o) => s + (o.amount ?? 0), 0);
}

function civilInTz(utc: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(utc);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function weekStart(iso: string, starts: "monday" | "sunday"): string {
  const d = new Date(`${iso}T00:00:00Z`);
  const dow = d.getUTCDay();
  const offset = starts === "sunday" ? -dow : dow === 0 ? -6 : 1 - dow;
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

const augOrders = ORDERS.filter((o) => inInclusive(o.ordered_on, AUG.from, AUG.to));
const augAmounts = augOrders.filter((o) => o.amount !== null);

function customerByKey(key: string | null) {
  if (key === null) return undefined;
  return CUSTOMERS.find((c) => c.customer_key === key);
}

export const GOLD = {
  augRevenue: sumAmount(augOrders),
  augOrderCount: augOrders.length,
  augAmountCount: augAmounts.length,
  augAvg: sumAmount(augOrders) / augAmounts.length,
  augMin: Math.min(...augAmounts.map((o) => o.amount!)),
  augMax: Math.max(...augAmounts.map((o) => o.amount!)),
  augDistinctAccounts: new Set(augOrders.map((o) => o.account_ref).filter((k) => k !== null)).size,
  aug1Date: sumAmount(ORDERS.filter((o) => o.ordered_on === "2026-08-01")),
  naiveUtcAug1: sumAmount(ORDERS.filter((o) => o.naive_at.startsWith("2026-08-01"))),
  naiveNyAug1: sumAmount(
    ORDERS.filter((o) => civilInTz(new Date(`${o.naive_at}Z`), "America/New_York") === "2026-08-01"),
  ),
  instantUtcAug1: sumAmount(ORDERS.filter((o) => o.instant_at.startsWith("2026-08-01"))),
  instantNyAug1: sumAmount(
    ORDERS.filter((o) => civilInTz(new Date(o.instant_at), "America/New_York") === "2026-08-01"),
  ),
  unmatchedAug: sumAmount(
    augOrders.filter((o) => {
      if (o.account_ref === null) return true;
      return !CUSTOMERS.some((c) => c.customer_key === o.account_ref);
    }),
  ),
  acmeAug: sumAmount(augOrders.filter((o) => customerByKey(o.account_ref)?.name === "Acme")),
  orderWeightSafe: ITEMS.reduce((s, item) => {
    const weights = PRODUCTS_SAFE.filter((p) => p.product_id === item.product_id).map((p) => p.weight);
    if (weights.length !== 1) return s;
    return s + weights[0]!;
  }, 0),
  orderWeightAbc: ITEMS.filter((item) => {
    const order = ORDERS.find((o) => o.id === item.order_id);
    return order?.sku === "ABC";
  }).reduce((s, item) => {
    const weights = PRODUCTS_SAFE.filter((p) => p.product_id === item.product_id).map((p) => p.weight);
    if (weights.length !== 1) return s;
    return s + weights[0]!;
  }, 0),
  ukRevenue: sumAmount(augOrders.filter((o) => customerByKey(o.account_ref)?.segment === "SMB")),
  openAug: sumAmount(augOrders.filter((o) => o.status === "open")),
  endingMrrAug: SNAPSHOTS.filter((s) => s.month_start === "2026-08-01").reduce((s, r) => s + r.ending_mrr, 0),
  newMrrJulAugAligned: SNAPSHOTS.filter((s) => inInclusive(s.month_start, "2026-07-01", "2026-08-31")).reduce(
    (s, r) => s + r.new_mrr,
    0,
  ),
  augPartialRevenue: sumAmount(
    ORDERS.filter((o) => inInclusive(o.ordered_on, AUG_PARTIAL.from, AUG_PARTIAL.to)),
  ),
  weekMonday: (() => {
    const buckets = new Map<string, number>();
    for (const row of WEEKS) {
      const key = weekStart(row.d, "monday");
      buckets.set(key, (buckets.get(key) ?? 0) + row.x);
    }
    return Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)));
  })(),
  weekSunday: (() => {
    const buckets = new Map<string, number>();
    for (const row of WEEKS) {
      const key = weekStart(row.d, "sunday");
      buckets.set(key, (buckets.get(key) ?? 0) + row.x);
    }
    return Object.fromEntries([...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)));
  })(),
  march1m: DAYS.filter((d) => d.d.startsWith("2026-03")).reduce((s, d) => s + d.x, 0),
  leapMarch: DAYS.filter((d) => d.d.startsWith("2024-03")).reduce((s, d) => s + d.x, 0),
  augSkuDistinct: new Set(augOrders.map((o) => o.sku)).size,
  seedCounts: SEED_COUNTS,
} as const;
