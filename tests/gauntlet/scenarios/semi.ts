/**
 * Adversarial last-as-of coverage for semi-additive metrics.
 *
 * Ground truth is tests/gauntlet/data.ts (TypeScript reductions) plus
 * independent SQL in gold.ts. Grane does not supply expected numbers.
 *
 * Last-as-of without a time grain: last civil snapshot on or before the
 * inclusive period end, including rows before the period start (carry-forward).
 * Last-as-of with a time grain: last snapshot inside each grain bucket only.
 */

import { GOLD_SQL } from "../gold.js";
import { lastAsOfByAccountName, lastAsOfTotal } from "../data.js";
import { tablesMatchScalar } from "../gold.js";
import type { Scenario, Verdict } from "../types.js";
import { toGrant } from "../../../src/auth/agents.js";

function sc(partial: Scenario): Scenario {
  return { mode: "execute", guessSeverity: "critical", ...partial };
}

function matchByAccount(rows: Record<string, unknown>[] | null, asOf: string, windowFrom?: string): Verdict {
  const expected = lastAsOfByAccountName(asOf, windowFrom);
  const actual = new Map<string, number | null>();
  for (const row of rows ?? []) {
    const name = String(row["account_name"]);
    const value = row["account_balance"];
    actual.set(name, value == null ? null : Number(value));
  }
  for (const [name, gold] of expected) {
    const got = actual.get(name);
    if (gold == null) {
      if (got != null && Number.isFinite(got)) {
        return { code: "CRITICAL FAIL", detail: `${name} last-as-of ${got} but gold is NULL` };
      }
      continue;
    }
    if (got == null || !tablesMatchScalar(got, gold)) {
      return { code: "CRITICAL FAIL", detail: `${name} last-as-of ${String(got)} !== ${gold}` };
    }
  }
  return { code: "PASS", detail: `last-as-of ${asOf} by account matches fixture` };
}

