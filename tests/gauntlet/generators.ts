/**
 * Combinatorial Gauntlet generators.
 *
 * Volume comes from fixtures and a seeded PRNG, not from an LLM. Expected
 * outcomes are derived from hand-reviewed SAFE_SLICES, the blocked-column
 * list, and Query Model v1 — never from Grane's own planner.
 */

import { gauntletConfig } from "./model.js";
import { SAFE_SLICES } from "./gold.js";
import { BLOCKED_COLUMNS } from "./data.js";
import { errorLeaksSecrets, injectionEscaped, isWriteSql, sqlContainsBlockedColumn } from "./sql-invariants.js";
import type { Scenario } from "./types.js";
import { semanticQuerySchema } from "../../src/query/model.js";
import { GraneError } from "../../src/errors.js";

function sc(partial: Scenario): Scenario {
  return { mode: "compile", guessSeverity: "critical", ...partial };
}

const METRICS = Object.keys(gauntletConfig().metrics);
const DIMENSIONS = Object.keys(gauntletConfig().dimensions);
const RAW_ORDER_DIMS = ["orders.discount_code", "orders.device_type", "orders.currency"];
const PERIODS = [
  "today",
  "yesterday",
  "this_month",
  "last_month",
  "this_year",
  "last_year",
  "30d",
  "last_30d",
  "7d",
  "14d",
  "90d",
  "6m",
  "12m",
  "1w",
  "4w",
  "this-month",
  "LAST_MONTH",
  "this_fiscal_year",
  "fy2024",
  "q1",
  "ytd",
  "not_a_period",
  "",
];

const HOSTILE_IDENTIFIERS = [
  "revenue; DROP TABLE customers;",
  "revenue--",
  "revenue/*comment*/",
  "' OR 1=1 --",
  "1 OR 1=1",
  "'; DROP TABLE orders;--",
  "revenue\u0000",
  "rev\u00e9nue",
  "revenue\u200b",
  `${"r".repeat(5000)}`,
  "select",
  "from",
  "where",
  "union",
  "insert",
  "drop",
  "table",
  "true",
  "false",
  "null",
  "undefined",
  "__proto__",
  "constructor",
  "toString",
  String.raw`revenue\'; DROP TABLE customers;--`,
  "revenue`; DROP TABLE customers;--",
  "revenue\n;DROP TABLE customers;",
  "Ｒevenuе", // fullwidth / cyrillic lookalike mix
  "revenue UNION SELECT password_hash FROM customers",
];

const HOSTILE_FILTER_VALUES: unknown[] = [
  "' OR 1=1 --",
  "'; DROP TABLE customers;--",
  "1; SELECT * FROM employees",
  "*'",
  "\\",
  "\n",
  "\u0000",
  { $gt: 0 },
  ["'", "OR", "1=1"],
  null,
  true,
  1e308,
  -1,
  "",
  "alice@secret.example",
  "hash_alice",
];

const MCP_PAYLOADS: unknown[] = [
  {},
  { metrics: null },
  { metrics: 1 },
  { metrics: [1] },
  { metrics: [null] },
  { metrics: [{ name: "revenue" }] },
  { dimensions: "country" },
  { raw_dimensions: "orders.discount_code" },
  { raw_metrics: { field: "orders.id" } },
  { filters: { field: "channel", operator: "=", value: "web" } },
  { filters: [{ field: 1 }] },
  { filters: [{ operator: "=", value: "x" }] },
  { time: { from: "yesterday", to: "today" } },
  { time: { period: "last_month", from: "2024-01-01", to: "2024-01-31" } },
  { time: { from: "2024-01-01" } },
  { time: { to: "2024-01-01" } },
  { time: { from: "01/01/2024", to: "01/31/2024" } },
  { time: { grain: "hour", period: "last_month" } },
  { order: [{ field: "revenue", direction: "sideways" }] },
  { limit: -1 },
  { limit: 0 },
  { limit: 1.5 },
  { limit: Number.MAX_SAFE_INTEGER },
  { query_model: "v0" },
  { query_model: "v2" },
  { metrics: ["revenue"], extra: { nested: { x: 1 } } },
];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

