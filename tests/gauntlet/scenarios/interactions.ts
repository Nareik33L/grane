/**
 * Interaction failures — two capabilities that are each correct in isolation
 * and must stay correct when combined. Independent gold only.
 */

import { GOLD_SQL, tablesMatchScalar } from "../gold.js";
import {
  BILLING_ADDRESSES,
  completedInInclusiveRange,
  customerById,
  lastAsOfTotal,
  ORDERS,
  PAYMENTS,
  revenueInInclusiveRange,
  SHIPPING_ADDRESSES,
} from "../data.js";
import type { Scenario } from "../types.js";
import { toGrant } from "../../../src/auth/agents.js";

function sc(partial: Scenario): Scenario {
  return { mode: "execute", guessSeverity: "critical", ...partial };
}

function numericAt(
  rows: Record<string, unknown>[] | null,
  key: string,
  match: unknown,
  column: string,
): number | null {
  const row = rows?.find((r) => r[key] === match);
  if (!row) return null;
  const value = row[column];
  return value == null ? null : Number(value);
}

export function interactionTraps(): Scenario[] {
  const intern = toGrant({
    id: "intern",
    token: "intern-token",
    metrics: ["revenue"],
    dimensions: ["channel"],
    exploration: false,
  });
  const analyst = toGrant({
    id: "analyst",
    token: "analyst-token",
    metrics: ["revenue", "orders", "average_order_value"],
    dimensions: ["customer_country", "channel"],
    exploration: true,
  });

  const febFrom = "2024-02-01";
  const febTo = "2024-02-29";
  const febCompleted = completedInInclusiveRange(febFrom, febTo);
  const febRevenue = revenueInInclusiveRange(febFrom, febTo);
  const febAov = febRevenue / febCompleted.length;

  const webFeb = febCompleted.filter((o) => o.channel === "web");
  const webFebAov = webFeb.reduce((s, o) => s + o.net_amount, 0) / webFeb.length;

  const febByChannelCountry = new Map<string, number>();
  for (const o of febCompleted) {
    if (o.customer_id == null) continue;
    const country = customerById(o.customer_id)?.country ?? null;
    const key = `${o.channel}|${country}`;
    febByChannelCountry.set(key, (febByChannelCountry.get(key) ?? 0) + o.net_amount);
  }

  const febDistinctByCountry = new Map<string | null, Set<number>>();
  for (const o of febCompleted) {
    if (o.customer_id == null) continue;
    const country = customerById(o.customer_id)?.country ?? null;
    const set = febDistinctByCountry.get(country) ?? new Set<number>();
    set.add(o.customer_id);
    febDistinctByCountry.set(country, set);
  }

  const febDistinctByBilling = new Map<string, Set<number>>();
  for (const o of febCompleted) {
    const billing = BILLING_ADDRESSES.find((b) => b.order_id === o.id);
    if (!billing || o.customer_id == null) continue;
    const set = febDistinctByBilling.get(billing.country) ?? new Set<number>();
    set.add(o.customer_id);
    febDistinctByBilling.set(billing.country, set);
  }

  const febShipping = new Map<string, number>();
  for (const o of febCompleted) {
    const ship = SHIPPING_ADDRESSES.find((s) => s.order_id === o.id);
    if (!ship) continue;
    febShipping.set(ship.country, (febShipping.get(ship.country) ?? 0) + o.net_amount);
  }

  const succeededThisQuarter = PAYMENTS.filter((p) => {
    if (p.status !== "succeeded") return false;
    const order = ORDERS.find((o) => o.id === p.order_id);
    if (!order?.completed_at || order.status !== "completed") return false;
    return order.completed_at >= "2024-01-01" && order.completed_at < "2024-03-16T00:00:00Z";
  });
  const succeededThisQuarterTotal = succeededThisQuarter.reduce((s, p) => s + p.amount, 0);
  const succeededThisQuarterWeb = succeededThisQuarter
    .filter((p) => ORDERS.find((o) => o.id === p.order_id)?.channel === "web")
    .reduce((s, p) => s + p.amount, 0);

  const allCompleted = completedInInclusiveRange("2000-01-01", "2099-12-31");
  const byChannel = new Map<string, { sum: number; n: number }>();
  for (const o of allCompleted) {
    const slot = byChannel.get(o.channel) ?? { sum: 0, n: 0 };
    slot.sum += o.net_amount;
    slot.n += 1;
    byChannel.set(o.channel, slot);
  }
  const totalAov = allCompleted.reduce((s, o) => s + o.net_amount, 0) / allCompleted.length;
  const meanChannelAov =
    [...byChannel.values()].reduce((s, slot) => s + slot.sum / slot.n, 0) / byChannel.size;

  return [
    sc({
      id: "ix/aov-by-channel-last-month",
      category: "composition",
      question: "Average order value last month by channel.",
      interpretation: "Ratio + dimension + relative period. Per-channel ratio of sums, not an average of ratios.",
      expectedSqlBehaviour: "GROUP BY channel; FILTER on completed_at February for both components.",
      query: {
        metrics: ["average_order_value"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const web = numericAt(ctx.rows, "channel", "web", "average_order_value");
        if (web == null || !tablesMatchScalar(web, webFebAov)) {
          return { code: "CRITICAL FAIL", detail: `web AOV ${String(web)} !== ${webFebAov}` };
        }
        return { code: "PASS", detail: `web AOV ${web}` };
      },
    }),
    sc({
      id: "ix/aov-is-not-mean-of-channel-aovs",
      category: "composition",
      question: "Total AOV must not equal the unweighted mean of per-channel AOVs.",
      interpretation: "Ratio without a dimension. Averaging grouped ratios is the classic trap.",
      expectedSqlBehaviour: "Single ratio of totals. Must not match mean(channel AOV).",
      query: { metrics: ["average_order_value"] },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["average_order_value"]);
        if (!tablesMatchScalar(got, totalAov)) {
          return { code: "CRITICAL FAIL", detail: `AOV ${got} !== ${totalAov}` };
        }
        if (tablesMatchScalar(got, meanChannelAov)) {
          return { code: "CRITICAL FAIL", detail: `AOV collapsed to mean of channel AOVs ${meanChannelAov}` };
        }
        const grouped = await ctx.kernel.query({
          metrics: ["average_order_value"],
          dimensions: ["channel"],
        });
        const mean =
          grouped.rows.reduce((s, r) => s + Number(r["average_order_value"]), 0) / grouped.rows.length;
        if (tablesMatchScalar(got, mean)) {
          return { code: "CRITICAL FAIL", detail: "ungrouped AOV equals mean of grouped AOVs" };
        }
        return { code: "PASS", detail: `AOV ${got} ≠ mean channel ${meanChannelAov}` };
      },
    }),
    sc({
      id: "ix/nested-successful-revenue-this-quarter",
      category: "composition",
      question: "Successful revenue this quarter.",
      interpretation: "Nested (child-table) metric + calendar quarter. Payments pre-aggregated at order grain.",
      expectedSqlBehaviour: "payments CTE/join, succeeded filter, completed_at Q1 through 15 Mar.",
      query: { metrics: ["successful_revenue"], time: { period: "this_quarter" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.successfulRevenueThisQuarter },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["successful_revenue"]);
        if (!tablesMatchScalar(got, succeededThisQuarterTotal)) {
          return {
            code: "CRITICAL FAIL",
            detail: `successful_revenue ${got} !== fixture ${succeededThisQuarterTotal}`,
          };
        }
        return { code: "PASS", detail: String(got) };
      },
    }),
    sc({
      id: "ix/nested-successful-revenue-web-this-quarter",
      category: "composition",
      question: "Successful revenue this quarter for web.",
      interpretation: "Nested metric + filter + quarter. Filter must apply after pre-aggregation, not multiply payments.",
      expectedSqlBehaviour: "channel = web on orders, succeeded payments, Q1 window.",
      query: {
        metrics: ["successful_revenue"],
        filters: [{ field: "channel", operator: "=", value: "web" }],
        time: { period: "this_quarter" },
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.successfulRevenueThisQuarterWeb },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["successful_revenue"]);
        if (!tablesMatchScalar(got, succeededThisQuarterWeb)) {
          return { code: "CRITICAL FAIL", detail: `web successful ${got} !== ${succeededThisQuarterWeb}` };
        }
        return { code: "PASS", detail: String(got) };
      },
    }),
    sc({
      id: "ix/nested-explore-discount",
      category: "composition",
      question: "Successful revenue by raw discount_code.",
      interpretation: "Nested metric + exploratory dimension. Mixed trust; still order grain.",
      expectedSqlBehaviour: "trust mixed. Must not label governed.",
      query: { metrics: ["successful_revenue"], raw_dimensions: ["orders.discount_code"] },
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
    }),
    sc({
      id: "ix/distinct-last-month-by-country",
      category: "composition",
      question: "Ordering customers last month by customer country.",
      interpretation: "count_distinct + time + many-to-one dimension. Orphan February order is not a customer.",
      expectedSqlBehaviour: "COUNT DISTINCT customer_id, JOIN customers, February completed_at.",
      query: {
        metrics: ["ordering_customers"],
        dimensions: ["customer_country"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", sqlMustInclude: ["DISTINCT"] },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        for (const [country, ids] of febDistinctByCountry) {
          const got = numericAt(ctx.rows, "customer_country", country, "ordering_customers");
          if (got == null || !tablesMatchScalar(got, ids.size)) {
            return {
              code: "CRITICAL FAIL",
              detail: `${String(country)} distinct ${String(got)} !== ${ids.size}`,
            };
          }
        }
        return { code: "PASS", detail: "distinct × country × last_month" };
      },
    }),
    sc({
      id: "ix/distinct-last-month-by-billing",
      category: "composition",
      question: "Ordering customers last month by billing country.",
      interpretation: "count_distinct + 1:1 hop. Must not fan-out; NULL customer_id is not a customer.",
      expectedSqlBehaviour: "JOIN billing_addresses. COUNT DISTINCT orders.customer_id.",
      query: {
        metrics: ["ordering_customers"],
        dimensions: ["billing_country"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", sqlMustInclude: ["DISTINCT"] },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        for (const [country, ids] of febDistinctByBilling) {
          const got = numericAt(ctx.rows, "billing_country", country, "ordering_customers");
          if (got == null || !tablesMatchScalar(got, ids.size)) {
            return {
              code: "CRITICAL FAIL",
              detail: `billing ${country} ${String(got)} !== ${ids.size}`,
            };
          }
        }
        return { code: "PASS", detail: "distinct × billing hop × last_month" };
      },
    }),
    sc({
      id: "ix/avg-order-amount-by-channel-last-month",
      category: "composition",
      question: "Average order amount last month by channel.",
      interpretation: "AVG metric + dimension + time. Must remain AVG of amounts, not AVG of grouped averages at this grain.",
      expectedSqlBehaviour: "AVG(net_amount) FILTER February, GROUP BY channel.",
      query: {
        metrics: ["avg_order_amount"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const web = numericAt(ctx.rows, "channel", "web", "avg_order_amount");
        if (web == null || !tablesMatchScalar(web, webFebAov)) {
          return { code: "CRITICAL FAIL", detail: `web avg ${String(web)} !== ${webFebAov}` };
        }
        return { code: "PASS", detail: String(web) };
      },
    }),
    sc({
      id: "ix/revenue-two-dimensions-last-month",
      category: "composition",
      question: "Revenue last month by channel and customer country.",
      interpretation: "Two governed dimensions + relative period. Orphan drops out of the country join.",
      expectedSqlBehaviour: "GROUP BY channel, customer_country. February completed_at.",
      query: {
        metrics: ["revenue"],
        dimensions: ["channel", "customer_country"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        for (const [key, gold] of febByChannelCountry) {
          const [channel, country] = key.split("|");
          const row = ctx.rows?.find(
            (r) => r["channel"] === channel && String(r["customer_country"]) === country,
          );
          const got = row ? Number(row["revenue"]) : null;
          if (got == null || !tablesMatchScalar(got, gold)) {
            return { code: "CRITICAL FAIL", detail: `${key} ${String(got)} !== ${gold}` };
          }
        }
        return { code: "PASS", detail: "two dimensions × last_month" };
      },
    }),
    sc({
      id: "ix/conversion-web-last-month",
      category: "composition",
      question: "Conversion rate last month for web.",
      interpretation: "Ratio whose components disagree on time_dimension, plus a filter. Each FILTER keeps its own timestamp.",
      expectedSqlBehaviour: "No shared outer time WHERE. channel = web. FILTER created_at and completed_at.",
      query: {
        metrics: ["conversion_rate"],
        filters: [{ field: "channel", operator: "=", value: "web" }],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.conversionWebLastMonth },
      },
    }),
    sc({
      id: "ix/balance-this-quarter",
      category: "composition",
      question: "Account Balance this quarter.",
      interpretation: "Semi-additive + calendar quarter. As-of 15 Mar 2024 with carry-forward, not a sum of Q1 snapshots.",
      expectedSqlBehaviour: "last CTE bounded by 16 Mar exclusive. No naive SUM across dates.",
      query: { metrics: ["account_balance"], time: { period: "this_quarter" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "scalar", value: lastAsOfTotal("2024-03-15"), column: "account_balance" },
      },
    }),
    sc({
      id: "ix/this-week-monday-by-country-empty",
      category: "composition",
      question: "Revenue this week by customer country (Monday start).",
      interpretation: "Calendar week + dimension. 10 Mar (Sunday) is last week; Monday this_week is empty of completed orders.",
      expectedSqlBehaviour: "2024-03-11..2024-03-15. No Cara 75.",
      query: {
        metrics: ["revenue"],
        dimensions: ["customer_country"],
        time: { period: "this_week" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "empty" } },
    }),
    sc({
      id: "ix/tautology-channel-in-last-month",
      category: "composition",
      question: "Revenue last month where channel is web or mobile.",
      interpretation: "Every completed order is web or mobile. The extra filter must not change February revenue.",
      expectedSqlBehaviour: "Same number as unfiltered last_month (80.5 from independent gold).",
      query: {
        metrics: ["revenue"],
        filters: [{ field: "channel", operator: "in", value: ["web", "mobile"] }],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueLastMonthChannelIn },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["revenue"]);
        if (!tablesMatchScalar(got, febRevenue)) {
          return { code: "CRITICAL FAIL", detail: `filtered ${got} !== unfiltered last_month ${febRevenue}` };
        }
        return { code: "PASS", detail: `tautology ${got}` };
      },
    }),
    sc({
      id: "ix/week-timezone-london-monday-pin",
      category: "composition",
      question: "Revenue this week at 00:30 UTC 11 Mar in Europe/London.",
      interpretation:
        "Calendar week × timezone. London is already Monday 11 Mar, so this_week is 11 Mar only and excludes Cara's 10 Mar order.",
      expectedSqlBehaviour: "completed_at 2024-03-11..2024-03-12 London.",
      now: new Date("2024-03-11T00:30:00.000Z"),
      query: { metrics: ["revenue"], time: { period: "this_week" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueThisWeekMondayLondonPin },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = ctx.rows?.[0]?.["revenue"];
        const n = got == null ? 0 : Number(got);
        if (n === 75) {
          return { code: "CRITICAL FAIL", detail: "London this_week leaked Sunday 10 Mar (75)" };
        }
        if (!tablesMatchScalar(n, 0)) {
          return { code: "CRITICAL FAIL", detail: `London Monday pin included ${String(got)}` };
        }
        return { code: "PASS", detail: `London pin ${String(got)}` };
      },
    }),
    sc({
      id: "ix/week-timezone-ny-monday-pin",
      category: "composition",
      question: "Revenue this week at 00:30 UTC 11 Mar in America/New_York.",
      interpretation:
        "Same instant as the London pin, but NY is still Sunday 10 Mar. Monday-start this_week is 4–10 Mar and includes Cara 75.",
      expectedSqlBehaviour: "completed_at 2024-03-04..2024-03-11 New York.",
      now: new Date("2024-03-11T00:30:00.000Z"),
      config: (base) => ({
        ...base,
        project: { ...base.project, timezone: "America/New_York" },
      }),
      query: { metrics: ["revenue"], time: { period: "this_week" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueThisWeekMondayNyPin },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["revenue"] ?? 0);
        if (!tablesMatchScalar(got, 75)) {
          return { code: "CRITICAL FAIL", detail: `NY Monday-week pin ${got} !== 75` };
        }
        return { code: "PASS", detail: `NY pin ${got}` };
      },
    }),
    sc({
      id: "ix/quarter-not-fiscal-year",
      category: "composition",
      question: "This quarter revenue must not equal this fiscal year.",
      interpretation: "Calendar quarter vs April fiscal year. 15 Mar 2024: Q1 starts 1 Jan; FY starts 1 Apr 2023.",
      expectedSqlBehaviour: "this_quarter from 2024-01-01; this_fiscal_year from 2023-04-01. Numbers differ.",
      query: { metrics: ["revenue"], time: { period: "this_quarter" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueThisQuarter },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const quarter = Number(ctx.rows?.[0]?.["revenue"]);
        const fiscal = await ctx.kernel.query({ metrics: ["revenue"], time: { period: "this_fiscal_year" } });
        const fy = Number(fiscal.rows[0]?.["revenue"]);
        if (tablesMatchScalar(quarter, fy)) {
          return { code: "CRITICAL FAIL", detail: `this_quarter ${quarter} collapsed onto this_fiscal_year` };
        }
        const qGold = revenueInInclusiveRange("2024-01-01", "2024-03-15");
        if (!tablesMatchScalar(quarter, qGold)) {
          return { code: "CRITICAL FAIL", detail: `this_quarter ${quarter} !== ${qGold}` };
        }
        return { code: "PASS", detail: `Q ${quarter} ≠ FY ${fy}` };
      },
    }),
    sc({
      id: "ix/q1-plus-dimension-still-clarify",
      category: "composition",
      question: "Revenue Q1 by channel.",
      interpretation: "Fiscal year is configured. Adding a unique dimension must not resolve q1 into a guessed quarter.",
      expectedSqlBehaviour: "ambiguous_query.",
      query: { metrics: ["revenue"], dimensions: ["channel"], time: { period: "q1" } },
      disposition: "CLARIFY",
      expectation: { kind: "refuse", statuses: ["ambiguous_query"], reason: "q1 vs fiscal" },
    }),
    sc({
      id: "ix/governed-raw-blocked-filter",
      category: "composition",
      question: "Revenue by discount_code filtered on customers.email.",
      interpretation: "Governed metric + raw dimension + blocked filter. Policy wins; do not explore the rest.",
      expectedSqlBehaviour: "column_not_permitted. No email in SQL.",
      prohibitedColumns: ["customers.email"],
      guessSeverity: "security",
      query: {
        metrics: ["revenue"],
        raw_dimensions: ["orders.discount_code"],
        filters: [{ field: "customers.email", operator: "=", value: "alice@secret.example" }],
      },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked filter" },
    }),
    sc({
      id: "ix/intern-blocked-filter-on-allowed-metric",
      category: "composition",
      question: "Intern asks for last-month revenue filtered by email.",
      interpretation:
        "Intern may query revenue, but customers.email is not a governed intern dimension. Exploration is off, so the kernel refuses before the value is reachable. Either exploration_disabled or column_not_permitted is a policy pass; execution is a security failure.",
      expectedSqlBehaviour: "column_not_permitted.",
      agent: intern,
      prohibitedColumns: ["customers.email"],
      guessSeverity: "security",
      query: {
        metrics: ["revenue"],
        filters: [{ field: "customers.email", operator: "=", value: "alice@secret.example" }],
        time: { period: "last_month" },
      },
      disposition: "REFUSE_POLICY",
      expectation: {
        kind: "refuse",
        statuses: ["column_not_permitted", "exploration_disabled"],
        reason: "intern blocked filter",
      },
    }),
    sc({
      id: "ix/intern-cannot-compose-balance",
      category: "composition",
      question: "Intern asks for Account Balance last month.",
      interpretation: "Last-as-of is supported, but intern's allow-list does not include account_balance.",
      expectedSqlBehaviour: "undefined_metric.",
      agent: intern,
      guessSeverity: "security",
      query: { metrics: ["account_balance"], time: { period: "last_month" } },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "intern allow-list" },
    }),
    sc({
      id: "ix/analyst-cannot-use-blocked-plus-allowed-dim",
      category: "composition",
      question: "Analyst asks for AOV by channel filtered on salary.",
      interpretation: "Analyst allow-list is irrelevant once a blocked column is named.",
      expectedSqlBehaviour: "column_not_permitted.",
      agent: analyst,
      prohibitedColumns: ["employees.salary"],
      guessSeverity: "security",
      query: {
        metrics: ["average_order_value"],
        dimensions: ["channel"],
        filters: [{ field: "employees.salary", operator: ">", value: 1 }],
      },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked salary" },
    }),
    sc({
      id: "ix/null-country-last-month",
      category: "composition",
      question: "Revenue last month for customers with NULL country.",
      interpretation: "NULL is a real group (Eve 12.5). Missing data must not be dropped or coalesced to a country.",
      expectedSqlBehaviour: "customer_country IS NULL, February completed_at.",
      query: {
        metrics: ["revenue"],
        filters: [{ field: "customer_country", operator: "is_null" }],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const gold = febCompleted
          .filter((o) => o.customer_id != null && customerById(o.customer_id!)?.country == null)
          .reduce((s, o) => s + o.net_amount, 0);
        const got = Number(ctx.rows?.[0]?.["revenue"]);
        if (!tablesMatchScalar(got, gold)) {
          return { code: "CRITICAL FAIL", detail: `NULL-country ${got} !== ${gold}` };
        }
        return { code: "PASS", detail: `NULL country ${got}` };
      },
    }),
    sc({
      id: "ix/shipping-missing-rows-last-month",
      category: "composition",
      question: "Revenue last month by shipping country.",
      interpretation:
        "1:1 hop + time. February orders without a shipping row (Bob, Eve, orphan) must drop out of this slice, not be invented.",
      expectedSqlBehaviour: "INNER JOIN shipping_addresses. Only Alice's Feb orders have shipping.",
      query: {
        metrics: ["revenue"],
        dimensions: ["shipping_country"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        if (febShipping.size === 0) return { code: "FAIL", detail: "fixture has no Feb shipping gold" };
        for (const [country, gold] of febShipping) {
          const got = numericAt(ctx.rows, "shipping_country", country, "revenue");
          if (got == null || !tablesMatchScalar(got, gold)) {
            return { code: "CRITICAL FAIL", detail: `shipping ${country} ${String(got)} !== ${gold}` };
          }
        }
        const leaked = (ctx.rows ?? []).filter((r) => !febShipping.has(String(r["shipping_country"])));
        if (leaked.length) {
          return { code: "CRITICAL FAIL", detail: `unexpected shipping rows ${JSON.stringify(leaked)}` };
        }
        return { code: "PASS", detail: "missing shipping rows dropped" };
      },
    }),
    sc({
      id: "ix/leap-day-inside-last-month",
      category: "composition",
      question: "Last month must include the 29 Feb order of 25.",
      interpretation: "Relative period + leap-day boundary. Dropping 29 Feb would silently under-count February.",
      expectedSqlBehaviour: "Inclusive through 2024-02-29.",
      query: { metrics: ["revenue"], time: { period: "last_month" } },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = Number(ctx.rows?.[0]?.["revenue"]);
        if (!tablesMatchScalar(got, febRevenue)) {
          return { code: "CRITICAL FAIL", detail: `last_month ${got} !== ${febRevenue}` };
        }
        const withoutLeap = febRevenue - 25;
        if (tablesMatchScalar(got, withoutLeap)) {
          return { code: "CRITICAL FAIL", detail: "last_month dropped 29 Feb" };
        }
        return { code: "PASS", detail: `includes leap day (${got})` };
      },
    }),
    sc({
      id: "ix/mixed-grain-revenue-inventory",
      category: "composition",
      question: "Revenue and Inventory in one query.",
      interpretation: "Order grain vs product grain. Composition across entities must refuse, not invent a join.",
      expectedSqlBehaviour: "invalid_query spanning entities.",
      query: { metrics: ["revenue", "inventory"] },
      disposition: "INVALID",
      expectation: { kind: "refuse", statuses: ["invalid_query"], reason: "mixed grain" },
    }),
    sc({
      id: "ix/distinct-plus-child-grain-refused",
      category: "composition",
      question: "Ordering customers by product category.",
      interpretation: "count_distinct is safe at order grain; product_category is not. Combining them does not make it safe.",
      expectedSqlBehaviour: "unsafe_query.",
      query: { metrics: ["ordering_customers"], dimensions: ["product_category"] },
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "child grain" },
    }),
    sc({
      id: "ix/semi-plus-ticket-category",
      category: "composition",
      question: "Account Balance by ticket category.",
      interpretation: "Last-as-of does not license a fan-out through support tickets.",
      expectedSqlBehaviour: "unsafe_query.",
      query: { metrics: ["account_balance"], dimensions: ["ticket_category"] },
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "ticket fan-out" },
    }),
    sc({
      id: "ix/chain-value-by-label",
      category: "composition",
      question: "Chain value by chain_a label.",
      interpretation: "Multi-hop many-to-one chain. One row; value 42 from the fixture, not from Grane.",
      expectedSqlBehaviour: "JOIN chain_e … chain_a. No fan-out.",
      query: { metrics: ["chain_value"], dimensions: ["chain_a_label"] },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 42, column: "chain_value" } },
    }),
    sc({
      id: "ix/ratio-this-week-monday-empty",
      category: "composition",
      question: "AOV this week (Monday start).",
      interpretation: "Ratio + calendar week. No completed orders this Monday-week, so AOV is NULL/empty, not a guessed historical AOV.",
      expectedSqlBehaviour: "February must not leak into this_week.",
      query: { metrics: ["average_order_value"], time: { period: "this_week" } },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = ctx.rows?.[0]?.["average_order_value"];
        if (got != null && Number(got) !== 0 && Number.isFinite(Number(got))) {
          return { code: "CRITICAL FAIL", detail: `this_week AOV leaked ${String(got)}` };
        }
        return { code: "PASS", detail: `empty this_week AOV ${String(got)}` };
      },
    }),
    sc({
      id: "ix/nested-last-month-missing-payments",
      category: "composition",
      question: "Successful revenue last month.",
      interpretation: "Nested metric + February. No succeeded payments sit on February orders. Must not return all-time 405.",
      expectedSqlBehaviour: "0 or NULL, never the unbounded payment total.",
      query: { metrics: ["successful_revenue"], time: { period: "last_month" } },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const got = ctx.rows?.[0]?.["successful_revenue"];
        const n = got == null ? 0 : Number(got);
        if (n === 405 || n === 505) {
          return { code: "CRITICAL FAIL", detail: `last_month leaked unbounded payments ${n}` };
        }
        if (!tablesMatchScalar(n, 0)) {
          return { code: "CRITICAL FAIL", detail: `expected no Feb successful payments, got ${String(got)}` };
        }
        return { code: "PASS", detail: "February nested metric is empty" };
      },
    }),
    sc({
      id: "ix/conversion-grain-with-explicit-dimension",
      category: "composition",
      question: "Conversion rate last month by week on completed_at.",
      interpretation:
        "Disagreeing component times + grain. Explicit completed_at is a non-canonical clock for all_orders, so trust is mixed — not a guessed created_at, and not labelled governed.",
      expectedSqlBehaviour: "Execute with completed_at truncation. trust mixed.",
      query: {
        metrics: ["conversion_rate"],
        time: { period: "last_month", grain: "week", dimension: "completed_at" },
      },
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
    }),
    sc({
      id: "ix/extra-rel-does-not-license-plan-name",
      category: "composition",
      question: "Revenue last month by plan name after an extra customer relationship.",
      interpretation: "A safe extra edge must not make a one_to_many dimension (subscriptions/plans) start compiling.",
      expectedSqlBehaviour: "unsafe_query still.",
      config: (base) => ({
        ...base,
        relationships: {
          ...base.relationships,
          extra_customer_loop: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        },
      }),
      query: {
        metrics: ["revenue"],
        dimensions: ["plan_name"],
        time: { period: "last_month" },
      },
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query", "invalid_query"], reason: "plan via subscriptions" },
    }),
    sc({
      id: "time/kernel/non-leap-29-feb",
      category: "time",
      mode: "custom",
      question: "Kernel compile of 2023-02-29 must be invalid_query.",
      interpretation: "Date validation is a kernel guarantee, not only a Zod gate in the harness.",
      expectedSqlBehaviour: "invalid_query. Do not clamp to 28 Feb.",
      disposition: "INVALID",
      expectation: { kind: "refuse", statuses: ["invalid_query"], reason: "non-leap 29 Feb" },
      custom: async (ctx) => {
        try {
          ctx.kernel.compile({
            metrics: ["revenue"],
            time: { from: "2023-02-29", to: "2023-02-29" },
          });
          return { code: "CRITICAL FAIL", detail: "compiled 2023-02-29" };
        } catch (err) {
          const { GraneError } = await import("../../../src/errors.js");
          if (err instanceof GraneError && err.refusal.status === "invalid_query") {
            return { code: "PASS — INVALID", detail: err.refusal.message };
          }
          return { code: "FAIL", detail: String(err) };
        }
      },
    }),
  ];
}
