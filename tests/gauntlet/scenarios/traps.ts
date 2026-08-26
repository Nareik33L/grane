/**
 * Hand-reviewed Gauntlet traps. Each has a known interpretation and a known
 * acceptable outcome. Generators in generators.ts add combinatorial volume
 * on top of these.
 */

import { toGrant } from "../../../src/auth/agents.js";
import { GOLD, GOLD_SQL } from "../gold.js";
import { gauntletConfig } from "../model.js";
import { BLOCKED_COLUMNS } from "../data.js";
import type { Scenario } from "../types.js";
import { GAUNTLET_NOW } from "../types.js";
import { tryExecuteRawSql } from "../harness.js";

function sc(partial: Scenario): Scenario {
  return { mode: "execute", guessSeverity: "critical", ...partial };
}

export function trapScenarios(): Scenario[] {
  return [
    ...joinTraps(),
    ...grainTraps(),
    ...metricTraps(),
    ...timeTraps(),
    ...permissionTraps(),
    ...explorationTraps(),
    ...ambiguityTraps(),
    ...dirtyTraps(),
    ...provenanceTraps(),
    ...readonlyTraps(),
    ...agentTraps(),
  ];
}

function joinTraps(): Scenario[] {
  return [
    sc({
      id: "join/revenue-total",
      category: "join",
      question: "What is Revenue?",
      interpretation: "SUM(orders.net_amount) WHERE status = completed. No join.",
      expectedSqlBehaviour: "Aggregate orders only; do not join children.",
      permittedTables: ["orders"],
      prohibitedTables: ["order_items", "payments", "refunds", "support_tickets"],
      query: { metrics: ["revenue"] },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueTotal },
        sqlMustNotInclude: ["order_items", "support_tickets"],
      },
    }),
    sc({
      id: "join/revenue-by-customer-country",
      category: "join",
      question: "Revenue by customer country.",
      interpretation: "Order grain, many-to-one to customers.country. Orphan order drops out.",
      expectedSqlBehaviour: "JOIN customers, do not join billing/shipping/countries lookup.",
      query: { metrics: ["revenue"], dimensions: ["customer_country"] },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "scalar", value: GOLD.revenueGb, column: "revenue" },
      },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const gb = ctx.rows?.find((r) => r["customer_country"] === "GB")?.["revenue"];
        const us = ctx.rows?.find((r) => r["customer_country"] === "US")?.["revenue"];
        if (Number(gb) !== GOLD.revenueGb) {
          return { code: "CRITICAL FAIL", detail: `GB revenue ${gb} !== ${GOLD.revenueGb}` };
        }
        if (Number(us) !== GOLD.revenueUs) {
          return { code: "CRITICAL FAIL", detail: `US revenue ${us} !== ${GOLD.revenueUs}` };
        }
        return { code: "PASS", detail: "customer country matches fixture reduction" };
      },
    }),
    sc({
      id: "join/revenue-by-ticket-category",
      category: "join",
      question: "Revenue by support ticket category.",
      interpretation: "Fact-to-fact via customers. A naive join multiplies Alice's orders.",
      expectedSqlBehaviour: "Refuse. Two one-to-many facts cannot share a query grain.",
      query: { metrics: ["revenue"], dimensions: ["ticket_category"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query", "invalid_query"], reason: "fan-out through tickets" },
    }),
    sc({
      id: "join/revenue-by-product-category",
      category: "grain",
      question: "Revenue by product category.",
      interpretation: "Product is below order grain via order_items. M2M categories double-count product 1.",
      expectedSqlBehaviour: "Refuse rather than join order_items / product_category_map.",
      query: { metrics: ["revenue"], dimensions: ["product_category"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "order_item grain" },
    }),
    sc({
      id: "join/revenue-plus-customers",
      category: "grain",
      question: "Revenue and Customers in one query.",
      interpretation: "Order grain vs customer grain.",
      expectedSqlBehaviour: "Refuse mixed grains.",
      query: { metrics: ["revenue", "customers"] },
      expectation: { kind: "refuse", statuses: ["invalid_query"], reason: "mixed entity" },
    }),
    sc({
      id: "join/revenue-by-account",
      category: "join",
      question: "Revenue by account name.",
      interpretation: "Alice is in two accounts. Bridge join would double her orders.",
      expectedSqlBehaviour: "Refuse the many-to-many bridge.",
      query: { metrics: ["revenue"], dimensions: ["account_name"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "account_members bridge" },
    }),
    sc({
      id: "join/revenue-by-session-browser",
      category: "grain",
      question: "Revenue by browser session.",
      interpretation: "Sessions are a second fact at customer grain.",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["revenue"], dimensions: ["session_browser"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "session grain" },
    }),
    sc({
      id: "join/revenue-by-checkout-error",
      category: "grain",
      question: "Revenue by checkout error.",
      interpretation: "Multiple checkout events per order.",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["revenue"], dimensions: ["checkout_error"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "checkout event grain" },
    }),
    sc({
      id: "join/revenue-by-experiment",
      category: "grain",
      question: "Revenue by experiment assignment.",
      interpretation: "Alice has two assignment rows (dirty duplicate).",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["revenue"], dimensions: ["experiment_variant"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "assignment grain" },
    }),
    sc({
      id: "join/revenue-by-campaign",
      category: "join",
      question: "Revenue by campaign.",
      interpretation: "Multi-touch attribution: order 1 has two campaign rows.",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["revenue"], dimensions: ["campaign_name"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "attribution fan-out" },
    }),
    sc({
      id: "join/payments-preagg",
      category: "join",
      question: "Successful Revenue (payments at order grain).",
      interpretation: "Order 1 has two succeeded payments; must pre-aggregate, not fan out orders.",
      expectedSqlBehaviour: "CTE grouped by order_id; outer query never joins raw payments.",
      query: { metrics: ["successful_revenue"] },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.successfulPayments },
        sqlMustInclude: ["m_successful_revenue"],
        sqlMustNotInclude: ['JOIN "payments"'],
      },
    }),
    sc({
      id: "join/payments-and-refunds",
      category: "join",
      question: "Successful Revenue and Refunded Amount together.",
      interpretation: "Two fanning children. Separate pre-aggregations.",
      expectedSqlBehaviour: "Two CTEs; no raw join to payments or refunds.",
      query: { metrics: ["successful_revenue", "refunded_amount"] },
      expectation: {
        kind: "execute",
        trust: "governed",
        sqlMustInclude: ["m_successful_revenue", "m_refunded_amount"],
        sqlMustNotInclude: ['JOIN "payments"', 'JOIN "refunds"'],
      },
    }),
    sc({
      id: "join/deep-chain",
      category: "join",
      question: "Chain value by chain_a label.",
      interpretation: "Six-hop many-to-one from F up to A. Cardinality stays 1.",
      expectedSqlBehaviour: "Join the chain without fan-out, return 42.",
      query: { metrics: ["chain_value"], dimensions: ["chain_a_label"] },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: GOLD.chainFValue } },
    }),
    sc({
      id: "join/count-distinct-by-category",
      category: "distinct",
      question: "Number of ordering customers by product category.",
      interpretation: "count_distinct across a one-to-many is not safely pre-aggregable.",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["ordering_customers"], dimensions: ["product_category"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "distinct across fan-out" },
    }),
  ];
}