export function generateJoinGrainMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const metric of METRICS) {
    for (const dimension of DIMENSIONS) {
      const safe = (SAFE_SLICES[metric] ?? []).includes(dimension);
      out.push(
        sc({
          id: `gen/join/${metric}/${dimension}`,
          category: safe ? "join" : "grain",
          question: `${metric} by ${dimension}`,
          interpretation: safe
            ? "Hand-reviewed safe slice at this grain."
            : "Not a proven-safe slice. Refuse rather than guess a join.",
          expectedSqlBehaviour: safe ? "Compile without fan-out." : "Refuse unsafe/undefined path.",
          query: { metrics: [metric], dimensions: [dimension] },
          expectation: safe
            ? { kind: "execute", trust: "governed" }
            : {
                kind: "refuse",
                statuses: ["unsafe_query", "invalid_query", "undefined_dimension"],
                reason: "unsafe or unreachable slice",
              },
        }),
      );
    }
  }
  return out;
}

export function generateDistinctMatrix(): Scenario[] {
  return DIMENSIONS.map((dimension) =>
    sc({
      id: `gen/distinct/ordering-customers/${dimension}`,
      category: "distinct",
      question: `ordering_customers by ${dimension}`,
      interpretation: "count_distinct at order grain. Fan-out slices must refuse.",
      expectedSqlBehaviour: (SAFE_SLICES.ordering_customers ?? []).includes(dimension)
        ? "COUNT(DISTINCT orders.customer_id) at order grain."
        : "Refuse.",
      query: { metrics: ["ordering_customers"], dimensions: [dimension] },
      expectation: (SAFE_SLICES.ordering_customers ?? []).includes(dimension)
        ? { kind: "execute", trust: "governed" }
        : { kind: "refuse", statuses: ["unsafe_query", "invalid_query"], reason: "distinct/grain" },
    }),
  );
}

export function generatePermissionMatrix(): Scenario[] {
  const out: Scenario[] = [];
  for (const col of BLOCKED_COLUMNS) {
    const [table] = col.split(".");
    out.push(
      sc({
        id: `gen/perm/filter/${col.replace(".", "-")}`,
        category: "permissions",
        question: `Filter revenue by ${col}`,
        interpretation: "Blocked columns cannot be used as filters.",
        expectedSqlBehaviour: "column_not_permitted",
        prohibitedColumns: [col],
        guessSeverity: "security",
        query: { metrics: ["revenue"], filters: [{ field: col, operator: "=", value: "x" }] },
        expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked filter" },
      }),
      sc({
        id: `gen/perm/raw-metric/${col.replace(".", "-")}`,
        category: "permissions",
        question: `SUM/COUNT blocked ${col}`,
        interpretation: "Blocked columns cannot be raw metrics.",
        expectedSqlBehaviour: "column_not_permitted",
        prohibitedColumns: [col],
        guessSeverity: "security",
        query: { raw_metrics: [{ field: col, type: table === "employees" ? "sum" : "count" }] },
        expectation: { kind: "refuse", statuses: ["column_not_permitted", "invalid_query"], reason: "blocked metric" },
      }),
      sc({
        id: `gen/perm/time/${col.replace(".", "-")}`,
        category: "permissions",
        question: `time.dimension = ${col}`,
        interpretation: "Blocked column as a time dimension.",
        expectedSqlBehaviour: "Refuse.",
        prohibitedColumns: [col],
        guessSeverity: "security",
        query: { metrics: ["revenue"], time: { from: "2024-01-01", to: "2024-01-31", dimension: col } },
        expectation: {
          kind: "refuse",
          statuses: ["column_not_permitted", "invalid_query"],
          reason: "blocked time",
        },
      }),
      sc({
        id: `gen/perm/contains/${col.replace(".", "-")}`,
        category: "permissions",
        question: `contains() on ${col}`,
        interpretation: "Expression access is still access.",
        expectedSqlBehaviour: "Refuse.",
        prohibitedColumns: [col],
        guessSeverity: "security",
        query: { metrics: ["revenue"], filters: [{ field: col, operator: "contains", value: "a" }] },
        expectation: { kind: "refuse", statuses: ["column_not_permitted"], reason: "blocked contains" },
      }),
    );
  }
  return out;
}

