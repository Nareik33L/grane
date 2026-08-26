/**
 * Metamorphic / property scenarios.
 *
 * These assert invariants that must hold even when we do not hand-write
 * every numeric result: reorder, equivalent windows, compile identity,
 * unused schema, blocked SQL, trust, writes, ambiguity.
 */

import { GOLD_SQL, tablesMatchScalar } from "../gold.js";
import { revenueInInclusiveRange } from "../data.js";
import { isWriteSql, sqlContainsBlockedColumn } from "../sql-invariants.js";
import type { Scenario } from "../types.js";
import { GraneError } from "../../../src/errors.js";

function sc(partial: Scenario): Scenario {
  return { mode: "custom", guessSeverity: "critical", ...partial };
}

function firstMetric(rows: Record<string, unknown>[] | undefined, name: string): number | null {
  const value = rows?.[0]?.[name];
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rowKey(row: Record<string, unknown>, dims: string[]): string {
  return dims.map((d) => String(row[d])).join("\u0001");
}

export function metamorphicTraps(): Scenario[] {
  return [
    sc({
      id: "meta/filter-reorder-execute",
      category: "equivalent",
      question: "Reordering two filters must not change last-month GB web revenue.",
      interpretation: "Filter conjunction is commutative. Independent February gold still applies.",
      expectedSqlBehaviour: "Same numeric result both orders.",
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const a = {
          metrics: ["revenue"],
          filters: [
            { field: "customer_country", operator: "=" as const, value: "GB" },
            { field: "channel", operator: "=" as const, value: "web" },
          ],
          time: { period: "last_month" },
        };
        const b = {
          metrics: ["revenue"],
          filters: [a.filters[1]!, a.filters[0]!],
          time: { period: "last_month" },
        };
        const left = await ctx.kernel.query(a);
        const right = await ctx.kernel.query(b);
        const lv = firstMetric(left.rows, "revenue");
        const rv = firstMetric(right.rows, "revenue");
        if (lv == null || rv == null || !tablesMatchScalar(lv, rv)) {
          return { code: "CRITICAL FAIL", detail: `filter order ${String(lv)} vs ${String(rv)}` };
        }
        const gold = await ctx.kernel.getConnector().query(GOLD_SQL.revenueFebruaryWebGb, [], {
          max_rows: 10,
          default_rows: 10,
          timeout_ms: 10000,
        });
        const g = Number(gold.rows[0]?.["v"]);
        if (!tablesMatchScalar(lv, g)) {
          return { code: "CRITICAL FAIL", detail: `reordered ${lv} !== gold SQL ${g}` };
        }
        return { code: "PASS", detail: `both ${lv}` };
      },
    }),
    sc({
      id: "meta/last-month-equals-explicit-february",
      category: "equivalent",
      question: "last_month ≡ 2024-02-01..2024-02-29 for Revenue.",
      interpretation: "Equivalent time ranges must produce equivalent results. Clock is 15 Mar 2024 London.",
      expectedSqlBehaviour: "Same completed_at window.",
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const period = await ctx.kernel.query({ metrics: ["revenue"], time: { period: "last_month" } });
        const range = await ctx.kernel.query({
          metrics: ["revenue"],
          time: { from: "2024-02-01", to: "2024-02-29" },
        });
        const pv = firstMetric(period.rows, "revenue");
        const rv = firstMetric(range.rows, "revenue");
        const gold = revenueInInclusiveRange("2024-02-01", "2024-02-29");
        if (pv == null || rv == null || !tablesMatchScalar(pv, rv) || !tablesMatchScalar(pv, gold)) {
          return { code: "CRITICAL FAIL", detail: `period ${String(pv)} range ${String(rv)} gold ${gold}` };
        }
        return { code: "PASS", detail: `both ${pv}` };
      },
    }),
    sc({
      id: "meta/dim-order-rowset",
      category: "equivalent",
      question: "channel,country vs country,channel must be the same row multiset.",
      interpretation: "Dimension order may change SELECT/ORDER BY, not the facts.",
      expectedSqlBehaviour: "Matching (channel, country) → revenue maps.",
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const a = await ctx.kernel.query({
          metrics: ["revenue"],
          dimensions: ["channel", "customer_country"],
        });
        const b = await ctx.kernel.query({
          metrics: ["revenue"],
          dimensions: ["customer_country", "channel"],
        });
        const map = (rows: Record<string, unknown>[]) => {
          const out = new Map<string, number>();
          for (const row of rows) {
            out.set(rowKey(row, ["channel", "customer_country"]), Number(row["revenue"]));
          }
          return out;
        };
        const left = map(a.rows);
        const right = map(b.rows);
        if (left.size !== right.size) {
          return { code: "CRITICAL FAIL", detail: `row counts ${left.size} vs ${right.size}` };
        }
        for (const [key, value] of left) {
          const other = right.get(key);
          if (other == null || !tablesMatchScalar(value, other)) {
            return { code: "CRITICAL FAIL", detail: `${key} ${value} vs ${String(other)}` };
          }
        }
        return { code: "PASS", detail: `${left.size} matching groups` };
      },
    }),
    sc({
      id: "meta/compile-identity",
      category: "determinism",
      question: "Repeated compilation of identical semantic input yields the same plan.",
      interpretation: "SQL, params, trust, and plan columns must be byte-stable.",
      expectedSqlBehaviour: "Identical compiled.sql / params / trust.",
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const input = {
          metrics: ["conversion_rate"],
          dimensions: ["channel"],
          time: { period: "last_month" },
        };
        const first = ctx.kernel.compile(input).compiled;
        for (let i = 0; i < 25; i += 1) {
          const next = ctx.kernel.compile(input).compiled;
          if (next.sql !== first.sql) return { code: "CRITICAL FAIL", detail: `SQL drifted at ${i}` };
          if (JSON.stringify(next.params) !== JSON.stringify(first.params)) {
            return { code: "CRITICAL FAIL", detail: `params drifted at ${i}` };
          }
          if (next.trust !== first.trust) return { code: "CRITICAL FAIL", detail: `trust drifted at ${i}` };
          if (JSON.stringify(next.plan.columns) !== JSON.stringify(first.plan.columns)) {
            return { code: "CRITICAL FAIL", detail: `plan drifted at ${i}` };
          }
        }
        return { code: "PASS", detail: "25 identical compiles" };
      },
    }),
    sc({
      id: "meta/unused-table-does-not-change-plan",
      category: "schema_mutation",
      question: "Adding an unrelated warehouse table must not change an existing query plan.",
      interpretation: "Schema noise is not a semantic input.",
      expectedSqlBehaviour: "Identical SQL before and after the extra table.",
      disposition: "EXECUTE",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const input = { metrics: ["revenue"], dimensions: ["channel"], time: { period: "last_month" } };
        const before = ctx.kernel.compile(input).compiled.sql;
        const schema = structuredClone(await ctx.kernel.loadSchema());
        schema.tables.push({
          schema: schema.schemaName,
          name: "unrelated_noise_table",
          columns: [{ name: "id", dataType: "integer", nullable: false }],
        });
        ctx.kernel.setSchema(schema);
        try {
          const after = ctx.kernel.compile(input).compiled.sql;
          if (before !== after) {
            return { code: "CRITICAL FAIL", detail: "unused table changed generated SQL" };
          }
          return { code: "PASS", detail: "plan unchanged" };
        } finally {
          const restored = structuredClone(schema);
          restored.tables = restored.tables.filter((t) => t.name !== "unrelated_noise_table");
          ctx.kernel.setSchema(restored);
        }
      },
    }),
    sc({
      id: "meta/blocked-never-in-sql",
      category: "permissions",
      question: "A blocked field must never appear in generated SQL, even on a refused compile.",
      interpretation: "column_not_permitted is not enough if the SQL already named the column.",
      expectedSqlBehaviour: "No customers.email in SQL.",
      disposition: "REFUSE_POLICY",
      guessSeverity: "security",
      expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked" },
      custom: async (ctx) => {
        try {
          const compiled = ctx.kernel.compile({
            metrics: ["revenue"],
            filters: [{ field: "customers.email", operator: "=", value: "x" }],
          });
          if (sqlContainsBlockedColumn(compiled.compiled.sql).length) {
            return { code: "SECURITY CRITICAL", detail: "blocked column reached SQL" };
          }
          return { code: "SECURITY CRITICAL", detail: "blocked filter compiled" };
        } catch (err) {
          if (err instanceof GraneError) {
            return { code: "PASS — POLICY", detail: err.refusal.status };
          }
          return { code: "FAIL", detail: String(err) };
        }
      },
    }),
    sc({
      id: "meta/explore-never-governed",
      category: "trust",
      question: "Exploratory components must never result in GOVERNED trust.",
      interpretation: "Revenue + raw discount_code is mixed. Labelling it governed is a trust bug.",
      expectedSqlBehaviour: "trust mixed.",
      disposition: "EXPLORE",
      expectation: { kind: "explore", trust: "mixed" },
      custom: async (ctx) => {
        const { compiled, resolved } = ctx.kernel.compile({
          metrics: ["revenue"],
          raw_dimensions: ["orders.discount_code"],
        });
        if (compiled.trust === "governed" || resolved.trust === "governed") {
          return { code: "CRITICAL FAIL", detail: "exploratory labelled governed" };
        }
        if (compiled.trust !== "mixed") {
          return { code: "CRITICAL FAIL", detail: `trust ${compiled.trust}` };
        }
        return { code: "PASS — EXPLORATORY", detail: compiled.trust };
      },
    }),
    sc({
      id: "meta/unsafe-path-never-executes",
      category: "grain",
      question: "Unsafe relationship paths must never execute.",
      interpretation: "Revenue by product_category is a fan-out. A number here is a silent double-count.",
      expectedSqlBehaviour: "unsafe_query. No SQL execution.",
      disposition: "REFUSE_SAFETY",
      expectation: { kind: "refuse", statuses: ["unsafe_query"], reason: "fan-out" },
      custom: async (ctx) => {
        try {
          const result = await ctx.kernel.query({
            metrics: ["revenue"],
            dimensions: ["product_category"],
          });
          return {
            code: "CRITICAL FAIL",
            detail: `unsafe path executed (${result.rows.length} rows, trust ${result.trust})`,
          };
        } catch (err) {
          if (err instanceof GraneError && err.refusal.status === "unsafe_query") {
            return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
          }
          if (err instanceof GraneError) {
            return { code: "FAIL", detail: `refused as ${err.refusal.status}` };
          }
          return { code: "FAIL", detail: String(err) };
        }
      },
    }),
    sc({
      id: "meta/writes-never-generated",
      category: "readonly",
      question: "Write operations must never be generated from a semantic query.",
      interpretation: "Even a hostile metric name is not a license to emit INSERT/UPDATE/DELETE.",
      expectedSqlBehaviour: "undefined_metric / invalid_query, and if SQL exists it is SELECT.",
      disposition: "INVALID",
      guessSeverity: "security",
      expectation: { kind: "refuse", reason: "write" },
      custom: async (ctx) => {
        const attempts: Array<Record<string, unknown>> = [
          { metrics: ["revenue; DROP TABLE customers;"] },
          { metrics: ["revenue"], raw_dimensions: ["orders.channel; DELETE FROM orders"] },
          { raw_metrics: [{ field: "orders.id", type: "count" }] },
        ];
        for (const input of attempts) {
          try {
            const { compiled } = ctx.kernel.compile(input as never);
            if (isWriteSql(compiled.sql)) {
              return { code: "SECURITY CRITICAL", detail: `write SQL: ${compiled.sql.slice(0, 120)}` };
            }
          } catch (err) {
            if (!(err instanceof GraneError)) return { code: "FAIL", detail: String(err) };
          }
        }
        return { code: "PASS — INVALID", detail: "no write SQL" };
      },
    }),
    sc({
      id: "meta/ambiguity-never-guessed",
      category: "ambiguity",
      question: "Ambiguous countries.name must not be resolved by BFS-guessing a path.",
      interpretation: "Three safe paths. Guessing would silently pick customer vs billing vs shipping.",
      expectedSqlBehaviour: "ambiguous_query listing alternatives.",
      disposition: "CLARIFY",
      expectation: { kind: "refuse", statuses: ["ambiguous_query"], reason: "countries.name" },
      custom: async (ctx) => {
        try {
          const result = await ctx.kernel.query({
            metrics: ["revenue"],
            raw_dimensions: ["countries.name"],
          });
          return {
            code: "CRITICAL FAIL",
            detail: `guessed a path and executed (${result.rows.length} rows)`,
          };
        } catch (err) {
          if (err instanceof GraneError && err.refusal.status === "ambiguous_query") {
            return { code: "PASS — CLARIFY", detail: err.refusal.message };
          }
          if (err instanceof GraneError) {
            return { code: "FAIL", detail: `refused as ${err.refusal.status} instead of ambiguous_query` };
          }
          return { code: "FAIL", detail: String(err) };
        }
      },
    }),
  ];
}
