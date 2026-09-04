/**
 * MetricFlow time-window / metric-grain support boundary (#35).
 *
 * Independent of Oakwell. The fixture's daily totals are 10/100/20/300/40/500/60
 * (Dec 2025–Jun 2026) so a wrong window, grain, or offset cannot accidentally
 * match. MetricFlow 0.212 oracles for this fixture are recorded in comments
 * after `mf query` on the same YAML; Grane SQL is never the oracle.
 */
import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { WAREHOUSE_TYPES } from "../../src/connectors/dialect.js";
import { graneConfigSchema, type GraneConfig } from "../../src/config/schema.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import { serveHttp } from "../../src/mcp/transport.js";
import { mapMetricFlowGraph } from "../../src/providers/dbt/map.js";
import { parseDbtYamlFiles } from "../../src/providers/dbt/parse.js";
import type { SemanticQueryInput } from "../../src/query/model.js";
import { alignCivilRangeToGrain } from "../../src/query/time.js";

const execFileAsync = promisify(execFile);
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/mf-temporal");
const contribution = mapMetricFlowGraph(parseDbtYamlFiles(fixture));

const DDL = [
  `CREATE TABLE fct_daily (sale_id INTEGER, customer_id VARCHAR, sold_on DATE, amount DECIMAL(18,2), status VARCHAR)`,
  `INSERT INTO fct_daily VALUES
     (1,'c1','2025-12-01',1,'paid'), (2,'c1','2025-12-15',9,'paid'),
     (3,'c1','2026-01-01',10,'paid'), (4,'c1','2026-01-15',80,'paid'), (5,'c2','2026-01-15',10,'paid'),
     (6,'c1','2026-02-01',2,'paid'), (7,'c1','2026-02-20',18,'paid'),
     (8,'c1','2026-03-01',30,'paid'), (9,'c1','2026-03-31',270,'paid'),
     (10,'c1','2026-04-01',4,'paid'), (11,'c1','2026-04-15',36,'paid'),
     (12,'c1','2026-05-01',50,'paid'), (13,'c1','2026-05-20',450,'paid'),
     (14,'c1','2026-06-01',6,'paid'), (15,'c1','2026-06-15',54,'paid'),
     (16,'c1','2026-06-10',99,'void')`,
  `CREATE TABLE fct_monthly (snapshot_id INTEGER, customer_id VARCHAR, month_start DATE, ending_balance DECIMAL(18,2), new_amount DECIMAL(18,2))`,
  `INSERT INTO fct_monthly VALUES
     (1,'c1','2025-12-01',10,10), (2,'c1','2026-01-01',110,100), (3,'c1','2026-02-01',130,20),
     (4,'c1','2026-03-01',430,300), (5,'c1','2026-04-01',470,40), (6,'c1','2026-05-01',970,500),
     (7,'c1','2026-06-01',1030,60)`,
];