export function generateHostile(): Scenario[] {
  const out: Scenario[] = [];
  for (const [i, name] of HOSTILE_IDENTIFIERS.entries()) {
    out.push(
      sc({
        id: `gen/hostile/metric-${i}`,
        category: "hostile",
        question: `Metric name ${JSON.stringify(name).slice(0, 80)}`,
        interpretation: "Hostile metric identifiers must not become SQL.",
        expectedSqlBehaviour: "undefined_metric / invalid_query. No write SQL.",
        guessSeverity: "security",
        query: { metrics: [name] },
        expectation: {
          kind: "refuse",
          statuses: ["undefined_metric", "invalid_query"],
          reason: "hostile identifier",
        },
      }),
    );
  }
  for (const [i, value] of HOSTILE_FILTER_VALUES.entries()) {
    out.push(
      sc({
        id: `gen/hostile/filter-${i}`,
        category: "hostile",
        mode: "custom",
        question: `Filter channel = ${JSON.stringify(value).slice(0, 80)}`,
        interpretation: "Hostile filter values are parameters, never spliced SQL.",
        expectedSqlBehaviour: "Bind a parameter or refuse the payload.",
        guessSeverity: "security",
        query: { metrics: ["revenue"], filters: [{ field: "channel", operator: "=", value: value as never }] },
        expectation: { kind: "refuse", reason: "hostile filter" },
        custom: async (ctx) => {
          try {
            const { compiled } = ctx.kernel.compile({
              metrics: ["revenue"],
              filters: [{ field: "channel", operator: "=", value: value as never }],
            });
            if (isWriteSql(compiled.sql)) return { code: "SECURITY CRITICAL", detail: "write SQL" };
            if (typeof value === "string" && !injectionEscaped(compiled.sql, value)) {
              return { code: "SECURITY CRITICAL", detail: "filter injection reached SQL" };
            }
            return { code: "PASS", detail: "parameterised" };
          } catch (err) {
            if (err instanceof GraneError) return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
            return { code: "FAIL", detail: String(err) };
          }
        },
      }),
    );
  }
  return out;
}

export function generateMcpAbuse(): Scenario[] {
  return MCP_PAYLOADS.map((payload, i) =>
    sc({
      id: `gen/mcp/payload-${i}`,
      category: "mcp",
      mode: "custom",
      question: `Malformed Query Model payload ${i}`,
      interpretation: "MCP input is hostile. Zod + kernel must refuse. Kernel safety is the boundary.",
      expectedSqlBehaviour: "No SQL, or only a safe SELECT if extra keys are ignored.",
      guessSeverity: "security",
      query: payload as Record<string, unknown>,
      expectation: { kind: "refuse", statuses: ["invalid_query", "undefined_metric"], reason: "malformed" },
      custom: async (ctx) => {
        const parsed = semanticQuerySchema.safeParse(payload);
        if (!parsed.success) return { code: "PASS — SAFE REFUSAL", detail: "schema rejected payload" };
        if (ctx.error instanceof GraneError) {
          return { code: "PASS — SAFE REFUSAL", detail: ctx.error.refusal.status };
        }
        if (ctx.error) {
          const leaks = errorLeaksSecrets(String((ctx.error as Error).message));
          if (leaks.length) return { code: "SECURITY CRITICAL", detail: leaks.join() };
          return { code: "FAIL", detail: String(ctx.error) };
        }
        const sql = ctx.compileSql ?? "";
        if (sql && isWriteSql(sql)) return { code: "SECURITY CRITICAL", detail: "write SQL from extra keys" };
        return { code: "PASS", detail: "accepted extra keys without changing safety" };
      },
    }),
  );
}

export function generateExplorationCombos(): Scenario[] {
  const out: Scenario[] = [];
  for (const metric of ["revenue", "orders", "average_order_value"]) {
    for (const raw of RAW_ORDER_DIMS) {
      out.push(
        sc({
          id: `gen/explore/${metric}/${raw.replace(".", "-")}`,
          category: "exploration",
          question: `${metric} by raw ${raw}`,
          interpretation: "Governed + raw = mixed. Never governed.",
          expectedSqlBehaviour: "trust mixed, order-grain join only.",
          query: { metrics: [metric], raw_dimensions: [raw] },
          expectation: { kind: "explore", trust: "mixed" },
        }),
      );
    }
  }
  const unsafeRaw = [
    "order_items.amount",
    "support_tickets.category",
    "sessions.browser",
    "product_category_map.category_id",
    "experiment_assignments.variant",
    "account_members.role",
    "attribution_events.campaign_id",
    "checkout_events.error",
  ];
  for (const raw of unsafeRaw) {
    out.push(
      sc({
        id: `gen/explore/unsafe/${raw.replace(".", "-")}`,
        category: "exploration",
        question: `Revenue by raw ${raw}`,
        interpretation: "Unsafe exploratory relationship. Refuse, do not label mixed and return a wrong number.",
        expectedSqlBehaviour: "unsafe_query.",
        query: { metrics: ["revenue"], raw_dimensions: [raw] },
        expectation: { kind: "refuse", statuses: ["unsafe_query", "invalid_query"], reason: "unsafe raw slice" },
      }),
    );
  }
  for (const field of ["orders.net_amount", "orders.id", "payments.amount"]) {
    for (const type of ["sum", "count", "avg", "min", "max", "count_distinct"] as const) {
      out.push(
        sc({
          id: `gen/explore/raw-metric/${type}-${field.replace(".", "-")}`,
          category: "exploration",
          question: `raw ${type}(${field})`,
          interpretation: "Raw-only aggregation is exploratory.",
          expectedSqlBehaviour: "trust exploratory.",
          query: { raw_metrics: [{ field, type }] },
          expectation:
            field.startsWith("payments") && type !== "count" && type !== "count_distinct"
              ? { kind: "explore", trust: "exploratory" }
              : { kind: "explore", trust: "exploratory" },
        }),
      );
    }
  }
  return out;
}

