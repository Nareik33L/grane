/**
 * Metric `status` vs trust: experimental is not an approved definition.
 *
 * Contract (from schema + trust headlines + resolver notes):
 *   approved / omitted → may be trust: governed
 *   experimental       → mixed (never governed), plus the existing note
 *   deprecated         → still governed, plus the deprecation note
 *
 * Trust walks the metric dependency closure (requested metrics and ratio
 * components, recursively). Dimensions and relationships have no status.
 * Provider imports without a native lifecycle field stay approved.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { dimensionConfigSchema, graneConfigSchema, metricStatusSchema } from "../../src/config/schema.js";
import { GraneKernel } from "../../src/kernel.js";
import { computeTrust, experimentalMetricNames } from "../../src/query/resolve.js";
import { trustHeadline } from "../../src/query/trust.js";
import { exampleConfig, exploringConfig } from "../fixtures.js";

const EXPERIMENTAL_NOTE = (name: string) =>
  `Metric "${name}" is experimental (not an approved definition).`;
const DEPRECATED_NOTE = (name: string) => `Metric "${name}" is deprecated.`;

function statusConfig() {
  const base = exampleConfig();
  const revenue = base.metrics.revenue;
  const orders = base.metrics.orders;
  return graneConfigSchema.parse({
    ...base,
    metrics: {
      ...base.metrics,
      trial_revenue: { ...revenue, status: "experimental" },
      trial_orders: { ...orders, status: "experimental" },
      legacy_revenue: { ...revenue, status: "deprecated" },
      ratio_stable_experimental: {
        entity: "order",
        type: "ratio",
        numerator: "revenue",
        denominator: "trial_orders",
        status: "approved",
        synonyms: [],
      },
      ratio_experimental_stable: {
        entity: "order",
        type: "ratio",
        numerator: "trial_revenue",
        denominator: "orders",
        status: "approved",
        synonyms: [],
      },
      experimental_ratio_stable: {
        entity: "order",
        type: "ratio",
        numerator: "revenue",
        denominator: "orders",
        status: "experimental",
        synonyms: [],
      },
      nested_via_experimental: {
        entity: "order",
        type: "ratio",
        numerator: "revenue",
        denominator: "ratio_stable_experimental",
        status: "approved",
        synonyms: [],
      },
      imported_revenue: {
        ...revenue,
        source: { provider: "dbt", path: "semantic_models.yml" },
      },
    },
  });
}

function statusKernel() {
  return new GraneKernel(statusConfig());
}

function exploringStatusKernel() {
  const cfg = statusConfig();
  return new GraneKernel(
    exploringConfig({
      metrics: cfg.metrics,
    }),
  );
}

function expectNote(notes: string[], note: string, present = true): void {
  if (present) expect(notes).toContain(note);
  else expect(notes).not.toContain(note);
}

describe("status schema", () => {
  it("allows only experimental | approved | deprecated", () => {
    expect(metricStatusSchema.options).toEqual(["experimental", "approved", "deprecated"]);
    expect(metricStatusSchema.safeParse("Experimental").success).toBe(false);
    expect(metricStatusSchema.safeParse("APPROVED").success).toBe(false);
    expect(metricStatusSchema.safeParse("stable").success).toBe(false);
  });

  it("defaults omitted metric status to approved", () => {
    expect(statusConfig().metrics.orders.status).toBe("approved");
    expect(statusConfig().metrics.imported_revenue.status).toBe("approved");
  });

  it("does not give dimensions a status field", () => {
    const parsed = dimensionConfigSchema.parse({
      entity: "order",
      sql: "${orders.channel}",
      status: "experimental",
    });
    expect(parsed).not.toHaveProperty("status");
  });
});

describe("computeTrust + experimental closure", () => {
  it("stays governed only when there are no raw fields and no experimental metrics", () => {
    expect(computeTrust(["revenue"], [])).toBe("governed");
    expect(computeTrust(["revenue"], [], [])).toBe("governed");
    expect(computeTrust(["revenue"], [], ["trial_revenue"])).toBe("mixed");
    expect(computeTrust(["trial_revenue"], [], ["trial_revenue"])).toBe("mixed");
    expect(computeTrust(["revenue"], ["orders.discount_code"])).toBe("mixed");
    expect(computeTrust(["revenue"], ["orders.discount_code"], ["trial_revenue"])).toBe("mixed");
    expect(computeTrust([], ["payments.id"])).toBe("exploratory");
    expect(computeTrust([], ["payments.id"], [])).toBe("exploratory");
  });

  it("walks ratio components recursively", () => {
    const model = statusKernel().model;
    const nested = model.metrics.get("nested_via_experimental")!;
    expect(experimentalMetricNames(model, [nested])).toEqual(["trial_orders"]);
    const top = model.metrics.get("trial_revenue")!;
    expect(experimentalMetricNames(model, [top])).toEqual(["trial_revenue"]);
    const approved = model.metrics.get("revenue")!;
    expect(experimentalMetricNames(model, [approved])).toEqual([]);
  });
});

describe("native YAML status / trust matrix (resolve)", () => {
  const kernel = statusKernel();

  function resolved(metrics: string[], extra: Record<string, unknown> = {}) {
    const r = kernel.resolve({ metrics, ...extra });
    return r;
  }

  it("compile trust matches resolve when the query is compilable", () => {
    for (const metrics of [
      ["revenue"],
      ["trial_revenue"],
      ["legacy_revenue"],
      ["ratio_stable_experimental"],
      ["experimental_ratio_stable"],
      ["revenue", "trial_revenue"],
    ]) {
      const { resolved: r, compiled } = kernel.compile({ metrics });
      expect(compiled.trust, metrics.join("+")).toBe(r.trust);
    }
  });

  it("T1 approved metric alone → governed", () => {
    const r = resolved(["revenue"]);
    expect(r.metrics.map((m) => m.name)).toEqual(["revenue"]);
    expect(r.metrics[0]!.config.status).toBe("approved");
    expect(r.trust).toBe("governed");
    expect(r.ungoverned).toEqual([]);
    expect(r.warning).toBeNull();
    expectNote(r.notes, EXPERIMENTAL_NOTE("revenue"), false);
  });

  it("T2 experimental metric alone → mixed + note", () => {
    const r = resolved(["trial_revenue"]);
    expect(r.metrics[0]!.config.status).toBe("experimental");
    expect(r.trust).toBe("mixed");
    expect(r.governed).toContain("trial_revenue");
    expect(r.ungoverned).toEqual([]);
    expect(r.warning).toBeNull();
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_revenue"));
    expect(trustHeadline(r.trust)).toContain("not every field is an approved definition");
  });

  it("T3 deprecated metric alone → governed + deprecated note", () => {
    const r = resolved(["legacy_revenue"]);
    expect(r.metrics[0]!.config.status).toBe("deprecated");
    expect(r.trust).toBe("governed");
    expectNote(r.notes, DEPRECATED_NOTE("legacy_revenue"));
    expectNote(r.notes, EXPERIMENTAL_NOTE("legacy_revenue"), false);
  });

  it("T4 omitted/default status → governed", () => {
    const r = resolved(["orders"]);
    expect(r.metrics[0]!.config.status).toBe("approved");
    expect(r.trust).toBe("governed");
  });

  it("T5 approved metric + dimension → governed", () => {
    const r = resolved(["revenue"], { dimensions: ["channel"] });
    expect(r.trust).toBe("governed");
    expect(r.dimensions.map((d) => d.name)).toEqual(["channel"]);
  });

  it("T6 dimensions do not carry status — approved metric stays governed", () => {
    const r = resolved(["revenue"], { dimensions: ["country"] });
    expect(r.trust).toBe("governed");
  });

  it("T7 experimental metric + stable dimension → mixed", () => {
    const r = resolved(["trial_revenue"], { dimensions: ["channel"] });
    expect(r.trust).toBe("mixed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_revenue"));
  });

  it("T8 two metrics: approved + experimental (both orders) → mixed", () => {
    const forward = resolved(["revenue", "trial_revenue"]);
    const reverse = resolved(["trial_revenue", "revenue"]);
    expect(forward.trust).toBe("mixed");
    expect(reverse.trust).toBe("mixed");
    expect(forward.metrics.map((m) => m.name)).toEqual(["revenue", "trial_revenue"]);
    expect(reverse.metrics.map((m) => m.name)).toEqual(["trial_revenue", "revenue"]);
    expectNote(forward.notes, EXPERIMENTAL_NOTE("trial_revenue"));
    expectNote(reverse.notes, EXPERIMENTAL_NOTE("trial_revenue"));
  });

  it("T9 ratio approved/approved → governed", () => {
    const r = resolved(["average_order_value"]);
    expect(r.trust).toBe("governed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("revenue"), false);
  });

  it("T10 ratio approved/experimental → mixed + component note", () => {
    const r = resolved(["ratio_stable_experimental"]);
    expect(r.metrics[0]!.config.status).toBe("approved");
    expect(r.trust).toBe("mixed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_orders"));
  });

  it("T11 ratio experimental/approved → mixed", () => {
    const r = resolved(["ratio_experimental_stable"]);
    expect(r.trust).toBe("mixed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_revenue"));
  });

  it("T12 top-level experimental ratio over approved components → mixed", () => {
    const r = resolved(["experimental_ratio_stable"]);
    expect(r.metrics[0]!.config.status).toBe("experimental");
    expect(r.trust).toBe("mixed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("experimental_ratio_stable"));
  });

  it("T13 top-level approved ratio over experimental component → mixed", () => {
    const r = resolved(["ratio_stable_experimental"]);
    expect(r.trust).toBe("mixed");
  });

  it("T14 metric-definition filters do not carry status; approved stays governed", () => {
    const approved = resolved(["revenue"]);
    const experimental = resolved(["trial_revenue"]);
    expect(approved.metrics[0]!.filters.length).toBeGreaterThan(0);
    expect(approved.trust).toBe("governed");
    expect(experimental.trust).toBe("mixed");
  });

  it("T15 joined dimension has no status — approved metric stays governed", () => {
    const r = resolved(["revenue"], { dimensions: ["country"] });
    expect(r.trust).toBe("governed");
    expect(r.dimensions[0]!.name).toBe("country");
  });

  it("T16 control: same query without the experimental dependency → governed", () => {
    const withExp = resolved(["revenue", "trial_revenue"]);
    const without = resolved(["revenue"]);
    expect(withExp.trust).toBe("mixed");
    expect(without.trust).toBe("governed");
  });

  it("nested approved ratio that reaches an experimental leaf → mixed", () => {
    const r = resolved(["nested_via_experimental"]);
    expect(r.trust).toBe("mixed");
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_orders"));
  });

  it("provider-imported metric without native status stays approved / governed", () => {
    const r = resolved(["imported_revenue"]);
    expect(r.metrics[0]!.config.status).toBe("approved");
    expect(r.metrics[0]!.config.source?.provider).toBe("dbt");
    expect(r.trust).toBe("governed");
  });

  it("experimental + raw warehouse field is mixed, not exploratory, and not ungoverned-named", () => {
    const k = exploringStatusKernel();
    const { resolved: r } = k.compile({
      metrics: ["trial_revenue"],
      raw_dimensions: ["orders.discount_code"],
    });
    expect(r.trust).toBe("mixed");
    expect(r.ungoverned).toEqual(["orders.discount_code"]);
    expect(r.ungoverned).not.toContain("trial_revenue");
    expect(r.warning).toContain("orders.discount_code");
    expectNote(r.notes, EXPERIMENTAL_NOTE("trial_revenue"));
  });
});

const FACTS_DDL = `
  CREATE TABLE facts (id INTEGER, amount DOUBLE PRECISION, region VARCHAR, flag VARCHAR);
  INSERT INTO facts VALUES
    (1, 100, 'US', 'keep'),
    (2, 50, 'DE', 'keep'),
    (3, 25, 'US', 'drop');
  CREATE TABLE geos (code VARCHAR PRIMARY KEY, name VARCHAR);
  INSERT INTO geos VALUES ('US', 'United States'), ('DE', 'Germany');
`;

function syntheticMetrics() {
  return {
    approved_sum: { entity: "fact", type: "sum", sql: "${facts.amount}", status: "approved" },
    experimental_sum: { entity: "fact", type: "sum", sql: "${facts.amount}", status: "experimental" },
    deprecated_sum: { entity: "fact", type: "sum", sql: "${facts.amount}", status: "deprecated" },
    default_sum: { entity: "fact", type: "sum", sql: "${facts.amount}" },
    approved_n: { entity: "fact", type: "count", sql: "${facts.id}", status: "approved" },
    experimental_n: { entity: "fact", type: "count", sql: "${facts.id}", status: "experimental" },
    filtered_approved: {
      entity: "fact",
      type: "sum",
      sql: "${facts.amount}",
      status: "approved",
      filters: { "facts.flag": "keep" },
    },
    filtered_experimental: {
      entity: "fact",
      type: "sum",
      sql: "${facts.amount}",
      status: "experimental",
      filters: { "facts.flag": "keep" },
    },
    ratio_ss: { entity: "fact", type: "ratio", numerator: "approved_sum", denominator: "approved_n" },
    ratio_se: { entity: "fact", type: "ratio", numerator: "approved_sum", denominator: "experimental_n" },
    ratio_es: { entity: "fact", type: "ratio", numerator: "experimental_sum", denominator: "approved_n" },
    ratio_exp_ss: {
      entity: "fact",
      type: "ratio",
      numerator: "approved_sum",
      denominator: "approved_n",
      status: "experimental",
    },
  };
}

function syntheticConfig(connection: Record<string, unknown>) {
  return graneConfigSchema.parse({
    project: { name: "status-trust", timezone: "UTC" },
    connection,
    entities: { fact: { table: "facts", primary_key: "id" } },
    metrics: syntheticMetrics(),
    dimensions: {
      region: { entity: "fact", sql: "${facts.region}" },
      geo: { entity: "fact", sql: "${geos.name}" },
    },
    relationships: {
      facts_geos: { from: "facts.region", to: "geos.code", type: "many_to_one" },
    },
  });
}

type ExecutedCase = {
  id: string;
  metrics: string[];
  dimensions?: string[];
  trust: "governed" | "mixed";
  experimentalNotes?: string[];
  deprecatedNotes?: string[];
  values?: Record<string, number>;
};

const EXECUTED_CASES: ExecutedCase[] = [
  { id: "T1", metrics: ["approved_sum"], trust: "governed", values: { approved_sum: 175 } },
  {
    id: "T2",
    metrics: ["experimental_sum"],
    trust: "mixed",
    experimentalNotes: ["experimental_sum"],
    values: { experimental_sum: 175 },
  },
  {
    id: "T3",
    metrics: ["deprecated_sum"],
    trust: "governed",
    deprecatedNotes: ["deprecated_sum"],
    values: { deprecated_sum: 175 },
  },
  { id: "T4", metrics: ["default_sum"], trust: "governed", values: { default_sum: 175 } },
  { id: "T5", metrics: ["approved_sum"], dimensions: ["region"], trust: "governed" },
  {
    id: "T7",
    metrics: ["experimental_sum"],
    dimensions: ["region"],
    trust: "mixed",
    experimentalNotes: ["experimental_sum"],
  },
  {
    id: "T8a",
    metrics: ["approved_sum", "experimental_sum"],
    trust: "mixed",
    experimentalNotes: ["experimental_sum"],
    values: { approved_sum: 175, experimental_sum: 175 },
  },
  {
    id: "T8b",
    metrics: ["experimental_sum", "approved_sum"],
    trust: "mixed",
    experimentalNotes: ["experimental_sum"],
    values: { experimental_sum: 175, approved_sum: 175 },
  },
  { id: "T9", metrics: ["ratio_ss"], trust: "governed", values: { ratio_ss: 175 / 3 } },
  {
    id: "T10",
    metrics: ["ratio_se"],
    trust: "mixed",
    experimentalNotes: ["experimental_n"],
    values: { ratio_se: 175 / 3 },
  },
  {
    id: "T11",
    metrics: ["ratio_es"],
    trust: "mixed",
    experimentalNotes: ["experimental_sum"],
    values: { ratio_es: 175 / 3 },
  },
  {
    id: "T12",
    metrics: ["ratio_exp_ss"],
    trust: "mixed",
    experimentalNotes: ["ratio_exp_ss"],
    values: { ratio_exp_ss: 175 / 3 },
  },
  {
    id: "T13",
    metrics: ["ratio_se"],
    trust: "mixed",
    experimentalNotes: ["experimental_n"],
  },
  {
    id: "T14a",
    metrics: ["filtered_approved"],
    trust: "governed",
    values: { filtered_approved: 150 },
  },
  {
    id: "T14b",
    metrics: ["filtered_experimental"],
    trust: "mixed",
    experimentalNotes: ["filtered_experimental"],
    values: { filtered_experimental: 150 },
  },
  { id: "T15", metrics: ["approved_sum"], dimensions: ["geo"], trust: "governed" },
  { id: "T16", metrics: ["approved_sum"], trust: "governed", values: { approved_sum: 175 } },
];

async function assertExecuted(kernel: GraneKernel, c: ExecutedCase): Promise<void> {
  const input = { metrics: c.metrics, ...(c.dimensions ? { dimensions: c.dimensions } : {}) };
  const { resolved, compiled } = kernel.compile(input);
  expect(resolved.trust, c.id).toBe(c.trust);
  expect(compiled.trust, c.id).toBe(c.trust);
  expect(resolved.ungoverned, c.id).toEqual([]);
  expect(resolved.warning, c.id).toBeNull();
  for (const name of c.experimentalNotes ?? []) {
    expectNote(resolved.notes, EXPERIMENTAL_NOTE(name));
  }
  for (const name of c.deprecatedNotes ?? []) {
    expectNote(resolved.notes, DEPRECATED_NOTE(name));
  }
  if (c.trust === "governed") {
    expect(resolved.notes.some((n) => n.includes("not an approved definition")), c.id).toBe(false);
  }
  const result = await kernel.query(input);
  expect(result.trust, `${c.id} executed`).toBe(c.trust);
  expect(result.provenance.trust, `${c.id} provenance`).toBe(c.trust);
  expect(result.notes, `${c.id} query notes`).toEqual(resolved.notes);
  if (c.values && !c.dimensions) {
    expect(result.rows).toHaveLength(1);
    for (const [field, expected] of Object.entries(c.values)) {
      expect(Number(result.rows[0]![field]), `${c.id} ${field}`).toBeCloseTo(expected, 10);
    }
  }
}

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

describe.skipIf(!duckdbOk)("native YAML status / trust matrix (DuckDB execute)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-status-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(FACTS_DDL);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(): GraneKernel {
    const k = new GraneKernel(syntheticConfig({ type: "duckdb", path, schema: "main" }));
    kernels.push(k);
    return k;
  }

  for (const c of EXECUTED_CASES) {
    it(`${c.id} ${c.metrics.join("+")}${c.dimensions ? " by " + c.dimensions.join(",") : ""}`, async () => {
      await assertExecuted(kernel(), c);
    });
  }
});

const PG_URL =
  process.env.GRANE_PG_WRITE_URL ?? "postgres://grane:grane@127.0.0.1:5432/grane_demo";

async function postgresUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: PG_URL, connectionTimeoutMillis: 2000 });
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}
const pgOk = await postgresUp();

describe.skipIf(!pgOk)("native YAML status / trust matrix (PostgreSQL execute)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_status_${Date.now().toString(36)}`;
  let pool: pg.Pool | null = null;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`SET search_path TO ${SCHEMA}`);
    await pool.query(FACTS_DDL);
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
    if (pool) {
      try {
        await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      } catch {
        // ignore
      }
      await pool.end();
    }
  });

  function kernel(): GraneKernel {
    const k = new GraneKernel(
      syntheticConfig({ type: "postgres", url: PG_URL, schema: SCHEMA }),
    );
    kernels.push(k);
    return k;
  }

  const representative = EXECUTED_CASES.filter((c) =>
    ["T1", "T2", "T3", "T8a", "T10", "T12", "T15", "T16"].includes(c.id),
  );
  for (const c of representative) {
    it(`${c.id} ${c.metrics.join("+")}`, async () => {
      await assertExecuted(kernel(), c);
    });
  }
});