type DuckDbMod = {
  DuckDBInstance: {
    create: (path: string) => Promise<{
      connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync?: () => void; disconnectSync?: () => void }>;
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

async function buildWarehouse(): Promise<string> {
  const mod = (await import("@duckdb/node-api")) as unknown as DuckDbMod;
  const path = join(mkdtempSync(join(tmpdir(), "grane-mf-temporal-")), "t.duckdb");
  const instance = await mod.DuckDBInstance.create(path);
  const conn = await instance.connect();
  for (const statement of DDL) await conn.run(statement);
  conn.closeSync?.();
  conn.disconnectSync?.();
  instance.closeSync?.();
  return path;
}

function kernelFor(path: string, extra: Partial<GraneConfig> = {}): GraneKernel {
  return new GraneKernel(
    graneConfigSchema.parse({
      project: { name: "mf-temporal", timezone: "UTC" },
      connection: { type: "duckdb", path, schema: "main" },
      entities: contribution.entities,
      metrics: contribution.metrics,
      dimensions: contribution.dimensions,
      relationships: contribution.relationships,
      unsupported: contribution.unsupported,
      ...extra,
    }),
  );
}

function reasonFor(name: string): string | undefined {
  return contribution.unsupported.find((u) => u.kind === "metric" && u.name === name)?.reason;
}

async function refusalAsync(fn: () => Promise<unknown>): Promise<GraneError["refusal"]> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a refusal");
}

function refusal(fn: () => unknown): GraneError["refusal"] {
  try {
    fn();
  } catch (err) {
    if (err instanceof GraneError) return err.refusal;
    throw err;
  }
  throw new Error("expected a refusal");
}

const available = await duckdbAvailable();
const JAN = { from: "2026-01-01", to: "2026-01-31" };
const JUN = { from: "2026-06-01", to: "2026-06-30" };

describe("MetricFlow importer inventory (mf-temporal)", () => {
  it("imports simple, ratio, derived-ratio, filter, and semi-additive; skips windowed constructs", () => {
    expect(contribution.metrics.revenue?.type).toBe("sum");
    expect(contribution.metrics.revenue?.time_granularity).toBe("day");
    expect(contribution.metrics.sale_count?.type).toBe("count");
    expect(contribution.metrics.distinct_customers?.type).toBe("count_distinct");
    expect(contribution.metrics.paid_revenue?.filters).toEqual(
      expect.arrayContaining([expect.objectContaining({ operator: "=" })]),
    );
    expect(contribution.metrics.paid_rate?.type).toBe("ratio");
    expect(contribution.metrics.revenue_per_sale?.type).toBe("ratio");
    expect(contribution.metrics.ending_balance).toEqual(
      expect.objectContaining({
        additive: "semi",
        time_granularity: "month",
        semi_additive: { window: "last", group_by: [], granularity: "month" },
      }),
    );
    expect(contribution.metrics.new_amount?.time_granularity).toBe("month");
    expect(contribution.metrics.new_amount?.additive).not.toBe("semi");
    expect(reasonFor("trailing_7d_revenue")).toMatch(/cumulative.*window 7 days/);
    expect(reasonFor("trailing_3m_new_amount")).toMatch(/cumulative.*window 3 months/);
    expect(reasonFor("revenue_mtd")).toMatch(/grain_to_date month/);
    expect(reasonFor("revenue_qtd")).toMatch(/grain_to_date quarter/);
    expect(reasonFor("revenue_ytd")).toMatch(/grain_to_date year/);
    expect(reasonFor("all_time_revenue")).toMatch(/"cumulative" is not compiled/);
    expect(reasonFor("prior_month_balance")).toMatch(/offset_window "1 month"/);
    expect(reasonFor("balance_vs_trailing")).toMatch(/trailing_3m_new_amount/);
    expect(contribution.metrics.trailing_7d_revenue).toBeUndefined();
    expect(contribution.metrics.prior_month_balance).toBeUndefined();
    expect(contribution.metrics.balance_vs_trailing).toBeUndefined();
  });
});

describe("civil range alignment helpers", () => {
  it("expands overlapping months, leap February, and year boundaries", () => {
    expect(alignCivilRangeToGrain("2026-08-02", "2026-08-15", "month")).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
    expect(alignCivilRangeToGrain("2026-07-15", "2026-08-15", "month")).toEqual({
      from: "2026-07-01",
      to: "2026-08-31",
    });
    expect(alignCivilRangeToGrain("2024-02-15", "2024-02-20", "month")).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
    });
    expect(alignCivilRangeToGrain("2025-12-15", "2026-01-10", "month")).toEqual({
      from: "2025-12-01",
      to: "2026-01-31",
    });
    expect(alignCivilRangeToGrain("2026-05-20", "2026-05-20", "quarter")).toEqual({
      from: "2026-04-01",
      to: "2026-06-30",
    });
    expect(alignCivilRangeToGrain("2026-03-02", "2026-03-02", "year")).toEqual({
      from: "2026-01-01",
      to: "2026-12-31",
    });
    expect(alignCivilRangeToGrain("2026-07-02", "2026-07-31", "day")).toEqual({
      from: "2026-07-02",
      to: "2026-07-31",
    });
  });
});