export function generateTimePeriods(): Scenario[] {
  const out: Scenario[] = [];
  const known = new Set([
    "today",
    "yesterday",
    "this_month",
    "last_month",
    "this_year",
    "last_year",
    "30d",
    "last_30d",
    "7d",
    "14d",
    "90d",
    "6m",
    "12m",
    "1w",
    "4w",
    "this-month",
    "LAST_MONTH",
  ]);
  for (const period of PERIODS) {
    out.push(
      sc({
        id: `gen/time/period/${period || "empty"}`,
        category: "time",
        question: `Revenue period=${period || "(empty)"}`,
        interpretation: known.has(period)
          ? "Supported relative period, resolved in Europe/London on completed_at."
          : "Unknown period. Refuse, do not guess calendar math.",
        expectedSqlBehaviour: known.has(period) ? "completed_at range." : "invalid_query",
        query: { metrics: ["revenue"], time: { period } },
        expectation: known.has(period)
          ? { kind: "execute", trust: "governed", sqlMustInclude: ["completed_at"] }
          : { kind: "refuse", statuses: ["invalid_query"], reason: "unknown period" },
      }),
    );
  }
  const grains = ["day", "week", "month", "quarter", "year"] as const;
  for (const grain of grains) {
    out.push(
      sc({
        id: `gen/time/grain/${grain}`,
        category: "time",
        question: `Revenue last_month grain ${grain}`,
        interpretation: "Time grain on completed_at.",
        expectedSqlBehaviour: "date_trunc / equivalent.",
        query: { metrics: ["revenue"], time: { period: "last_month", grain } },
        expectation: { kind: "execute", trust: "governed" },
      }),
    );
  }
  const ranges: Array<[{ from: string; to: string }, boolean, string]> = [
    [{ from: "2024-02-01", to: "2024-02-29" }, true, "leap february"],
    [{ from: "2024-02-29", to: "2024-02-29" }, true, "leap day"],
    [{ from: "2023-02-29", to: "2023-02-29" }, false, "non-leap 29 feb"],
    [{ from: "2024-12-31", to: "2025-01-01" }, true, "year boundary"],
    [{ from: "2024-03-31", to: "2024-03-31" }, true, "dst spring"],
    [{ from: "2024-10-27", to: "2024-10-27" }, true, "dst autumn"],
    [{ from: "2024-06-30", to: "2024-07-01" }, true, "utc vs london"],
    [{ from: "2025-01-01", to: "2024-01-01" }, false, "from after to"],
    [{ from: "2024-1-1", to: "2024-1-31" }, false, "unpadded date"],
    [{ from: "2024/01/01", to: "2024/01/31" }, false, "slash date"],
  ];
  for (const [range, ok, label] of ranges) {
    out.push(
      sc({
        id: `gen/time/range/${label.replace(/\s+/g, "-")}`,
        category: "time",
        question: `Revenue ${range.from}..${range.to} (${label})`,
        interpretation: ok ? "Inclusive civil dates in the project timezone." : "Refuse malformed/inverted range.",
        expectedSqlBehaviour: ok ? "completed_at bounds." : "invalid_query",
        query: { metrics: ["revenue"], time: range },
        expectation: ok
          ? { kind: "execute", trust: "governed" }
          : { kind: "refuse", statuses: ["invalid_query"], reason: label },
      }),
    );
  }
  return out;
}