function grainTraps(): Scenario[] {
  return [
    sc({
      id: "grain/raw-product-category",
      category: "grain",
      question: "Revenue by raw products.category.",
      interpretation: "A raw field does not make an unsafe join safe. Trust labels are not a substitute.",
      expectedSqlBehaviour: "Refuse the fan-out even as mixed exploration.",
      query: { metrics: ["revenue"], raw_dimensions: ["products.category"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "raw slice still fans out" },
    }),
    sc({
      id: "grain/raw-ticket-category",
      category: "exploration",
      question: "Revenue + support_tickets.category as mixed exploration.",
      interpretation: "Must not return mixed trust with a multiplied number.",
      expectedSqlBehaviour: "Refuse.",
      query: { metrics: ["revenue"], raw_dimensions: ["support_tickets.category"] },
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "unsafe exploratory relationship" },
    }),
  ];
}

function metricTraps(): Scenario[] {
  return [
    sc({
      id: "metrics/aov-ratio",
      category: "metrics",
      question: "Average order value.",
      interpretation: "revenue / orders with NULLIF for divide-by-zero.",
      expectedSqlBehaviour: "Ratio SQL with NULLIF.",
      query: { metrics: ["average_order_value"] },
      mode: "compile",
      expectation: { kind: "execute", trust: "governed", sqlMustInclude: ["NULLIF"] },
    }),
    sc({
      id: "metrics/undefined-net-revenue",
      category: "metrics",
      question: "Net Revenue (not defined; would be gross - refunds).",
      interpretation: "Unknown metric. Do not invent Gross - Refunds.",
      expectedSqlBehaviour: "undefined_metric refusal.",
      query: { metrics: ["net_revenue"] },
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "not defined" },
      guessSeverity: "critical",
    }),
    sc({
      id: "metrics/synonym-sales",
      category: "metrics",
      question: "Sales (synonym of Revenue).",
      interpretation: "Resolve synonym; same number as Revenue.",
      expectedSqlBehaviour: "Same SQL as revenue.",
      query: { metrics: ["sales"] },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "sql", sql: GOLD_SQL.revenueTotal } },
    }),
    sc({
      id: "metrics/semi-additive-balance",
      category: "metrics",
      question: "Account Balance (no date).",
      interpretation:
        "Semi-additive last-as-of: last snapshot per account, then SUM across accounts (1300, not 3400).",
      expectedSqlBehaviour: "Last snapshot per account_id via MAX(snapshot_date), then SUM(balance).",
      query: { metrics: ["account_balance"] },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.latestSnapshotBalance },
        sqlMustInclude: ["last_account_balance"],
      },
    }),
    sc({
      id: "metrics/conversion-disagreeing-time",
      category: "metrics",
      question: "Conversion rate last month.",
      interpretation:
        "Numerator time is completed_at, denominator is created_at. Each component is filtered on its own time_dimension.",
      expectedSqlBehaviour: "No shared outer time WHERE; FILTER (WHERE ...) per component time column.",
      query: { metrics: ["conversion_rate"], time: { period: "last_month" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.conversionLastMonth },
        sqlMustInclude: ["created_at", "completed_at"],
      },
    }),
    sc({
      id: "metrics/unknown-gmv",
      category: "ambiguity",
      question: "GMV.",
      interpretation: "No such metric. Similar names exist. Suggest, do not pick.",
      expectedSqlBehaviour: "undefined_metric.",
      query: { metrics: ["GMV"] },
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "unknown" },
    }),
  ];
}

