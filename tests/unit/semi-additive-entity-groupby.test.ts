/**
 * Semi-additive snapshot series keys vs the snapshot table's own primary
 * identity. A last/first snapshot must not silently become an additive sum
 * of historical rows when group_by is the surrogate row key.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { graneConfigSchema } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { vacuousSnapshotSeriesKeys } from "../../src/model/model.js";
import { mapMetricFlowGraph } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";

const DDL = `
  CREATE TABLE snapshots (
    row_id INTEGER,
    customer_id INTEGER,
    snapshot_date DATE,
    balance DOUBLE PRECISION,
    segment VARCHAR,
    region VARCHAR
  );
  INSERT INTO snapshots VALUES
    (1, 1, DATE '2026-01-01', 100, 'ent', 'US'),
    (2, 1, DATE '2026-02-01', 120, 'ent', 'US'),
    (3, 1, DATE '2026-03-01', 160, 'ent', 'US'),
    (4, 2, DATE '2026-01-01',  50, 'smb', 'DE'),
    (5, 2, DATE '2026-02-01',  60, 'smb', 'DE'),
    (6, 2, DATE '2026-03-01',  70, 'smb', 'DE'),
    (7, 3, DATE '2026-02-01',  20, 'smb', 'UK');
  CREATE TABLE customers (customer_id INTEGER PRIMARY KEY, country VARCHAR);
  INSERT INTO customers VALUES (1, 'US'), (2, 'DE'), (3, 'UK');
  CREATE TABLE dup_customers (customer_id INTEGER, country VARCHAR);
  INSERT INTO dup_customers VALUES (1, 'US'), (1, 'US');
`;

function metrics() {
  const semi = (
    entity: string,
    extra: Record<string, unknown> = {},
  ) => ({
    entity,
    type: "sum",
    sql: "${snapshots.balance}",
    time_dimension: "${snapshots.snapshot_date}",
    additive: "semi",
    ...extra,
  });
  return {
    last_global: semi("snap_row", { semi_additive: { window: "last", group_by: [] } }),
    first_global: semi("snap_row", { semi_additive: { window: "first", group_by: [] } }),
    last_customer: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.customer_id}"] },
    }),
    first_customer: semi("snap_row", {
      semi_additive: { window: "first", group_by: ["${snapshots.customer_id}"] },
    }),
    last_row_default: semi("snap_row"),
    last_row_explicit: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.row_id}"] },
    }),
    last_row_and_customer: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.customer_id}", "${snapshots.row_id}"] },
    }),
    last_customer_and_row: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.row_id}", "${snapshots.customer_id}"] },
    }),
    last_customer_primary: semi("snap_customer"),
    first_customer_primary: semi("snap_customer", { semi_additive: { window: "first" } }),
    last_region: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.region}"] },
    }),
    last_customer_region: semi("snap_row", {
      semi_additive: {
        window: "last",
        group_by: ["${snapshots.customer_id}", "${snapshots.region}"],
      },
    }),
    last_filtered: semi("snap_row", {
      semi_additive: { window: "last", group_by: [] },
      filters: { "snapshots.segment": "ent" },
    }),
    last_customer_filtered: semi("snap_row", {
      semi_additive: { window: "last", group_by: ["${snapshots.customer_id}"] },
      filters: { "snapshots.segment": "ent" },
    }),
    additive_balance: {
      entity: "snap_row",
      type: "sum",
      sql: "${snapshots.balance}",
      time_dimension: "${snapshots.snapshot_date}",
    },
  };
}

function dimensions() {
  return {
    segment: { entity: "snap_row", sql: "${snapshots.segment}" },
    region: { entity: "snap_row", sql: "${snapshots.region}" },
    country: { entity: "customer", sql: "${customers.country}" },
    dup_country: { entity: "dup_customer", sql: "${dup_customers.country}" },
  };
}

function config(connection: Record<string, unknown>, withBusinessLink: boolean, withDup = false) {
  return graneConfigSchema.parse({
    project: { name: "semi-entity", timezone: "UTC" },
    connection,
    entities: {
      snap_row: { table: "snapshots", primary_key: "row_id" },
      snap_customer: { table: "snapshots", primary_key: "customer_id" },
      customer: { table: "customers", primary_key: "customer_id" },
      ...(withDup ? { dup_customer: { table: "dup_customers", primary_key: "customer_id" } } : {}),
    },
    metrics: metrics(),
    dimensions: dimensions(),
    relationships: {
      ...(withBusinessLink
        ? { snaps_customers: { from: "snapshots.customer_id", to: "customers.customer_id", type: "many_to_one" } }
        : {}),
      ...(withDup
        ? { snaps_dups: { from: "snapshots.customer_id", to: "dup_customers.customer_id", type: "many_to_one" } }
        : {}),
    },
  });
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

const Q1 = { from: "2026-01-01", to: "2026-03-31" };
const MAR = { from: "2026-03-01", to: "2026-03-31" };

describe("vacuous snapshot series keys (static)", () => {
  it("treats a surrogate entity PK with no business relationship as vacuous", () => {
    const k = new GraneKernel(config({ type: "postgres", schema: "public" }, false));
    const row = k.model.metrics.get("last_row_default")!;
    expect(vacuousSnapshotSeriesKeys(k.model, row).map((c) => c.column)).toEqual(["row_id"]);
    const explicit = k.model.metrics.get("last_row_explicit")!;
    expect(vacuousSnapshotSeriesKeys(k.model, explicit).map((c) => c.column)).toEqual(["row_id"]);
    const mixed = k.model.metrics.get("last_row_and_customer")!;
    expect(vacuousSnapshotSeriesKeys(k.model, mixed).map((c) => c.column)).toEqual(["row_id"]);
    const reversed = k.model.metrics.get("last_customer_and_row")!;
    expect(vacuousSnapshotSeriesKeys(k.model, reversed).map((c) => c.column)).toEqual(["row_id"]);
  });

  it("does not treat empty group_by or a non-PK series column as vacuous", () => {
    const k = new GraneKernel(config({ type: "postgres", schema: "public" }, false));
    expect(vacuousSnapshotSeriesKeys(k.model, k.model.metrics.get("last_global")!)).toEqual([]);
    expect(vacuousSnapshotSeriesKeys(k.model, k.model.metrics.get("last_customer")!)).toEqual([]);
    expect(vacuousSnapshotSeriesKeys(k.model, k.model.metrics.get("last_region")!)).toEqual([]);
  });

  it("treats the entity PK as vacuous even when a many_to_one is declared on it", () => {
    const bare = new GraneKernel(config({ type: "postgres", schema: "public" }, false));
    const related = new GraneKernel(config({ type: "postgres", schema: "public" }, true));
    const primary = "last_customer_primary";
    expect(vacuousSnapshotSeriesKeys(bare.model, bare.model.metrics.get(primary)!).map((c) => c.column)).toEqual([
      "customer_id",
    ]);
    expect(vacuousSnapshotSeriesKeys(related.model, related.model.metrics.get(primary)!).map((c) => c.column)).toEqual([
      "customer_id",
    ]);
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

describe.skipIf(!duckdbOk)("semi-additive entity group_by (DuckDB execute)", () => {
  const kernels: GraneKernel[] = [];
  let path: string;

  beforeAll(async () => {
    const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
    path = join(mkdtempSync(join(tmpdir(), "grane-semi-entity-")), "db.duckdb");
    const instance = await mod.DuckDBInstance.create(path);
    const conn = await instance.connect();
    await conn.run(DDL);
    conn.closeSync?.();
    conn.disconnectSync?.();
    instance.closeSync?.();
  });

  afterAll(async () => {
    await Promise.all(kernels.map((k) => k.close()));
  });

  function kernel(withBusinessLink: boolean, withDup = false): GraneKernel {
    const k = new GraneKernel(config({ type: "duckdb", path, schema: "main" }, withBusinessLink, withDup));
    kernels.push(k);
    return k;
  }

  async function value(k: GraneKernel, metric: string, extra: Record<string, unknown> = {}): Promise<number> {
    const result = await k.query({ metrics: [metric], ...extra });
    expect(result.trust).toBe("governed");
    expect(result.rows).toHaveLength(1);
    return Number(result.rows[0]![metric]);
  }

  it("S1–S4 / CASE A: global [] last is 230; first is 150; numbers ignore status", async () => {
    const k = kernel(false);
    expect(await value(k, "last_global", { time: Q1 })).toBe(230);
    expect(await value(k, "first_global", { time: Q1 })).toBe(150);
    expect(await value(k, "last_global", { time: MAR })).toBe(230);
    expect(await value(k, "last_global")).toBe(230);
  });

  it("CASE B: per-customer last keeps C's February 20; global last does not", async () => {
    const k = kernel(false);
    expect(await value(k, "last_customer", { time: Q1 })).toBe(250);
    expect(await value(k, "first_customer", { time: Q1 })).toBe(170);
    expect(await value(k, "last_global", { time: Q1 })).toBe(230);
  });

  it("CASE C: surrogate row primary as series is refused (default, explicit, either key order)", async () => {
    const k = kernel(false);
    for (const metric of ["last_row_default", "last_row_explicit", "last_row_and_customer", "last_customer_and_row"]) {
      const r = refusal(() => k.compile({ metrics: [metric], time: Q1 }));
      expect(r.status, metric).toBe("unsafe_query");
      expect(r.message, metric).toMatch(/own primary key/);
      expect(k.validate().issues.some((i) => i.code === "vacuous_semi_additive_group_by" && i.message.includes(metric))).toBe(
        true,
      );
    }
  });

  it("customer-as-primary is refused with or without a business relationship", async () => {
    const bare = kernel(false);
    const related = kernel(true);
    expect(refusal(() => bare.compile({ metrics: ["last_customer_primary"], time: Q1 })).status).toBe("unsafe_query");
    expect(refusal(() => related.compile({ metrics: ["last_customer_primary"], time: Q1 })).status).toBe("unsafe_query");
    expect(refusal(() => related.compile({ metrics: ["first_customer_primary"], time: Q1 })).status).toBe("unsafe_query");
    expect(related.validate().issues.some((i) => i.code === "vacuous_semi_additive_group_by")).toBe(true);
  });

  it("query dimensions do not change snapshot selection", async () => {
    const k = kernel(true);
    const global = await k.query({ metrics: ["last_global"], dimensions: ["segment"], time: Q1 });
    expect(global.trust).toBe("governed");
    const bySeg = Object.fromEntries(global.rows.map((r) => [String(r.segment), Number(r.last_global)]));
    expect(bySeg).toEqual({ ent: 160, smb: 70 });
    const perCust = await k.query({ metrics: ["last_customer"], dimensions: ["segment"], time: Q1 });
    const byCustSeg = Object.fromEntries(perCust.rows.map((r) => [String(r.segment), Number(r.last_customer)]));
    expect(byCustSeg).toEqual({ ent: 160, smb: 90 });
    const joined = await k.query({ metrics: ["last_customer"], dimensions: ["country"], time: Q1 });
    expect(joined.trust).toBe("governed");
    const byCountry = Object.fromEntries(joined.rows.map((r) => [String(r.country), Number(r.last_customer)]));
    expect(byCountry).toEqual({ US: 160, DE: 70, UK: 20 });
  });

  it("base-table filters participate in snapshot selection (PR #19)", async () => {
    const k = kernel(false);
    expect(await value(k, "last_global", { time: Q1, filters: [{ field: "segment", operator: "=", value: "ent" }] })).toBe(
      160,
    );
    expect(await value(k, "last_filtered", { time: Q1 })).toBe(160);
    expect(await value(k, "last_customer_filtered", { time: Q1 })).toBe(160);
    expect(
      await value(k, "last_customer", { time: Q1, filters: [{ field: "segment", operator: "in", value: ["ent", "smb"] }] }),
    ).toBe(250);
  });

  it("joined-dimension filter and cardinality guards still apply", async () => {
    const k = kernel(true);
    expect(
      await value(k, "last_customer", {
        time: Q1,
        filters: [{ field: "country", operator: "=", value: "US" }],
      }),
    ).toBe(160);
    const dup = kernel(true, true);
    const r = await refusalAsync(() =>
      dup.query({ metrics: ["last_customer"], dimensions: ["dup_country"], time: Q1 }),
    );
    expect(r.status).toBe("unsafe_query");
  });

  it("week grain + monday start still compiles for a safe series; row PK still refuses", async () => {
    const k = kernel(false);
    const week = await k.query({ metrics: ["last_global"], time: { ...Q1, grain: "week" } });
    expect(week.trust).toBe("governed");
    expect(week.rows.length).toBeGreaterThan(0);
    expect(refusal(() => k.compile({ metrics: ["last_row_default"], time: { ...Q1, grain: "month" } })).status).toBe(
      "unsafe_query",
    );
  });

  it("DATE snapshot + America/New_York does not move the civil last date", async () => {
    const utc = kernel(false);
    const ny = new GraneKernel(
      graneConfigSchema.parse({
        ...config({ type: "duckdb", path, schema: "main" }, false),
        project: { name: "semi-entity", timezone: "America/New_York" },
      }),
    );
    kernels.push(ny);
    expect(await value(utc, "last_global", { time: Q1 })).toBe(230);
    expect(await value(ny, "last_global", { time: Q1 })).toBe(230);
  });

  it("unsafe component cannot be laundered through a ratio or companion metric", async () => {
    const k = kernel(false);
    expect(refusal(() => k.compile({ metrics: ["last_row_default", "last_global"] })).status).toBe("unsafe_query");
    expect(refusal(() => k.compile({ metrics: ["last_global", "last_row_default"] })).status).toBe("unsafe_query");
    expect(refusal(() => k.compile({ metrics: ["last_row_default", "additive_balance"] })).status).toBe("unsafe_query");
  });

  it("approved vs experimental status does not change the snapshot number", async () => {
    const k = kernel(false);
    const experimental = new GraneKernel(
      graneConfigSchema.parse({
        ...config({ type: "duckdb", path, schema: "main" }, false),
        metrics: {
          ...metrics(),
          last_global: { ...metrics().last_global, status: "experimental" },
        },
      }),
    );
    kernels.push(experimental);
    const gov = await k.query({ metrics: ["last_global"], time: Q1 });
    const mix = await experimental.query({ metrics: ["last_global"], time: Q1 });
    expect(gov.trust).toBe("governed");
    expect(mix.trust).toBe("mixed");
    expect(Number(gov.rows[0]!.last_global)).toBe(Number(mix.rows[0]!.last_global));
    expect(Number(mix.rows[0]!.last_global)).toBe(230);
  });
});

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
    throw new Error("expected refusal");
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
}

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

describe.skipIf(!pgOk)("semi-additive entity group_by (PostgreSQL execute)", () => {
  const kernels: GraneKernel[] = [];
  const SCHEMA = `grane_semi_${Date.now().toString(36)}`;
  let pool: pg.Pool | null = null;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: PG_URL });
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`SET search_path TO ${SCHEMA}`);
    await pool.query(DDL);
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

  function kernel(withBusinessLink: boolean): GraneKernel {
    const k = new GraneKernel(config({ type: "postgres", url: PG_URL, schema: SCHEMA }, withBusinessLink));
    kernels.push(k);
    return k;
  }

  it("global last 230, per-customer last 250, row PK and related customer-primary refused", async () => {
    const bare = kernel(false);
    const related = kernel(true);
    const g = await bare.query({ metrics: ["last_global"], time: Q1 });
    expect(g.trust).toBe("governed");
    expect(Number(g.rows[0]!.last_global)).toBe(230);
    const c = await bare.query({ metrics: ["last_customer"], time: Q1 });
    expect(Number(c.rows[0]!.last_customer)).toBe(250);
    expect(refusal(() => bare.compile({ metrics: ["last_row_default"] })).status).toBe("unsafe_query");
    expect(refusal(() => related.compile({ metrics: ["last_customer_primary"] })).status).toBe("unsafe_query");
  });
});

describe("MetricFlow primary-entity group_by is not imported", () => {
  it("skips a snapshot grouped by the model's primary or unique entity", () => {
    const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/dbt-saas");
    const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));
    const primary = contribution.unsupported.find((u) => u.name === "mrr_primary_group")?.reason;
    expect(primary).toMatch(/primary entity/);
    expect(contribution.metrics.mrr_primary_group).toBeUndefined();
    const unique = contribution.unsupported.find((u) => u.name === "mrr_unique_group")?.reason;
    expect(unique).toMatch(/unique entity/);
    expect(contribution.metrics.mrr_unique_group).toBeUndefined();
    expect(contribution.metrics.ending_mrr_by_customer?.semi_additive?.group_by).toEqual([
      "${fct_mrr_snapshot.customer_id}",
    ]);
    expect(contribution.metrics.ending_mrr?.semi_additive?.group_by).toEqual([]);
  });
});