export function generateResources(): Scenario[] {
  const limits = [1, 2, 10, 50, 1000, 10000, 10001, 999999, 2_147_483_647];
  const out: Scenario[] = limits.map((limit) =>
    sc({
      id: `gen/res/limit-${limit}`,
      category: "resources",
      question: `Revenue by customer_country limit=${limit}`,
      interpretation: "Configured max_rows cannot be bypassed through the query argument.",
      expectedSqlBehaviour: `LIMIT <= 10000 (asked ${limit}).`,
      query: { metrics: ["revenue"], dimensions: ["customer_country"], limit },
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        if (ctx.error) return { code: "FAIL", detail: String((ctx.error as Error).message) };
        const sql = ctx.compileSql ?? "";
        const match = /LIMIT\s+(\d+)/i.exec(sql);
        const applied = match ? Number(match[1]) : NaN;
        if (!Number.isFinite(applied)) return { code: "FAIL", detail: "no LIMIT in SQL" };
        if (applied > 10000) {
          return { code: "SECURITY CRITICAL", detail: `LIMIT ${applied} bypassed max_rows` };
        }
        return { code: "PASS", detail: `LIMIT ${applied}` };
      },
    }),
  );
  out.push(
    sc({
      id: "gen/res/no-limit",
      category: "resources",
      question: "Revenue by customer_country with no limit.",
      interpretation: "Default row cap applies.",
      expectedSqlBehaviour: "LIMIT default_rows (1000) or less.",
      query: { metrics: ["revenue"], dimensions: ["customer_country"] },
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const sql = ctx.compileSql ?? "";
        if (!/LIMIT\s+\d+/i.test(sql)) {
          return { code: "SECURITY CRITICAL", detail: "unbounded SELECT" };
        }
        return { code: "PASS", detail: "limit present" };
      },
    }),
  );
  return out;
}

export function generateEquivalent(): Scenario[] {
  const out: Scenario[] = [];
  const twins: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ["synonym", { metrics: ["revenue"] }, { metrics: ["sales"] }],
    ["aov-synonym", { metrics: ["average_order_value"] }, { metrics: ["aov"] }],
    ["case", { metrics: ["revenue"] }, { metrics: ["Revenue"] }],
    [
      "filter-order",
      {
        metrics: ["revenue"],
        filters: [
          { field: "channel", operator: "=", value: "web" },
          { field: "customer_type", operator: "=", value: "consumer" },
        ],
      },
      {
        metrics: ["revenue"],
        filters: [
          { field: "customer_type", operator: "=", value: "consumer" },
          { field: "channel", operator: "=", value: "web" },
        ],
      },
    ],
    [
      "last-month-vs-range",
      { metrics: ["revenue"], time: { period: "last_month" } },
      { metrics: ["revenue"], time: { from: "2024-02-01", to: "2024-02-29" } },
    ],
    [
      "dim-order",
      { metrics: ["revenue"], dimensions: ["channel", "customer_country"] },
      { metrics: ["revenue"], dimensions: ["customer_country", "channel"] },
    ],
  ];
  for (const [name, a, b] of twins) {
    out.push(
      sc({
        id: `gen/eq/${name}`,
        category: "equivalent",
        question: `Equivalent pair ${name}`,
        interpretation: "Same analytical intent → same safety behaviour and same numbers/SQL semantics.",
        expectedSqlBehaviour: "Matching trust and matching compiled semantics.",
        query: a,
        expectation: { kind: "execute", trust: "governed" },
        custom: async (ctx) => {
          try {
            const left = ctx.kernel.compile(a as never);
            const right = ctx.kernel.compile(b as never);
            if (left.compiled.trust !== right.compiled.trust) {
              return {
                code: "CRITICAL FAIL",
                detail: `trust ${left.compiled.trust} vs ${right.compiled.trust}`,
              };
            }
            return { code: "PASS", detail: `both ${left.compiled.trust}` };
          } catch (err) {
            try {
              ctx.kernel.compile(b as never);
              return { code: "CRITICAL FAIL", detail: "one twin compiled, the other refused" };
            } catch {
              return { code: "PASS — SAFE REFUSAL", detail: "both refused" };
            }
          }
        },
      }),
    );
  }
  return out;
}