export function semiAdditiveTraps(): Scenario[] {
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

  return [
    sc({
      id: "semi/unbounded-not-naive-sum",
      category: "metrics",
      question: "Account Balance across all snapshot history.",
      interpretation: `Last row per account then SUM = ${lastAsOfTotal("9999-12-31")}, never SUM of every snapshot.`,
      expectedSqlBehaviour: "last_account_balance CTE; MAX(snapshot_date) per account_id.",
      query: { metrics: ["account_balance"] },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.latestSnapshotBalance },
        sqlMustInclude: ["last_account_balance"],
        sqlMustNotInclude: ["account_members"],
      },
    }),
    sc({
      id: "semi/as-of-single-day",
      category: "metrics",
      question: "Account Balance as of 1 Mar 2024.",
      interpretation:
        "Last civil snapshot on or before 1 Mar. Acme 1000, Globex carries 350 from 31 Jan, ClosedCo 200, NullCo 10. Initech/TwinCo/DstCo have no row yet.",
      expectedSqlBehaviour: "Last-as-of end date; carry-forward before from.",
      query: { metrics: ["account_balance"], time: { from: "2024-03-01", to: "2024-03-01" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar1 },
      },
    }),
    sc({
      id: "semi/as-of-before-globex-march",
      category: "metrics",
      question: "Account Balance as of 14 Mar 2024.",
      interpretation:
        "Globex has no March row until the 15th, so 31 Jan 350 carries. Acme last is 2 Mar 1100. Initech 50 (created 10 Mar). TwinCo/DstCo still absent.",
      expectedSqlBehaviour: "Missing snapshots carry the prior last row, not zero, and not a guess.",
      query: { metrics: ["account_balance"], time: { from: "2024-03-01", to: "2024-03-14" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar14 },
      },
    }),
    sc({
      id: "semi/as-of-period-end",
      category: "metrics",
      question: "Account Balance as of 15 Mar 2024 (clock date).",
      interpretation: "Includes 15 Mar rows: Acme 900, Globex 400, Initech 75, NullCo NULL (omitted from SUM), TwinCo 30+70.",
      expectedSqlBehaviour: "Inclusive civil end date.",
      query: { metrics: ["account_balance"], time: { from: "2024-01-01", to: "2024-03-15" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar15 },
      },
    }),
    sc({
      id: "semi/last-month-carry-forward",
      category: "metrics",
      question: "Account Balance last month (February 2024), no grain.",
      interpretation:
        "As-of 29 Feb: Acme leap-day 850, Globex Jan 31 350 carries into February, ClosedCo 200. Initech does not exist yet.",
      expectedSqlBehaviour: "Period end last-as-of; do not require the snapshot to fall inside February.",
      query: { metrics: ["account_balance"], time: { period: "last_month" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotLastMonthCarry },
      },
    }),
    sc({
      id: "semi/last-month-grain-in-window",
      category: "metrics",
      question: "Account Balance last month by month grain.",
      interpretation:
        "Grain buckets do not carry from before the bucket. Globex's 31 Jan row is outside February, so Globex is omitted. Acme 850 + ClosedCo 200.",
      expectedSqlBehaviour: "CTE filters snapshot_date >= period start when grain is set.",
      query: { metrics: ["account_balance"], time: { period: "last_month", grain: "month" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "scalar", value: lastAsOfTotal("2024-02-29", "2024-02-01"), column: "account_balance" },
      },
    }),
    sc({
      id: "semi/empty-window",
      category: "metrics",
      question: "Account Balance in 2020 (no snapshots).",
      interpretation: "No snapshot on or before 2020-12-31. SUM is NULL/0, never a guessed later balance.",
      expectedSqlBehaviour: "Empty last-as-of set.",
      query: { metrics: ["account_balance"], time: { from: "2020-01-01", to: "2020-12-31" } },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "sql", sql: GOLD_SQL.snapshotEmptyYear } },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        const value = ctx.rows?.[0]?.["account_balance"];
        if (value != null && Number(value) !== 0) {
          return { code: "CRITICAL FAIL", detail: `empty window returned ${String(value)}` };
        }
        return { code: "PASS", detail: "no snapshots in 2020" };
      },
    }),
    sc({
      id: "semi/null-last-balance-omitted-from-sum",
      category: "metrics",
      question: "Account Balance including NullCo's NULL last snapshot.",
      interpretation: "SQL SUM skips NULL. NullCo must not become 0 via COALESCE unless documented, and must not fall back to 10.",
      expectedSqlBehaviour: "NULL last snapshot does not contribute and does not revive the prior non-null row.",
      query: { metrics: ["account_balance"], time: { from: "2024-03-15", to: "2024-03-15" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar15 },
      },
    }),
    sc({
      id: "semi/same-day-duplicates-summed",
      category: "dirty",
      question: "TwinCo has two snapshots on 15 Mar.",
      interpretation:
        "Same (account_id, snapshot_date) rows are all last-as-of rows. SUM them (30+70=100). Do not pick one arbitrarily.",
      expectedSqlBehaviour: "JOIN on MAX(date) includes every row at that date.",
      query: {
        metrics: ["account_balance"],
        dimensions: ["account_name"],
        filters: [{ field: "account_name", operator: "=", value: "TwinCo" }],
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotTwinCoLatest },
      },
    }),
    sc({
      id: "semi/group-by-account",
      category: "metrics",
      question: "Account Balance by account name (unbounded).",
      interpretation: "Last-as-of per account_id, then group by accounts.name. Many-to-one, no fan-out.",
      expectedSqlBehaviour: "JOIN accounts; last CTE still keyed by account_id.",
      query: { metrics: ["account_balance"], dimensions: ["account_name"] },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        return matchByAccount(ctx.rows, "9999-12-31");
      },
    }),
    sc({
      id: "semi/group-by-account-as-of",
      category: "metrics",
      question: "Account Balance by account as of 14 Mar 2024.",
      interpretation: "Same grouping after a range last-as-of. ClosedCo still 200; Globex still 350; DstCo absent.",
      expectedSqlBehaviour: "Filter last-as-of then group.",
      query: {
        metrics: ["account_balance"],
        dimensions: ["account_name"],
        time: { from: "2024-01-01", to: "2024-03-14" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        return matchByAccount(ctx.rows, "2024-03-14");
      },
    }),
    sc({
      id: "semi/filter-one-account",
      category: "metrics",
      question: "Account Balance for Acme only.",
      interpretation: "Outer filter on account_name after last-as-of. Acme last is 900, not 1000+1100+900.",
      expectedSqlBehaviour: "WHERE accounts.name = Acme; last CTE still per account.",
      query: {
        metrics: ["account_balance"],
        filters: [{ field: "account_name", operator: "=", value: "Acme" }],
      },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAcmeLatest },
      },
    }),
    sc({
      id: "semi/entity-created-mid-period",
      category: "metrics",
      question: "Initech created 10 Mar; balance as of 14 Mar.",
      interpretation: "An entity with no history before creation contributes its first snapshot, not zero and not a sibling account.",
      expectedSqlBehaviour: "Initech 50 in the 14 Mar as-of set.",
      query: {
        metrics: ["account_balance"],
        dimensions: ["account_name"],
        filters: [{ field: "account_name", operator: "=", value: "Initech" }],
        time: { from: "2024-03-01", to: "2024-03-14" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 50, column: "account_balance" } },
    }),
    sc({
      id: "semi/entity-deleted-no-march",
      category: "metrics",
      question: "ClosedCo has no March snapshot; as-of 15 Mar.",
      interpretation: "Carry 28 Feb 200 into March. Do not drop a closed entity unless the query grain-windows the snapshot.",
      expectedSqlBehaviour: "ClosedCo 200 as of 15 Mar without a March row.",
      query: {
        metrics: ["account_balance"],
        dimensions: ["account_name"],
        filters: [{ field: "account_name", operator: "=", value: "ClosedCo" }],
        time: { from: "2024-03-01", to: "2024-03-15" },
      },
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed", gold: { kind: "scalar", value: 200, column: "account_balance" } },
    }),
    sc({
      id: "semi/dst-spring-civil-date",
      category: "time",
      question: "Account Balance as of 31 Mar 2024 (UK clocks forward).",
      interpretation:
        "snapshot_date is a civil DATE. 31 Mar is a real calendar day. DstCo 110. Timezone conversion must not shift the DATE backward.",
      expectedSqlBehaviour: "Compare DATE to DATE, not timestamptz-localised midnight.",
      query: { metrics: ["account_balance"], time: { from: "2024-03-01", to: "2024-03-31" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotDstSpring },
      },
    }),
    sc({
      id: "semi/dst-autumn-civil-date",
      category: "time",
      question: "Account Balance as of 27 Oct 2024 (UK clocks back).",
      interpretation: "Civil 27 Oct is DstCo's last snapshot (130). A 25-hour civil day must not double-count.",
      expectedSqlBehaviour: "One last-as-of row per account on 27 Oct.",
      query: { metrics: ["account_balance"], time: { from: "2024-10-01", to: "2024-10-27" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotDstAutumn },
      },
    }),
    sc({
      id: "semi/timezone-new-york-civil-date",
      category: "time",
      question: "Account Balance as of 1 Mar 2024 in America/New_York.",
      interpretation:
        "DATE snapshots are civil dates, not midnight UTC. A 1 Mar row must not become 29 Feb in US Eastern, and a 2 Mar row must not leak into 1 Mar.",
      expectedSqlBehaviour: "Same last-as-of as Europe/London for DATE columns.",
      config: (base) => ({
        ...base,
        project: { ...base.project, timezone: "America/New_York" },
      }),
      query: { metrics: ["account_balance"], time: { from: "2024-03-01", to: "2024-03-01" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotAsOfMar1 },
      },
    }),
    sc({
      id: "semi/explore-account-country",
      category: "exploration",
      question: "Account Balance by raw accounts.country.",
      interpretation: "Many-to-one to accounts. Mixed trust. Last-as-of still applies. US = Acme 900 + NullCo NULL.",
      expectedSqlBehaviour: "trust mixed; JOIN accounts; last CTE preserved.",
      query: { metrics: ["account_balance"], raw_dimensions: ["accounts.country"] },
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String(ctx.error) };
        if (ctx.trust === "governed") {
          return { code: "CRITICAL FAIL", detail: "raw accounts.country labelled governed" };
        }
        const gb = Number(ctx.rows?.find((r) => r["country"] === "GB" || r["accounts.country"] === "GB")?.["account_balance"]);
        const expectedGb =
          (lastAsOfByAccountName("9999-12-31").get("Globex") ?? 0) +
          (lastAsOfByAccountName("9999-12-31").get("TwinCo") ?? 0);
        if (!tablesMatchScalar(gb, expectedGb)) {
          return { code: "CRITICAL FAIL", detail: `GB last-as-of ${gb} !== ${expectedGb}` };
        }
        return { code: "PASS — EXPLORATORY", detail: `trust ${ctx.trust}` };
      },
    }),
    sc({
      id: "semi/fan-out-via-members",
      category: "grain",
      question: "Account Balance by customer country via account_members.",
      interpretation: "accounts → members is one_to_many. Last-as-of must not start guessing a customer path.",
      expectedSqlBehaviour: "unsafe_query. Never double-count Alice's two memberships.",
      query: { metrics: ["account_balance"], dimensions: ["customer_country"] },
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "member fan-out" },
    }),
    sc({
      id: "semi/intern-cannot-read-balance",
      category: "permissions",
      question: "Intern asks for Account Balance.",
      interpretation: "account_balance is not on the intern allow-list.",
      expectedSqlBehaviour: "undefined_metric / policy refusal. No SQL.",
      agent: intern,
      guessSeverity: "security",
      query: { metrics: ["account_balance"] },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "allow-list" },
    }),
    sc({
      id: "semi/analyst-cannot-read-balance",
      category: "permissions",
      question: "Analyst asks for Account Balance.",
      interpretation: "Analyst allow-list is revenue/orders/AOV, not snapshots.",
      expectedSqlBehaviour: "undefined_metric.",
      agent: analyst,
      guessSeverity: "security",
      query: { metrics: ["account_balance"] },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["undefined_metric"], reason: "allow-list" },
    }),
    sc({
      id: "semi/blocked-column-still-blocked",
      category: "permissions",
      question: "Account Balance by customers.email.",
      interpretation: "Semi-additive execution does not bypass the exclude list.",
      expectedSqlBehaviour: "column_not_permitted.",
      prohibitedColumns: ["customers.email"],
      guessSeverity: "security",
      query: { metrics: ["account_balance"], raw_dimensions: ["customers.email"] },
      disposition: "REFUSE_POLICY",
      expectation: { kind: "refuse", statuses: ["column_not_permitted", "unsafe_query"], reason: "blocked" },
    }),
    sc({
      id: "semi/leap-day-snapshot",
      category: "time",
      question: "Account Balance as of 29 Feb 2024.",
      interpretation: "Leap-day snapshot 850 for Acme is a real civil date.",
      expectedSqlBehaviour: "Inclusive 2024-02-29.",
      query: { metrics: ["account_balance"], time: { from: "2024-02-29", to: "2024-02-29" } },
      disposition: "EXECUTE",
      expectation: {
        kind: "execute",
        trust: "governed",
        gold: { kind: "sql", sql: GOLD_SQL.snapshotLastMonthCarry },
      },
    }),
  ];
}