function timeTraps(): Scenario[] {
  return [
    sc({
      id: "time/last-month",
      category: "time",
      question: "Revenue last month (anchored 15 Mar 2024, Europe/London).",
      interpretation: "February 2024 inclusive, on completed_at localised to London.",
      expectedSqlBehaviour: "Use completed_at, not created_at/paid_at. Inclusive Feb 1–29.",
      query: { metrics: ["revenue"], time: { period: "last_month" } },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueFebruaryLondon },
        sqlMustInclude: ["completed_at"],
        sqlMustNotInclude: ["created_at", "paid_at"],
      },
    }),
    sc({
      id: "time/utc-vs-london-month",
      category: "time",
      question: "Revenue in June 2024 vs July 2024 (London).",
      interpretation: "Order 15 is 30 Jun 23:30 UTC = 1 Jul 00:30 BST. Counts in July, not June.",
      expectedSqlBehaviour: "Localise completed_at to Europe/London before the range.",
      query: { metrics: ["revenue"], time: { from: "2024-06-01", to: "2024-06-30" } },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueJuneLondon },
      },
    }),
    sc({
      id: "time/july-london-includes-june-utc",
      category: "time",
      question: "Revenue in July 2024 (London).",
      interpretation: "Must include the 7 from order 15.",
      expectedSqlBehaviour: "July local range includes 30 Jun 23:30 UTC.",
      query: { metrics: ["revenue"], time: { from: "2024-07-01", to: "2024-07-31" } },
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueJulyLondon },
      },
    }),
    sc({
      id: "time/leap-day",
      category: "time",
      question: "Revenue on 29 Feb 2024.",
      interpretation: "Leap day order of 25 must be included.",
      expectedSqlBehaviour: "Inclusive date on completed_at.",
      query: { metrics: ["revenue"], time: { from: "2024-02-29", to: "2024-02-29" } },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 25 } },
    }),
    sc({
      id: "time/month-boundary-cancelled",
      category: "time",
      question: "Revenue on 31 Jan 2024.",
      interpretation: "Cancelled order at 23:59:59 is not revenue.",
      expectedSqlBehaviour: "Status filter still applies at the month boundary.",
      query: { metrics: ["revenue"], time: { from: "2024-01-31", to: "2024-01-31" } },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 0 } },
    }),
    sc({
      id: "time/wrong-timestamp-created-at",
      category: "time",
      question: "Revenue last month using created_at.",
      interpretation: "Governed Revenue time is completed_at. Switching to created_at is a different, ungoverned time axis.",
      expectedSqlBehaviour: "Execute on created_at with trust mixed, not governed.",
      query: { metrics: ["revenue"], time: { period: "last_month", dimension: "created_at" } },
      disposition: "EXPLORE",
      expectation: {
        kind: "explore",
        trust: "mixed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueFebruaryCreatedAt },
      },
    }),
    sc({
      id: "time/fiscal-year",
      category: "time",
      question: "Revenue this fiscal year (FY starts 1 April).",
      interpretation: "Now is 15 Mar 2024 in Europe/London; current FY started 2023-04-01.",
      expectedSqlBehaviour: "completed_at from 2023-04-01 through 2024-03-15 inclusive.",
      query: { metrics: ["revenue"], time: { period: "this_fiscal_year" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.revenueThisFiscalYear },
      },
    }),
  ];
}