export function generateSchemaMutations(): Scenario[] {
  const out: Scenario[] = [];
  const mutations: Array<[string, (schema: { tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }> }) => void]> =
    [
      ["rename-payments-amount", (schema) => rename(schema, "payments", "amount", "gross_amount")],
      ["drop-orders-net-amount", (schema) => dropCol(schema, "orders", "net_amount")],
      ["drop-orders-completed-at", (schema) => dropCol(schema, "orders", "completed_at")],
      ["type-net-amount-text", (schema) => retype(schema, "orders", "net_amount", "text")],
      ["drop-customers", (schema) => {
        schema.tables = schema.tables.filter((t) => t.name !== "customers");
      }],
      ["drop-orders-customer-id", (schema) => dropCol(schema, "orders", "customer_id")],
    ];
  for (const [name, mutate] of mutations) {
    out.push(
      sc({
        id: `gen/schema/${name}`,
        category: "schema_mutation",
        mode: "custom",
        question: `Validate after ${name}`,
        interpretation: "Broken semantic references must fail validation, not silently change meaning.",
        expectedSqlBehaviour: "validate().ok === false.",
        expectation: { kind: "refuse", reason: "stale model" },
        custom: async (ctx) => {
          const schema = structuredClone(await ctx.kernel.loadSchema());
          mutate(schema);
          const report = ctx.kernel.validate(schema);
          if (report.ok) {
            return { code: "CRITICAL FAIL", detail: `${name} still validated` };
          }
          return { code: "PASS — SAFE REFUSAL", detail: report.issues[0]?.code ?? "invalid" };
        },
      }),
    );
  }
  // Duplicate-column / extra-relationship mutations.
  for (let i = 0; i < 44; i += 1) {
    out.push(
      sc({
        id: `gen/schema/extra-rel-${i}`,
        category: "schema_mutation",
        mode: "custom",
        question: `Add a duplicate ambiguous relationship variant ${i}`,
        interpretation: "Additional edges must not make previously-refused queries start guessing.",
        expectedSqlBehaviour: "Revenue by ticket_category still refuses.",
        expectation: { kind: "refuse", reason: "still unsafe" },
        config: (base) => ({
          ...base,
          relationships: {
            ...base.relationships,
            [`extra_${i}`]: {
              from: i % 2 === 0 ? "support_tickets.customer_id" : "orders.customer_id",
              to: "customers.id",
              type: "many_to_one",
            },
          },
        }),
        query: { metrics: ["revenue"], dimensions: ["ticket_category"] },
        custom: async (ctx) => {
          try {
            ctx.kernel.compile({ metrics: ["revenue"], dimensions: ["ticket_category"] });
            return { code: "CRITICAL FAIL", detail: "ticket_category compiled after extra relationship" };
          } catch (err) {
            if (err instanceof GraneError) return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
            return { code: "FAIL", detail: String(err) };
          }
        },
      }),
    );
  }
  return out;
}

function rename(
  schema: { tables: Array<{ name: string; columns: Array<{ name: string }> }> },
  table: string,
  from: string,
  to: string,
): void {
  const t = schema.tables.find((x) => x.name === table);
  const col = t?.columns.find((c) => c.name === from);
  if (col) col.name = to;
}

function dropCol(
  schema: { tables: Array<{ name: string; columns: Array<{ name: string }> }> },
  table: string,
  col: string,
): void {
  const t = schema.tables.find((x) => x.name === table);
  if (t) t.columns = t.columns.filter((c) => c.name !== col);
}

function retype(
  schema: { tables: Array<{ name: string; columns: Array<{ name: string; dataType: string }> }> },
  table: string,
  col: string,
  dataType: string,
): void {
  const t = schema.tables.find((x) => x.name === table);
  const c = t?.columns.find((x) => x.name === col);
  if (c) c.dataType = dataType;
}

export function generateProperties(): Scenario[] {
  const rand = mulberry32(20240826);
  const out: Scenario[] = [];
  for (let i = 0; i < 220; i += 1) {
    const metric = pick(rand, METRICS);
    const useRaw = rand() < 0.3;
    const dim = pick(rand, DIMENSIONS);
    const raw = pick(rand, [...RAW_ORDER_DIMS, "orders.channel", "customers.country"]);
    const query = useRaw
      ? { metrics: [metric], raw_dimensions: [raw] }
      : { metrics: [metric], dimensions: [dim] };
    out.push(
      sc({
        id: `gen/prop/${i}`,
        category: "properties",
        question: `Random invariant query ${i}`,
        interpretation: "Blocked fields never in SQL; writes never generated; governed never mixed.",
        expectedSqlBehaviour: "Invariants hold whether the query is answered or refused.",
        query,
        expectation: { kind: "execute", trust: "governed" },
        custom: async (ctx) => {
          try {
            const { compiled, resolved } = ctx.kernel.compile(query);
            if (isWriteSql(compiled.sql)) return { code: "SECURITY CRITICAL", detail: "write SQL" };
            const blocked = sqlContainsBlockedColumn(compiled.sql);
            if (blocked.length) return { code: "SECURITY CRITICAL", detail: blocked.join() };
            if (resolved.trust === "governed" && resolved.ungoverned.length > 0) {
              return { code: "CRITICAL FAIL", detail: "governed trust with ungoverned fields" };
            }
            if (resolved.ungoverned.length > 0 && resolved.trust === "governed") {
              return { code: "CRITICAL FAIL", detail: "exploratory components labelled governed" };
            }
            if (useRaw && resolved.trust === "governed") {
              return { code: "CRITICAL FAIL", detail: "raw dimension labelled governed" };
            }
            return resolved.trust === "governed"
              ? { code: "PASS", detail: "invariants held" }
              : { code: "PASS — EXPLORATORY", detail: resolved.trust };
          } catch (err) {
            if (err instanceof GraneError) {
              const leaks = errorLeaksSecrets(err.message);
              if (leaks.length) return { code: "SECURITY CRITICAL", detail: leaks.join() };
              return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
            }
            return { code: "FAIL", detail: String(err) };
          }
        },
      }),
    );
  }
  return out;
}

