/**
 * COMPOSITION HELL — individually supported features, combined.
 *
 * Every expected number comes from TypeScript fixtures or reviewed SQL in
 * gold.ts. Grane is not allowed to supply its own ground truth.
 *
 * A composition that cannot be proven safe must refuse. A composition that
 * can be proven safe must execute (or explore) with the correct trust label.
 */

import { GOLD_SQL } from "../gold.js";
import { lastAsOfByAccountName, lastAsOfTotal } from "../data.js";
import { tablesMatchScalar } from "../gold.js";
import type { Scenario } from "../types.js";
import { toGrant } from "../../../src/auth/agents.js";

function sc(partial: Scenario): Scenario {
  return { mode: "execute", guessSeverity: "critical", ...partial };
}

export function compositionTraps(): Scenario[] {
  const intern = toGrant({
    id: "intern",
    token: "intern-token",
    metrics: ["revenue"],
    dimensions: ["channel"],
    exploration: false,
  });

  return [
    sc({
      id: "composition/balance-name-last-month",
      category: "composition",
      question: "Account Balance by account last month.",
      interpretation:
        "Semi-additive + governed dimension + relative period. February as-of with carry-forward, grouped by name.",
      expectedSqlBehaviour: "last CTE + JOIN accounts + February end bound.",
      query: {
        metrics: ["account_balance"],
        dimensions: ["account_name"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const expected = lastAsOfByAccountName("2024-02-29");
        for (const [name, gold] of expected) {
          if (gold == null) continue;
          const got = Number(ctx.rows?.find((r) => r["account_name"] === name)?.["account_balance"]);
          if (!tablesMatchScalar(got, gold)) {
            return { code: "CRITICAL FAIL", detail: `${name} ${got} !== ${gold}` };
          }
        }
        const total = lastAsOfTotal("2024-02-29");
        const summed = [...expected.values()].reduce((s, v) => s + (v ?? 0), 0);
        if (!tablesMatchScalar(summed, total)) {
          return { code: "FAIL", detail: "fixture internal mismatch" };
        }
        return { code: "PASS", detail: "last-as-of × dimension × last_month" };
      },
    }),
    sc({
      id: "composition/balance-name-filter-range",
      category: "composition",
      question: "Acme Account Balance as of 14 Mar 2024.",
      interpretation: "Last-as-of + dimension filter + explicit range. Acme 1100 (2 Mar), not 900.",
      expectedSqlBehaviour: "Filter after last-as-of.",
      query: {
        metrics: ["account_balance"],
        filters: [{ field: "account_name", operator: "=", value: "Acme" }],
        time: { from: "2024-03-01", to: "2024-03-14" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 1100, column: "account_balance" } },
    }),
    sc({
      id: "composition/revenue-country-channel-last-month",
      category: "composition",
      question: "Revenue last month for GB web orders.",
      interpretation: "Metric + time.period + dimension filter + another filter. Independent February London gold.",
      expectedSqlBehaviour: "completed_at February bounds, JOIN customers, channel = web, country = GB.",
      query: {
        metrics: ["revenue"],
        filters: [
          { field: "customer_country", operator: "=", value: "GB" },
          { field: "channel", operator: "=", value: "web" },
        ],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueFebruaryWebGb },
        sqlMustInclude: ["completed_at"],
      },
    }),
    sc({
      id: "composition/aov-last-month",
      category: "composition",
      question: "Average order value last month.",
      interpretation: "Ratio of two same-grain metrics with a shared time window. Must not average averages.",
      expectedSqlBehaviour: "Revenue FILTER / Orders FILTER on completed_at February.",
      query: { metrics: ["average_order_value"], time: { period: "last_month" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.aovFebruary },
        sqlMustInclude: ["NULLIF"],
      },
    }),
    sc({
      id: "composition/conversion-last-month-by-channel",
      category: "composition",
      question: "Conversion rate last month by channel.",
      interpretation:
        "Ratio whose components disagree on time_dimension, plus a dimension. Each component FILTER on its own timestamp; channel is order-grain.",
      expectedSqlBehaviour: "No shared outer time WHERE. FILTER on created_at and completed_at. GROUP BY channel.",
      query: {
        metrics: ["conversion_rate"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const web = ctx.rows?.find((r) => r["channel"] === "web")?.["conversion_rate"];
        if (web == null) return { code: "CRITICAL FAIL", detail: "missing web conversion row" };
        if (!tablesMatchScalar(Number(web), 1)) {
          return { code: "CRITICAL FAIL", detail: `web conversion ${String(web)} !== 1` };
        }
        return { code: "PASS", detail: `web conversion ${String(web)}` };
      },
    }),
    sc({
      id: "composition/revenue-by-country-last-month",
      category: "composition",
      question: "Revenue last month by customer country.",
      interpretation: "Time + many-to-one dimension. Orphan February order (no customer) must drop out of the country slice.",
      expectedSqlBehaviour: "JOIN customers, February completed_at.",
      query: {
        metrics: ["revenue"],
        dimensions: ["customer_country"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const gb = Number(ctx.rows?.find((r) => r["customer_country"] === "GB")?.["revenue"]);
        const us = Number(ctx.rows?.find((r) => r["customer_country"] === "US")?.["revenue"]);
        if (!tablesMatchScalar(gb, 75)) return { code: "CRITICAL FAIL", detail: `GB ${gb} !== 75` };
        if (!tablesMatchScalar(us, -15)) return { code: "CRITICAL FAIL", detail: `US ${us} !== -15` };
        return { code: "PASS", detail: "February country slice" };
      },
    }),
    sc({
      id: "composition/explore-discount-last-month",
      category: "composition",
      question: "Revenue last month by raw discount_code.",
      interpretation: "Governed metric + raw dimension + relative period = mixed trust, still last-month completed_at.",
      expectedSqlBehaviour: "trust mixed. Parameterised discount_code group.",
      query: {
        metrics: ["revenue"],
        raw_dimensions: ["orders.discount_code"],
        time: { period: "last_month" },
      },
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
    }),
    sc({
      id: "composition/fiscal-year-by-customer-type",
      category: "composition",
      question: "Revenue this fiscal year by customer type.",
      interpretation: "Fiscal period (April start) + dimension. Now is 15 Mar 2024 so FY is 2023-04-01..2024-03-15.",
      expectedSqlBehaviour: "completed_at from 2023-04-01.",
      query: {
        metrics: ["revenue"],
        dimensions: ["customer_type"],
        time: { period: "this_fiscal_year" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        if (!ctx.rows || ctx.rows.length === 0) {
          return { code: "CRITICAL FAIL", detail: "no customer_type rows" };
        }
        return { code: "PASS", detail: `${ctx.rows.length} types` };
      },
    }),
    sc({
      id: "composition/mixed-entities-refused",
      category: "composition",
      question: "Revenue and Account Balance in one query.",
      interpretation: "order grain + snapshot grain. Cannot share a FROM. Do not guess a join through account_members.",
      expectedSqlBehaviour: "invalid_query spanning entities.",
      query: { metrics: ["revenue", "account_balance"] },
      disposition: "INVALID",
      expectation: { kind: "refuse", statuses: ["invalid_query"], reason: "mixed entity" },
    }),
    sc({
      id: "composition/balance-plus-ticket-refused",
      category: "composition",
      question: "Account Balance by ticket category.",
      interpretation: "Two facts sharing customers is still a fan-out. Composition does not make it safe.",
      expectedSqlBehaviour: "unsafe_query.",
      query: { metrics: ["account_balance"], dimensions: ["ticket_category"] },
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "ticket fan-out" },
    }),
    sc({
      id: "composition/intern-explore-disabled-on-composed-query",
      category: "composition",
      question: "Intern asks for Revenue last month by raw discount_code.",
      interpretation: "Time + exploration + intern grant. exploration=false wins.",
      expectedSqlBehaviour: "exploration_disabled.",
      agent: intern,
      guessSeverity: "security",
      query: {
        metrics: ["revenue"],
        raw_dimensions: ["orders.discount_code"],
        time: { period: "last_month" },
      },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["exploration_disabled"], reason: "agent grant" },
    }),
    sc({
      id: "composition/intern-channel-last-month-allowed",
      category: "composition",
      question: "Intern asks for Revenue last month by channel.",
      interpretation: "Intern may use revenue + channel. Last month is a supported period. Must still match February gold.",
      expectedSqlBehaviour: "Governed execute; intern allow-list honoured.",
      agent: intern,
      query: {
        metrics: ["revenue"],
        dimensions: ["channel"],
        time: { period: "last_month" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const web = Number(ctx.rows?.find((r) => r["channel"] === "web")?.["revenue"]);
        if (!tablesMatchScalar(web, 80.5)) {
          return { code: "CRITICAL FAIL", detail: `intern web last_month ${web} !== 80.5` };
        }
        return { code: "PASS", detail: "intern composed query" };
      },
    }),
    sc({
      id: "composition/ambiguous-period-with-dimension",
      category: "composition",
      question: "Revenue YTD by channel.",
      interpretation: "Fiscal year is configured, so ytd is ambiguous even when the rest of the query is unique.",
      expectedSqlBehaviour: "ambiguous_query. Do not pick calendar vs fiscal because a dimension is present.",
      query: { metrics: ["revenue"], dimensions: ["channel"], time: { period: "ytd" } },
      disposition: "CLARIFY",
      expectation: { kind: "refuse", statuses: ["ambiguous_query"], reason: "ytd vs fiscal" },
    }),
    sc({
      id: "composition/disagreeing-time-plus-grain-clarify",
      category: "composition",
      question: "Conversion rate last month by week grain (no time.dimension).",
      interpretation: "Components disagree on time column; grain without an explicit dimension is ambiguous.",
      expectedSqlBehaviour: "ambiguous_query.",
      query: {
        metrics: ["conversion_rate"],
        time: { period: "last_month", grain: "week" },
      },
      disposition: "CLARIFY",
      expectation: { kind: "refuse", statuses: ["ambiguous_query"], reason: "grain vs disagreeing time" },
    }),
    sc({
      id: "composition/balance-explore-and-time",
      category: "composition",
      question: "Account Balance last month by raw accounts.country.",
      interpretation: "Last-as-of + relative period + exploratory dimension. Mixed, February carry-forward.",
      expectedSqlBehaviour: "trust mixed; last CTE; February end.",
      query: {
        metrics: ["account_balance"],
        raw_dimensions: ["accounts.country"],
        time: { period: "last_month" },
      },
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        if (ctx.trust === "governed") {
          return { code: "CRITICAL FAIL", detail: "exploratory composition labelled governed" };
        }
        const us = Number(
          ctx.rows?.find((r) => r["country"] === "US" || r["accounts.country"] === "US")?.["account_balance"],
        );
        const acme = lastAsOfByAccountName("2024-02-29").get("Acme") ?? 0;
        if (!tablesMatchScalar(us, acme)) {
          return { code: "CRITICAL FAIL", detail: `US last-month ${us} !== Acme ${acme}` };
        }
        return { code: "PASS — EXPLORATORY", detail: `trust ${ctx.trust}` };
      },
    }),
    sc({
      id: "composition/this-week-by-channel-sunday",
      category: "composition",
      question: "Revenue this week by channel with Sunday weeks.",
      interpretation: "Calendar week.starts + dimension. Sunday this_week includes 10 Mar web 75.",
      expectedSqlBehaviour: "trust governed; 2024-03-10..2024-03-15; GROUP BY channel.",
      config: (base) => ({
        ...base,
        project: { ...base.project, week: { starts: "sunday" } },
      }),
      query: {
        metrics: ["revenue"],
        dimensions: ["channel"],
        time: { period: "this_week" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const web = Number(ctx.rows?.find((r) => r["channel"] === "web")?.["revenue"]);
        if (!tablesMatchScalar(web, 75)) {
          return { code: "CRITICAL FAIL", detail: `Sunday this_week web ${web} !== 75` };
        }
        return { code: "PASS", detail: "week.starts × channel" };
      },
    }),
    sc({
      id: "composition/balance-this-week",
      category: "composition",
      question: "Account Balance this week (Monday start).",
      interpretation: "Last-as-of week end 15 Mar combined with calendar week. Same as as-of 15 Mar.",
      expectedSqlBehaviour: "Last-as-of 15 Mar, not a sum of the week's snapshot rows.",
      query: { metrics: ["account_balance"], time: { period: "this_week" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar15 },
      },
    }),
    sc({
      id: "composition/this-quarter-by-country",
      category: "composition",
      question: "Revenue this quarter by customer country.",
      interpretation: "Calendar quarter + dimension. q1 would still be clarify; this_quarter must execute.",
      expectedSqlBehaviour: "2024-01-01..2024-03-15 completed_at, JOIN customers.",
      query: {
        metrics: ["revenue"],
        dimensions: ["customer_country"],
        time: { period: "this_quarter" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
    }),
  ];
}