function permissionTraps(): Scenario[] {
  const direct: Scenario[] = BLOCKED_COLUMNS.map((col) =>
    sc({
      id: `perm/raw-dim/${col.replace(".", "-")}`,
      category: "permissions",
      question: `Group by blocked ${col}.`,
      interpretation: "Excluded columns are never queryable.",
      expectedSqlBehaviour: "column_not_permitted. SQL must not mention the column.",
      prohibitedColumns: [col],
      query: { metrics: ["revenue"], raw_dimensions: [col] },
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked" },
      guessSeverity: "security",
    }),
  );
  return [
    ...direct,
    sc({
      id: "perm/filter-email",
      category: "permissions",
      question: "Revenue where email = alice@secret.example.",
      interpretation: "Filter on a blocked column.",
      expectedSqlBehaviour: "Refuse. Error must not echo the email value as a confirmed secret.",
      query: {
        metrics: ["revenue"],
        filters: [{ field: "customers.email", operator: "=", value: "alice@secret.example" }],
      },
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked filter" },
      guessSeverity: "security",
    }),
    sc({
      id: "perm/order-by-salary",
      category: "permissions",
      question: "Exploratory employee count ordered by salary.",
      interpretation: "ORDER BY blocked field.",
      expectedSqlBehaviour: "Refuse before SQL.",
      query: {
        raw_metrics: [{ field: "employees.id", type: "count" }],
        raw_dimensions: ["employees.salary"],
      },
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked order/group" },
      guessSeverity: "security",
    }),
    sc({
      id: "perm/secrets-schema",
      category: "permissions",
      question: "Count secrets.api_keys.",
      interpretation: "Schema not in exploration.schemas.",
      expectedSqlBehaviour: "Refuse. Never return sk_live token.",
      query: { raw_metrics: [{ field: "api_keys.token", type: "count" }] },
      expectation: {
        kind: "refuse",
        statuses: ["column_not_permitted", "undefined_column", "invalid_query"],
        reason: "blocked schema",
      },
      guessSeverity: "security",
    }),
    sc({
      id: "perm/catalog-email",
      category: "permissions",
      mode: "catalog",
      question: "Does catalog() list customers.email?",
      interpretation: "Blocked fields are not discoverable.",
      expectedSqlBehaviour: "Absent from exploration.columns.",
      expectation: { kind: "refuse", reason: "n/a" },
      custom: async (ctx) => {
        const catalog = JSON.parse(ctx.catalogText ?? "{}") as {
          exploration?: { columns?: Array<{ table: string; column: string }> };
        };
        const columns = catalog.exploration?.columns ?? [];
        const hits = columns.filter((c) =>
          ["email", "phone", "password_hash", "ip_address", "date_of_birth", "card_fingerprint", "salary"].includes(
            c.column,
          ),
        );
        if (hits.length > 0) {
          return {
            code: "SECURITY CRITICAL",
            detail: `catalog listed ${hits.map((h) => `${h.table}.${h.column}`).join(", ")} as explorable`,
          };
        }
        return { code: "PASS", detail: "blocked fields not in exploration.columns" };
      },
    }),
  ];
}