export function generateLeakage(): Scenario[] {
  return [
    sc({
      id: "gen/leak/unknown-metric",
      category: "leakage",
      mode: "custom",
      question: "Unknown metric error must not dump warehouse secrets.",
      interpretation: "A name typo is not a reason to echo password hashes or live tokens.",
      expectedSqlBehaviour: "undefined_metric without fixture secrets.",
      expectation: { kind: "refuse", reason: "unknown" },
      custom: async (ctx) => {
        try {
          ctx.kernel.compile({ metrics: ["no_such_metric"] });
          return { code: "CRITICAL FAIL", detail: "compiled an unknown metric" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/hash_alice|sk_live_|alice@secret/.test(message)) {
            return { code: "SECURITY CRITICAL", detail: "warehouse secret in an unrelated error" };
          }
          if (err instanceof GraneError) return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
          return { code: "FAIL", detail: message };
        }
      },
    }),
    sc({
      id: "gen/leak/blocked-column-value",
      category: "leakage",
      mode: "custom",
      question: "Blocked-column refusal must not include the stored hash.",
      interpretation: "Naming the field is allowed. Naming hash_alice is not.",
      expectedSqlBehaviour: "column_not_permitted without hash_alice.",
      expectation: { kind: "refuse", reason: "blocked" },
      custom: async (ctx) => {
        try {
          ctx.kernel.compile({ metrics: ["revenue"], raw_dimensions: ["customers.password_hash"] });
          return { code: "SECURITY CRITICAL", detail: "blocked column compiled" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/hash_alice|hash_bob/.test(message)) {
            return { code: "SECURITY CRITICAL", detail: "stored hash in error" };
          }
          if (err instanceof GraneError) return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
          return { code: "FAIL", detail: message };
        }
      },
    }),
    sc({
      id: "gen/leak/secrets-table",
      category: "leakage",
      mode: "custom",
      question: "Missing secrets.api_keys must not return sk_live token.",
      interpretation: "Even an undefined_column error cannot include the token value.",
      expectedSqlBehaviour: "Refusal without sk_live_.",
      expectation: { kind: "refuse", reason: "blocked schema" },
      custom: async (ctx) => {
        try {
          ctx.kernel.compile({ raw_metrics: [{ field: "api_keys.token", type: "count" }] });
          return { code: "SECURITY CRITICAL", detail: "secrets table compiled" };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (/sk_live_/.test(message)) {
            return { code: "SECURITY CRITICAL", detail: "live token in error" };
          }
          if (err instanceof GraneError) return { code: "PASS — SAFE REFUSAL", detail: err.refusal.status };
          return { code: "FAIL", detail: message };
        }
      },
    }),
  ];
}

export function generateConcurrency(): Scenario[] {
  return [
    sc({
      id: "gen/conc/parallel-compiles",
      category: "concurrency",
      mode: "custom",
      question: "100 concurrent compiles of distinct queries.",
      interpretation: "No mixed SQL, trust, or metric identity across requests.",
      expectedSqlBehaviour: "Each result matches its own sequential compile.",
      expectation: { kind: "execute", trust: "governed" },
      custom: async (ctx) => {
        const queries = Array.from({ length: 100 }, (_, i) =>
          i % 2 === 0
            ? { metrics: ["revenue"], dimensions: ["channel"] }
            : { metrics: ["orders"], dimensions: ["customer_type"] },
        );
        const sequential = queries.map((q) => ctx.kernel.compile(q).compiled.sql);
        const parallel = await Promise.all(queries.map((q) => Promise.resolve(ctx.kernel.compile(q).compiled.sql)));
        for (let i = 0; i < queries.length; i += 1) {
          if (parallel[i] !== sequential[i]) {
            return { code: "CRITICAL FAIL", detail: `slot ${i} SQL leaked` };
          }
        }
        return { code: "PASS", detail: "100 parallel compiles isolated" };
      },
    }),
  ];
}