describe.skipIf(!available)("mf-temporal vs MetricFlow oracles", () => {
  if (!available) return;
  let path: string;
  let kernel: GraneKernel;
  beforeAll(async () => {
    path = await buildWarehouse();
    kernel = kernelFor(path);
  });
  afterAll(() => kernel.close());

  const n = async (q: SemanticQueryInput, metric: string) => {
    const result = await kernel.query(q);
    expect(result.trust).toBe("governed");
    return Number(result.rows[0]?.[metric]);
  };

  it("control simple SUM / COUNT / COUNT DISTINCT / ratio / filter / day grain", async () => {
    // MF: paid_revenue 2026-01-01..2026-01-31 = 100 (10+80+10)
    expect(await n({ metrics: ["paid_revenue"], time: JAN }, "paid_revenue")).toBe(100);
    // MF: sale_count January = 3
    expect(await n({ metrics: ["sale_count"], time: JAN }, "sale_count")).toBe(3);
    // MF: distinct_customers January = 2
    expect(await n({ metrics: ["distinct_customers"], time: JAN }, "distinct_customers")).toBe(2);
    // MF: paid_rate January = 100/3
    expect(await n({ metrics: ["paid_rate"], time: JAN }, "paid_rate")).toBeCloseTo(100 / 3, 10);
    // MF: revenue_per_sale January = 100/3 (void is in June)
    expect(await n({ metrics: ["revenue_per_sale"], time: JAN }, "revenue_per_sale")).toBeCloseTo(100 / 3, 10);
    // Day grain is not expanded: 2026-01-02..01-31 excludes the Jan 1 row of 10.
    expect(await n({ metrics: ["paid_revenue"], time: { from: "2026-01-02", to: "2026-01-31" } }, "paid_revenue")).toBe(90);
  });

  it("control semi-additive and additive month-grain on complete months", async () => {
    // MF: ending_balance June = 1030; new_amount June = 60
    expect(await n({ metrics: ["ending_balance"], time: JUN }, "ending_balance")).toBe(1030);
    expect(await n({ metrics: ["new_amount"], time: JUN }, "new_amount")).toBe(60);
    expect(await n({ metrics: ["ending_balance"], time: JAN }, "ending_balance")).toBe(110);
  });

  it("month-grain partial windows align to complete overlapping months (MetricFlow query-window alignment)", async () => {
    // Parent governed-wrong: civil Aug-style clip of a month-start DATE returned 0 governed.
    // MF ending_balance 2026-06-02..06-30 → June snapshot 1030 (SQL BETWEEN '2026-06-01' AND '2026-06-30').
    const partialJune = await kernel.query({
      metrics: ["ending_balance"],
      time: { from: "2026-06-02", to: "2026-06-30" },
    });
    expect(partialJune.trust).toBe("governed");
    expect(Number(partialJune.rows[0]?.ending_balance)).toBe(1030);
    expect(partialJune.notes.some((note) => note.includes("aligned to month grain 2026-06-01..2026-06-30"))).toBe(true);
    // Additive: Jul 15–Aug 15 analogue is May 20–Jun 15 → May+June new_amount = 500+60
    expect(
      await n({ metrics: ["new_amount"], time: { from: "2026-05-20", to: "2026-06-15" } }, "new_amount"),
    ).toBe(560);
    expect(
      await n({ metrics: ["ending_balance"], time: { from: "2026-05-20", to: "2026-06-15" } }, "ending_balance"),
    ).toBe(1030);
  });

  it("refuses output grain finer than the metric's native grain", async () => {
    const refused = await refusalAsync(() =>
      kernel.query({ metrics: ["ending_balance"], time: { ...JUN, grain: "day" } }),
    );
    expect(refused.status).toBe("unsafe_query");
    expect(refused.message).toMatch(/ending_balance.*month grain/);
    expect(refused.details).toEqual(
      expect.objectContaining({ metric: "ending_balance", time_granularity: "month", requested_grain: "day" }),
    );
  });

  it("refuses mixing month-grain and civil-day metrics in one civil range", async () => {
    const entity = contribution.metrics.new_amount!.entity;
    const timeDim = contribution.metrics.new_amount!.time_dimension;
    const k = kernelFor(path, {
      metrics: {
        ...contribution.metrics,
        month_rows: {
          entity,
          type: "count",
          time_dimension: timeDim,
        },
      },
    });
    try {
      const refused = await refusalAsync(() => k.query({ metrics: ["new_amount", "month_rows"], time: JUN }));
      expect(refused.status).toBe("unsafe_query");
      expect(refused.message).toMatch(/mixes month-grain/);
    } finally {
      await k.close();
    }
  });

  it("unsupported cumulative / offset / dependency cannot execute as governed", async () => {
    for (const name of [
      "trailing_7d_revenue",
      "trailing_3m_new_amount",
      "revenue_mtd",
      "revenue_qtd",
      "revenue_ytd",
      "all_time_revenue",
      "prior_month_balance",
      "balance_vs_trailing",
    ]) {
      const r = await refusalAsync(() => kernel.query({ metrics: [name], time: JUN }));
      expect(r.status, name).toBe("undefined_metric");
      expect(r.details, name).toEqual(expect.objectContaining({ unsupported: expect.objectContaining({ provider: "dbt" }) }));
      expect(kernel.governedCatalog().metrics.some((m) => m.name === name)).toBe(false);
      expect(kernel.governedCatalog().unsupported.some((u) => u.name === name)).toBe(true);
    }
  });

  it("catalog / resolve / compile / explain / execute agree on retained and skipped metrics", async () => {
    const catalog = kernel.governedCatalog();
    expect(catalog.metrics.find((m) => m.name === "ending_balance")?.time_granularity).toBe("month");
    expect(catalog.metrics.find((m) => m.name === "revenue")?.time_granularity).toBe("day");
    const q = { metrics: ["paid_revenue"], time: JAN };
    const resolved = kernel.resolve(q);
    const compiled = kernel.compile(q);
    const explained = await kernel.explain(q);
    const executed = await kernel.query(q);
    expect(resolved.time?.from).toBe("2026-01-01");
    expect(compiled.compiled.sql).toMatch(/paid_revenue/);
    expect(explained.generated_sql).toBe(compiled.compiled.sql);
    expect(executed.trust).toBe("governed");
    const skipQ = { metrics: ["trailing_7d_revenue"], time: JAN };
    const skipResolve = refusal(() => kernel.resolve(skipQ));
    const skipCompile = refusal(() => kernel.compile(skipQ));
    const skipExplain = await refusalAsync(() => kernel.explain(skipQ));
    const skipExec = await refusalAsync(() => kernel.query(skipQ));
    expect(skipResolve).toEqual(skipCompile);
    expect(skipCompile).toEqual(skipExplain);
    expect(skipExplain).toEqual(skipExec);
  });

  it("all dialects compile retained month-grain and day-grain queries", () => {
    for (const type of WAREHOUSE_TYPES) {
      kernel.config.connection.type = type;
      if (type === "bigquery") {
        kernel.config.connection.project = "acme";
        kernel.config.connection.dataset = "analytics";
      }
      if (type === "databricks") {
        kernel.config.connection.catalog = "main";
        kernel.config.connection.schema = "main";
      }
      const month = kernel.compile({ metrics: ["ending_balance"], time: { from: "2026-06-02", to: "2026-06-30" } });
      expect(month.compiled.sql, type).toMatch(/ending_balance/);
      expect(month.resolved.time?.from, type).toBe("2026-06-01");
      expect(month.resolved.time?.to, type).toBe("2026-06-30");
      const day = kernel.compile({ metrics: ["paid_revenue"], time: { from: "2026-01-02", to: "2026-01-31" } });
      expect(day.resolved.time?.from, type).toBe("2026-01-02");
      const skipped = refusal(() => kernel.compile({ metrics: ["revenue_ytd"], time: JAN }));
      expect(skipped.status, type).toBe("undefined_metric");
    }
    kernel.config.connection.type = "duckdb";
    kernel.config.connection.schema = "main";
    kernel.config.connection.project = undefined;
    kernel.config.connection.dataset = undefined;
    kernel.config.connection.catalog = undefined;
  });

  it("MCP catalog lists skips and query refuses them with a Grane-owned reason", async () => {
    const handle = await serveHttp(kernel, 0);
    const client = new Client({ name: "grane-mf-temporal", version: "0.0.1" });
    try {
      const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${handle.port}/mcp`));
      await client.connect(transport);
      const parse = (result: Awaited<ReturnType<Client["callTool"]>>) => {
        const content = result.content as { type: string; text: string }[];
        const text = content[0]!.text;
        const start = text.indexOf("{");
        return JSON.parse(start >= 0 ? text.slice(start) : text) as Record<string, unknown>;
      };
      const catalog = parse(await client.callTool({ name: "catalog", arguments: { search: "trailing" } }));
      const unsupported = catalog.unsupported as { name: string; reason: string }[];
      expect(unsupported.some((u) => u.name === "trailing_7d_revenue" && /cumulative/.test(u.reason))).toBe(true);
      const ok = parse(
        await client.callTool({
          name: "query",
          arguments: { query: { metrics: ["paid_revenue"], time: JAN } },
        }),
      );
      expect(ok.trust).toBe("governed");
      const bad = await client.callTool({
        name: "query",
        arguments: { query: { metrics: ["trailing_7d_revenue"], time: JAN } },
      });
      expect(bad.isError).toBe(true);
      const refusalJson = parse(bad);
      expect(refusalJson.status).toBe("undefined_metric");
      expect(String(refusalJson.message)).not.toMatch(/Binder Error|Catalog Error|does not exist/i);
    } finally {
      await client.close();
      await handle.close();
    }
  });

  it("CLI --sql / query --json execute retained metrics and refuse skipped ones", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-mf-temporal-cli-"));
    writeFileSync(
      join(dir, "grane.yml"),
      [
        "project:",
        "  name: mf-temporal-cli",
        "  timezone: UTC",
        "connection:",
        "  type: duckdb",
        `  path: ${JSON.stringify(path)}`,
        "  schema: main",
        "providers:",
        "  - type: dbt",
        `    path: ${JSON.stringify(fixture)}`,
        "",
      ].join("\n"),
    );
    const cli = join(process.cwd(), "src/cli/index.ts");
    const run = async (args: string[]) => {
      try {
        const out = await execFileAsync("npx", ["tsx", cli, "-p", dir, ...args], { cwd: process.cwd(), timeout: 30000 });
        return { code: 0, stdout: out.stdout, stderr: "" };
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string };
        return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
      }
    };
    const sql = await run(["query", "ending_balance", "--from", "2026-06-02", "--to", "2026-06-30", "--sql"]);
    expect(sql.code).toBe(0);
    expect(sql.stdout).toMatch(/ending_balance/);
    const json = await run(["query", "ending_balance", "--from", "2026-06-02", "--to", "2026-06-30", "--json"]);
    expect(json.code).toBe(0);
    const payload = JSON.parse(json.stdout) as { trust: string; rows: { ending_balance: number }[]; notes: string[] };
    expect(payload.trust).toBe("governed");
    expect(Number(payload.rows[0]!.ending_balance)).toBe(1030);
    const skipped = await run(["query", "trailing_7d_revenue", "--from", "2026-06-01", "--to", "2026-06-30", "--json"]);
    expect(skipped.code).not.toBe(0);
    expect(skipped.stderr + skipped.stdout).toMatch(/undefined_metric|did not import/i);
  });

  it("#20 untimed composition still refuses a time range", async () => {
    const k = new GraneKernel(
      graneConfigSchema.parse({
        project: { name: "untimed-35", timezone: "UTC" },
        connection: { type: "duckdb", path, schema: "main" },
        entities: { sale: { table: "fct_daily", primary_key: "sale_id" } },
        metrics: {
          headcount: { entity: "sale", type: "count" },
          revenue: { entity: "sale", type: "sum", sql: "${fct_daily.amount}", time_dimension: "${fct_daily.sold_on}" },
        },
      }),
    );
    try {
      const refused = await refusalAsync(() =>
        k.query({ metrics: ["headcount", "revenue"], time: JAN }),
      );
      expect(refused.status).toBe("ambiguous_query");
      expect(refused.message).toMatch(/no time_dimension/);
    } finally {
      await k.close();
    }
  });
});