function explorationTraps(): Scenario[] {
  return [
    sc({
      id: "explore/mixed-discount",
      category: "exploration",
      question: "Revenue by raw discount_code.",
      interpretation: "Governed metric + raw dimension = mixed.",
      expectedSqlBehaviour: "Compile at order grain. trust mixed.",
      query: { metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] },
      expectation: { kind: "explore", trust: "mixed" },
    }),
    sc({
      id: "explore/raw-only",
      category: "exploration",
      question: "Count payments by status.",
      interpretation: "Raw metric + raw dimension = exploratory.",
      expectedSqlBehaviour: "No governed names. trust exploratory.",
      query: {
        raw_metrics: [{ field: "payments.id", type: "count" }],
        raw_dimensions: ["payments.status"],
      },
      expectation: { kind: "explore", trust: "exploratory" },
    }),
    sc({
      id: "explore/raw-channel-still-ungoverned",
      category: "trust",
      question: "Revenue grouped by raw orders.channel (also a governed dimension).",
      interpretation: "Requesting the column as raw_dimensions keeps it ungoverned.",
      expectedSqlBehaviour: "trust mixed, not governed.",
      query: { metrics: ["revenue"], raw_dimensions: ["orders.channel"] },
      expectation: { kind: "explore", trust: "mixed" },
    }),
    sc({
      id: "explore/disabled",
      category: "exploration",
      question: "Raw dimension while exploration is off.",
      interpretation: "Global kill switch.",
      expectedSqlBehaviour: "exploration_disabled.",
      config: (base) => ({ ...base, exploration: { ...base.exploration, enabled: false } }),
      query: { metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] },
      expectation: { kind: "refuse", statuses: ["exploration_disabled"], reason: "disabled" },
    }),
    sc({
      id: "explore/filter-raw-status",
      category: "trust",
      question: "Governed revenue with an exploratory filter on orders.device_type.",
      interpretation: "An exploratory filter must not leave trust at governed.",
      expectedSqlBehaviour: "trust mixed.",
      query: {
        metrics: ["revenue"],
        dimensions: ["channel"],
        filters: [{ field: "orders.device_type", operator: "=", value: "chrome" }],
      },
      expectation: { kind: "explore", trust: "mixed" },
    }),
  ];
}

function ambiguityTraps(): Scenario[] {
  return [
    sc({
      id: "ambig/country",
      category: "ambiguity",
      question: "Revenue by country.",
      interpretation: "Could mean customer, billing, shipping, or payment country. None named country.",
      expectedSqlBehaviour: "Refuse. Choosing one path is a guess.",
      query: { metrics: ["revenue"], dimensions: ["country"] },
      expectation: { kind: "refuse", statuses: ["undefined_dimension", "invalid_query"], reason: "ambiguous country" },
    }),
    sc({
      id: "ambig/countries-name-raw",
      category: "ambiguity",
      question: "Revenue by countries.name (raw).",
      interpretation: "Three safe paths: customer, billing, shipping. Order 1 is GB/US/FR.",
      expectedSqlBehaviour:
        "Refuse with ambiguous_query listing the paths. Suggest customer_country / billing_country / shipping_country. Do not BFS-pick.",
      query: { metrics: ["revenue"], raw_dimensions: ["countries.name"] },
      disposition: "CLARIFY",
      expectation: {
        kind: "refuse",
        statuses: ["ambiguous_query"],
        reason: "multiple paths to countries",
      },
    }),
    sc({
      id: "ambig/billing-vs-customer",
      category: "join",
      question: "Revenue by billing country (explicit).",
      interpretation: "Named dimension; order 1 is US billed, GB customer. Not a guess.",
      expectedSqlBehaviour: "Join billing_addresses, not customers.country.",
      query: { metrics: ["revenue"], dimensions: ["billing_country"] },
      mode: "compile",
      expectation: {
        kind: "execute",
        trust: "governed",
        sqlMustInclude: ["billing_addresses"],
        sqlMustNotInclude: ["customers"],
      },
    }),
  ];
}