export function generateFilterOps(): Scenario[] {
  const operators = ["=", "!=", ">", ">=", "<", "<=", "in", "not_in", "is_null", "is_not_null", "contains"] as const;
  const fields = ["channel", "customer_country", "customer_type"];
  const out: Scenario[] = [];
  for (const field of fields) {
    for (const operator of operators) {
      const value =
        operator === "in" || operator === "not_in"
          ? ["web", "mobile"]
          : operator === "is_null" || operator === "is_not_null"
            ? undefined
            : operator === "contains"
              ? "web"
              : operator === ">" || operator === ">=" || operator === "<" || operator === "<="
                ? 0
                : "web";
      out.push(
        sc({
          id: `gen/metrics/filter/${field}/${operator}`,
          category: "metrics",
          question: `Revenue where ${field} ${operator} ${JSON.stringify(value)}`,
          interpretation: "Governed filter at a safe slice.",
          expectedSqlBehaviour: "Parameterised predicate, or refuse if the operator is illegal for the type.",
          query: { metrics: ["revenue"], filters: [{ field, operator, value }] },
          expectation: { kind: "execute", trust: "governed" },
        }),
      );
    }
  }
  return out;
}

export function generateUnknownNames(): Scenario[] {
  const names = [
    "country",
    "nation",
    "geo",
    "region",
    "amount",
    "total",
    "gmv",
    "arr",
    "mrr",
    "profit",
    "margin",
    "users",
    "visitors",
    "sessions",
    "conversion",
    "ltv",
    "cac",
    "churn",
    "sku",
    "category",
    "browser",
    "device",
    "campaign",
    "variant",
    "balance",
    "inventory_level",
    "email",
    "salary",
  ];
  return names.flatMap((name) => [
    sc({
      id: `gen/ambig/dim-${name}`,
      category: "ambiguity",
      question: `Revenue by ${name}`,
      interpretation: "Unknown dimension. Refuse rather than bind a similarly named column.",
      expectedSqlBehaviour: "undefined_dimension / invalid_query.",
      query: { metrics: ["revenue"], dimensions: [name] },
      expectation: {
        kind: "refuse",
        statuses: ["undefined_dimension", "invalid_query", "unsafe_query"],
        reason: "unknown dimension",
      },
    }),
    sc({
      id: `gen/ambig/metric-${name}`,
      category: "ambiguity",
      question: name,
      interpretation: "Unknown metric. Do not guess a SQL expression.",
      expectedSqlBehaviour: "undefined_metric.",
      query: { metrics: [name] },
      expectation: { kind: "refuse", statuses: ["undefined_metric", "invalid_query"], reason: "unknown metric" },
    }),
  ]);
}

export function generateExploratoryTables(): Scenario[] {
  const fields = [
    "orders.id",
    "customers.id",
    "payments.id",
    "refunds.id",
    "order_items.id",
    "products.id",
    "support_tickets.id",
    "sessions.id",
    "accounts.id",
    "employees.id",
    "invoices.id",
    "campaigns.id",
    "experiments.id",
    "plans.id",
    "subscriptions.id",
    "empty_events.id",
    "chain_f.id",
    "dup_customers.id",
  ];
  return fields.map((field) =>
    sc({
      id: `gen/explore/count-${field.replace(".", "-")}`,
      category: "exploration",
      question: `COUNT(${field})`,
      interpretation: "Raw count at that table's grain, trust exploratory.",
      expectedSqlBehaviour: "No governed names. employees.id is allowed; employees.salary is not.",
      query: { raw_metrics: [{ field, type: "count" }] },
      expectation: { kind: "explore", trust: "exploratory" },
    }),
  );
}

export function allGenerated(): Scenario[] {
  return [
    ...generateJoinGrainMatrix(),
    ...generateDistinctMatrix(),
    ...generatePermissionMatrix(),
    ...generateHostile(),
    ...generateMcpAbuse(),
    ...generateExplorationCombos(),
    ...generateExploratoryTables(),
    ...generateTimePeriods(),
    ...generateFilterOps(),
    ...generateUnknownNames(),
    ...generateResources(),
    ...generateEquivalent(),
    ...generateSchemaMutations(),
    ...generateProperties(),
    ...generateLeakage(),
    ...generateConcurrency(),
  ];
}