function dirtyTraps(): Scenario[] {
  return [
    sc({
      id: "dirty/orphan-in-total",
      category: "dirty",
      question: "Revenue includes the orphan order with NULL customer_id.",
      interpretation: "No dimension: the 8 remains. Grane must not drop it.",
      expectedSqlBehaviour: "No customer join required.",
      query: { metrics: ["revenue"] },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: GOLD.revenueTotal } },
    }),
    sc({
      id: "dirty/negative-and-zero",
      category: "dirty",
      question: "Revenue includes 0 and -15 completed orders.",
      interpretation: "Completed is the contract; signs are the data's problem.",
      expectedSqlBehaviour: "SUM as written.",
      query: { metrics: ["revenue"] },
      expectation: { kind: "execute", trust: "governed", gold: { kind: "sql", sql: GOLD_SQL.revenueTotal } },
    }),
    sc({
      id: "dirty/empty-table",
      category: "dirty",
      question: "Count raw empty_events.",
      interpretation: "Empty table is a valid exploratory grain.",
      expectedSqlBehaviour: "Return 0, trust exploratory.",
      query: { raw_metrics: [{ field: "empty_events.id", type: "count" }] },
      expectation: { kind: "explore", trust: "exploratory", gold: { kind: "scalar", value: 0 } },
    }),
  ];
}

function provenanceTraps(): Scenario[] {
  return [
    sc({
      id: "prov/definition-version",
      category: "provenance",
      question: "Revenue provenance carries a definition version.",
      interpretation: "query_id, metric hash, generated SQL, trust must agree with execution.",
      expectedSqlBehaviour: "Provenance.metrics.revenue.definition_version is 8 hex chars.",
      query: { metrics: ["revenue"] },
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const result = await ctx.kernel.query({ metrics: ["revenue"] });
        const version = result.provenance.metrics["revenue"]?.definition_version;
        if (!version || !/^[a-f0-9]{8}$/.test(version)) {
          return { code: "FAIL", detail: `bad definition_version ${version}` };
        }
        if (result.provenance.trust !== result.trust) {
          return { code: "CRITICAL FAIL", detail: "provenance.trust disagrees with result.trust" };
        }
        if (!result.provenance.generated_sql.includes("net_amount")) {
          return { code: "CRITICAL FAIL", detail: "provenance SQL does not match the metric" };
        }
        if (!result.provenance.query_id.startsWith("q_")) {
          return { code: "FAIL", detail: "missing query_id" };
        }
        return { code: "PASS", detail: `version ${version}` };
      },
    }),
    sc({
      id: "prov/semantic-mutation",
      category: "semantic_mutation",
      question: "Change Revenue from completed-only to all statuses.",
      interpretation: "New definition, new hash, new number. No stale cache.",
      expectedSqlBehaviour: "Different SQL filter and different total.",
      query: { metrics: ["revenue"] },
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const v1 = await ctx.kernel.query({ metrics: ["revenue"] });
        const v1n = Number(Object.values(v1.rows[0] ?? {})[0]);
        const v1hash = v1.provenance.metrics["revenue"]?.definition_version;
        const schema = await ctx.kernel.loadSchema();
        const mutated = gauntletConfig({
          metrics: {
            ...gauntletConfig().metrics,
            revenue: {
              ...gauntletConfig().metrics["revenue"]!,
              filters: undefined,
            },
          },
        });
        const { GraneKernel } = await import("../../../src/kernel.js");
        const k2 = new GraneKernel(mutated, {
          schema,
          now: GAUNTLET_NOW,
          connector: ctx.kernel.getConnector(),
        });
        const v2 = await k2.query({ metrics: ["revenue"] });
        const v2n = Number(Object.values(v2.rows[0] ?? {})[0]);
        const v2hash = v2.provenance.metrics["revenue"]?.definition_version;
        if (v1hash === v2hash) {
          return { code: "CRITICAL FAIL", detail: "definition version did not change after mutation" };
        }
        if (v1n === v2n) {
          return { code: "CRITICAL FAIL", detail: "result did not change after dropping the status filter" };
        }
        if (v2n <= v1n) {
          return { code: "CRITICAL FAIL", detail: `unfiltered ${v2n} should exceed completed-only ${v1n}` };
        }
        return { code: "PASS", detail: `${v1n} @ ${v1hash} → ${v2n} @ ${v2hash}` };
      },
    }),
    sc({
      id: "det/compile-repeat",
      category: "determinism",
      mode: "compile",
      question: "10k identical compiles of revenue by channel.",
      interpretation: "Same SQL, params, trust, grain every time.",
      expectedSqlBehaviour: "Byte-identical SQL.",
      query: { metrics: ["revenue"], dimensions: ["channel"] },
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const query = { metrics: ["revenue"], dimensions: ["channel"] as string[] };
        const first = ctx.kernel.compile(query).compiled;
        for (let i = 0; i < 10_000; i += 1) {
          const next = ctx.kernel.compile(query).compiled;
          if (next.sql !== first.sql) {
            return { code: "CRITICAL FAIL", detail: `SQL drifted at iteration ${i}` };
          }
          if (JSON.stringify(next.params) !== JSON.stringify(first.params)) {
            return { code: "CRITICAL FAIL", detail: `params drifted at iteration ${i}` };
          }
          if (next.trust !== first.trust) {
            return { code: "CRITICAL FAIL", detail: `trust drifted at iteration ${i}` };
          }
        }
        return { code: "PASS", detail: "10000 identical compiles" };
      },
    }),
  ];
}

function readonlyTraps(): Scenario[] {
  const verbs = [
    "INSERT INTO customers VALUES (99, 'x')",
    "UPDATE orders SET net_amount = 0",
    "DELETE FROM customers",
    "DROP TABLE customers",
    "ALTER TABLE orders ADD COLUMN pwned INTEGER",
    "CREATE TABLE pwned (id INTEGER)",
    "TRUNCATE TABLE orders",
    "GRANT ALL ON orders TO PUBLIC",
    "REVOKE SELECT ON orders FROM PUBLIC",
    "COPY orders TO '/tmp/x'",
    "CALL bogus()",
    "EXECUTE bogus",
  ];
  return verbs.map((sql) =>
    sc({
      id: `readonly/${sql.slice(0, 24).replace(/\s+/g, "-").toLowerCase()}`,
      category: "readonly",
      mode: "custom",
      question: `Execute ${sql}`,
      interpretation: "Grane execution layer is read-only.",
      expectedSqlBehaviour: "Refuse the statement. Table still intact.",
      expectation: { kind: "refuse", reason: "write" },
      guessSeverity: "security",
      custom: async (ctx) => {
        const result = await tryExecuteRawSql(ctx.kernel.getConnector(), sql, ctx.kernel.config.limits);
        if (result.ok) {
          return { code: "SECURITY CRITICAL", detail: `write executed: ${sql}` };
        }
        return { code: "PASS — SAFE REFUSAL", detail: result.message };
      },
    }),
  );
}

function agentTraps(): Scenario[] {
  const intern = toGrant({
    id: "intern",
    token: "intern-token",
    metrics: ["revenue"],
    dimensions: ["channel"],
    exploration: false,
  });
  return [
    sc({
      id: "cache/intern-cannot-use-customers",
      category: "cache",
      question: "Intern asks for Customers after analyst could.",
      interpretation: "No result cache may leak a permitted answer to a blocked agent.",
      expectedSqlBehaviour: "undefined_metric for intern.",
      agent: intern,
      query: { metrics: ["customers"] },
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "allow-list" },
      guessSeverity: "security",
    }),
    sc({
      id: "cache/intern-no-exploration",
      category: "cache",
      question: "Intern requests a raw dimension.",
      interpretation: "Per-agent exploration=false.",
      expectedSqlBehaviour: "exploration_disabled.",
      agent: intern,
      query: { metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] },
      expectation: { kind: "refuse", statuses: ["exploration_disabled"], reason: "agent grant" },
      guessSeverity: "security",
    }),
  ];
}
