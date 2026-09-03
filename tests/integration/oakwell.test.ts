/**
 * Oakwell interoperability (integration): Grane's dbt provider over the
 * independent Oakwell dbt/MetricFlow fixture, compared with MetricFlow.
 *
 * Runs only when the fixture and its built DuckDB warehouse are present:
 *   GRANE_OAKWELL_PROJECT  dbt project dir   (default /agent/dbt-test-project)
 *   GRANE_OAKWELL_DUCKDB   built warehouse   (default /tmp/oakwell-build/data/oakwell.duckdb)
 *
 * The fixture is read-only; the warehouse is built from a copy with
 * `dbt build`. Expected values come from `validation/ground_truth.json` and,
 * for the snapshot regression, from `mf query --decimals 2` on the same build.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { classifyTemporalType } from "../../src/connectors/dialect.js";
import { columnDataType } from "../../src/connectors/types.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneError } from "../../src/errors.js";
import { GraneKernel } from "../../src/kernel.js";
import type { SemanticQueryInput } from "../../src/query/model.js";

const PROJECT = process.env.GRANE_OAKWELL_PROJECT ?? "/agent/dbt-test-project";
const WAREHOUSE = process.env.GRANE_OAKWELL_DUCKDB ?? "/tmp/oakwell-build/data/oakwell.duckdb";
const GROUND_TRUTH = join(PROJECT, "validation/ground_truth.json");

async function duckdbAvailable(): Promise<boolean> {
  try {
    await import("@duckdb/node-api");
    return true;
  } catch {
    return false;
  }
}
const available = existsSync(GROUND_TRUTH) && existsSync(WAREHOUSE) && (await duckdbAvailable());

interface GtCase {
  id: string;
  mf: { metrics: string[]; group_by?: string[]; start_time: string; end_time: string; where?: string };
  result_type: "scalar" | "table";
  tolerance: number;
  expected: { value?: number; rows?: Record<string, unknown>[] };
  dimensions: string[];
}

describe.skipIf(!available)("Oakwell interop (dbt provider vs MetricFlow)", () => {
  if (!available) return;
  const dir = mkdtempSync(join(tmpdir(), "grane-oakwell-"));
  writeFileSync(
    join(dir, "grane.yml"),
    [
      "project:",
      "  name: oakwell-interop",
      "  timezone: UTC",
      "connection:",
      "  type: duckdb",
      `  path: ${JSON.stringify(WAREHOUSE)}`,
      "  schema: main",
      "providers:",
      "  - type: dbt",
      `    path: ${JSON.stringify(PROJECT)}`,
      "",
    ].join("\n"),
  );
  const loaded = loadConfig(dir);
  const kernel = new GraneKernel(loaded.config, { projectDir: loaded.projectDir, providerWarnings: loaded.warnings });
  const unsupportedMetrics = new Set(
    kernel.governedCatalog().unsupported.filter((u) => u.kind === "metric").map((u) => u.name),
  );
  afterAll(() => kernel.close());

  /** MetricFlow `entity__dimension` identity → Grane dimension name (preserved in the imported description). */
  const dimension = (identity: string): string => {
    const hit = Object.entries(loaded.config.dimensions).find(([, d]) => d.description?.includes(`MetricFlow dimension ${identity} `));
    if (!hit) throw new Error(`no Grane dimension for ${identity}`);
    return hit[0];
  };
  const keyOf = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v));
  const close = (a: number, b: number, tolerance = 0.01) => Math.abs(a - b) <= tolerance + 1e-9;

  const toQuery = (c: GtCase): SemanticQueryInput => {
    const dims: string[] = [];
    let grain: "month" | undefined;
    for (const g of c.mf.group_by ?? []) {
      if (g === "metric_time" || g.startsWith("metric_time__")) grain = "month";
      else dims.push(dimension(g));
    }
    const filters: NonNullable<SemanticQueryInput["filters"]> = [];
    if (c.mf.where) {
      const m = c.mf.where.match(/^\{\{\s*Dimension\('([^']+)'\)\s*\}\}\s*=\s*'([^']*)'$/);
      if (!m) throw new Error(`unparsed where: ${c.mf.where}`);
      filters.push({ field: dimension(m[1]!), operator: "=", value: m[2]! });
    }
    return { metrics: c.mf.metrics, dimensions: dims, filters, time: { from: c.mf.start_time, to: c.mf.end_time, ...(grain ? { grain } : {}) } };
  };

  const cases = JSON.parse(readFileSync(GROUND_TRUTH, "utf8")) as GtCase[];

  it("matches every stored ground truth or refuses with a catalogued reason", async () => {
    const outcomes: string[] = [];
    for (const c of cases) {
      const metric = c.mf.metrics[0]!;
      try {
        const result = await kernel.query(toQuery(c));
        expect(result.trust, c.id).toBe("governed");
        if (c.result_type === "scalar") {
          expect(result.rows, c.id).toHaveLength(1);
          expect(close(Number(result.rows[0]![metric]), c.expected.value!, c.tolerance), `${c.id} ${metric}`).toBe(true);
        } else {
          const graneDim = Object.keys(result.rows[0] ?? {}).find((k) => k !== metric)!;
          const actual = new Map(result.rows.map((r) => [keyOf(r[graneDim]), Number(r[metric])]));
          expect(actual.size, c.id).toBe(c.expected.rows!.length);
          for (const row of c.expected.rows!) {
            const got = actual.get(String(row[c.dimensions[0]!]));
            expect(got, `${c.id} ${String(row[c.dimensions[0]!])}`).toBeDefined();
            expect(close(got!, Number(row[metric]), c.tolerance), `${c.id} ${String(row[c.dimensions[0]!])}`).toBe(true);
          }
        }
        outcomes.push("match");
      } catch (err) {
        if (!(err instanceof GraneError)) throw err;
        // Only metrics Grane explicitly declined to import may refuse (GT-013 net_new_mrr, a derived expr).
        expect(unsupportedMetrics.has(metric), `${c.id} refused: ${err.refusal.message}`).toBe(true);
        expect(err.refusal.status).toBe("undefined_metric");
        outcomes.push("refusal");
      }
    }
    expect(outcomes.filter((o) => o === "refusal")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "match")).toHaveLength(cases.length - 1);
  });

  describe("semi-additive snapshot + base-table filter + relationship traversal", () => {
    // `mf query --decimals 2 --metrics ending_mrr --group-by customer__customer_status
    //    --where "{{ Dimension('customer_month__customer_segment') }} = ..." --start-time 2026-08-01 --end-time 2026-08-31`
    const aug = { from: "2026-08-01", to: "2026-08-31" };
    const seg = () => dimension("customer_month__customer_segment");
    const status = () => dimension("customer__customer_status");
    const rows = async (q: SemanticQueryInput, metric = "ending_mrr") => {
      const result = await kernel.query(q);
      expect(result.trust).toBe("governed");
      const dim = Object.keys(result.rows[0] ?? {}).find((k) => k !== metric);
      return Object.fromEntries(result.rows.map((r) => [dim ? String(r[dim]) : "value", Number(r[metric])]));
    };
    const expectRows = (actual: Record<string, number>, expected: Record<string, number>) => {
      expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
      for (const [k, v] of Object.entries(expected)) expect(close(actual[k]!, v), `${k}: ${actual[k]} vs ${v}`).toBe(true);
    };

    it("Enterprise ending_mrr by customer status is the filtered snapshot (1,912,046.67), not the unfiltered one (2,309,714.33)", async () => {
      expectRows(await rows({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "=", value: "Enterprise" }], time: aug }), { active: 1912046.67 });
      expectRows(await rows({ metrics: ["ending_mrr"], filters: [{ field: seg(), operator: "=", value: "Enterprise" }], time: aug }), { value: 1912046.67 });
      expectRows(
        await rows({ metrics: ["ending_mrr"], filters: [{ field: seg(), operator: "=", value: "Enterprise" }, { field: status(), operator: "=", value: "active" }], time: aug }),
        { value: 1912046.67 },
      );
      expectRows(
        await rows({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "=", value: "Enterprise" }], time: { from: "2026-03-01", to: "2026-08-31" } }),
        { active: 1912046.67 },
      );
    });

    it("other base predicates on the snapshot population match MetricFlow", async () => {
      expectRows(await rows({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "=", value: "SMB" }], time: aug }), { active: 67514.16, churned: 0 });
      expectRows(await rows({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "!=", value: "Enterprise" }], time: aug }), { active: 397667.66, churned: 0 });
      expectRows(await rows({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "in", value: ["Enterprise", "SMB"] }], time: aug }), { active: 1979560.83, churned: 0 });
      expectRows(await rows({ metrics: ["ending_mrr"], dimensions: [seg()], filters: [{ field: status(), operator: "=", value: "active" }], time: aug }), { Enterprise: 1912046.67, "Mid-Market": 330153.5, SMB: 67514.16 });
      const empty = await kernel.query({ metrics: ["ending_mrr"], dimensions: [status()], filters: [{ field: seg(), operator: "=", value: "Nonexistent" }], time: aug });
      expect(empty.trust).toBe("governed");
      expect(empty.rows).toEqual([]);
    });
  });

  describe("result completeness under an execution cap", () => {
    const aug = { from: "2026-08-01", to: "2026-08-31" };
    const seg = () => dimension("customer_month__customer_segment");
    const status = () => dimension("customer__customer_status");

    function cappedKernel(defaultRows: number): GraneKernel {
      const dirCap = mkdtempSync(join(tmpdir(), "grane-oakwell-cap-"));
      writeFileSync(
        join(dirCap, "grane.yml"),
        [
          "project:",
          "  name: oakwell-interop",
          "  timezone: UTC",
          "connection:",
          "  type: duckdb",
          `  path: ${JSON.stringify(WAREHOUSE)}`,
          "  schema: main",
          "limits:",
          `  default_rows: ${defaultRows}`,
          "  max_rows: 10000",
          "providers:",
          "  - type: dbt",
          `    path: ${JSON.stringify(PROJECT)}`,
          "",
        ].join("\n"),
      );
      const loadedCap = loadConfig(dirCap);
      return new GraneKernel(loadedCap.config, {
        projectDir: loadedCap.projectDir,
        providerWarnings: loadedCap.warnings,
      });
    }

    it("scalar ending_mrr is a complete one-row result with the canonical total", async () => {
      const k = cappedKernel(1);
      try {
        const result = await k.query({ metrics: ["ending_mrr"], time: aug });
        expect(result.trust).toBe("governed");
        expect(result.rows).toHaveLength(1);
        expect(close(Number(result.rows[0]!.ending_mrr), 2309714.33)).toBe(true);
        expect(result.completeness.status).toBe("complete");
        expect(result.completeness.source).toBe("default");
        expect(result.provenance.completeness).toEqual(result.completeness);
      } finally {
        await k.close();
      }
    });

    it("grouped ending_mrr by segment is truncated at default_rows=1 and complete at the exact segment count", async () => {
      const k1 = cappedKernel(1);
      try {
        const truncated = await k1.query({ metrics: ["ending_mrr"], dimensions: [seg()], time: aug });
        expect(truncated.trust).toBe("governed");
        expect(truncated.rows).toHaveLength(1);
        expect(truncated.completeness).toEqual({ status: "truncated", limit: 1, source: "default" });
        expect(truncated.provenance.row_count).toBe(1);
        expect(truncated.columns).not.toContain("__grane_n");
        for (const row of truncated.rows) expect(row).not.toHaveProperty("__grane_n");
      } finally {
        await k1.close();
      }

      const k3 = cappedKernel(3);
      try {
        const exact = await k3.query({ metrics: ["ending_mrr"], dimensions: [seg()], time: aug });
        expect(exact.trust).toBe("governed");
        expect(exact.rows).toHaveLength(3);
        expect(exact.completeness.status).toBe("complete");
        const bySeg = Object.fromEntries(
          exact.rows.map((r) => [String(r[seg()]), Number(r.ending_mrr)]),
        );
        expect(close(bySeg.Enterprise!, 1912046.67)).toBe(true);
        expect(close(bySeg["Mid-Market"]!, 330153.5)).toBe(true);
        expect(close(bySeg.SMB!, 67514.16)).toBe(true);
      } finally {
        await k3.close();
      }
    });

    it("PR #19 Enterprise × status remains 1,912,046.67 when the cap is above the result size", async () => {
      const k = cappedKernel(1);
      try {
        const result = await k.query({
          metrics: ["ending_mrr"],
          dimensions: [status()],
          filters: [{ field: seg(), operator: "=", value: "Enterprise" }],
          time: aug,
        });
        expect(result.trust).toBe("governed");
        expect(result.rows).toHaveLength(1);
        expect(close(Number(result.rows[0]!.ending_mrr), 1912046.67)).toBe(true);
        expect(result.completeness.status).toBe("complete");
      } finally {
        await k.close();
      }
    });
  });

  describe("DATE-backed ground truths are invariant under project.timezone", () => {
    const dateTimezones = ["UTC", "America/New_York", "Europe/London", "Asia/Tokyo"] as const;

    it("changing project.timezone does not move civil DATE metrics", async () => {
      const schema = await kernel.loadSchema();
      const dateCases = cases.filter((c) => {
        const metric = kernel.model.metrics.get(c.mf.metrics[0]!);
        const ref = metric?.timeDimension;
        if (!ref) return false;
        return classifyTemporalType(columnDataType(schema, ref.table, ref.column), "duckdb") === "date";
      });
      expect(dateCases.length).toBeGreaterThan(0);

      const utcValues = new Map<string, number>();
      for (const c of dateCases) {
        if (unsupportedMetrics.has(c.mf.metrics[0]!)) continue;
        const result = await kernel.query(toQuery(c));
        expect(result.trust, c.id).toBe("governed");
        if (c.result_type === "scalar") utcValues.set(c.id, Number(result.rows[0]![c.mf.metrics[0]!]));
      }

      for (const tz of dateTimezones) {
        if (tz === "UTC") continue;
        const dirTz = mkdtempSync(join(tmpdir(), `grane-oakwell-${tz.replace(/\//g, "-")}-`));
        writeFileSync(
          join(dirTz, "grane.yml"),
          [
            "project:",
            "  name: oakwell-interop",
            `  timezone: ${tz}`,
            "connection:",
            "  type: duckdb",
            `  path: ${JSON.stringify(WAREHOUSE)}`,
            "  schema: main",
            "providers:",
            "  - type: dbt",
            `    path: ${JSON.stringify(PROJECT)}`,
            "",
          ].join("\n"),
        );
        const loadedTz = loadConfig(dirTz);
        const tzKernel = new GraneKernel(loadedTz.config, {
          projectDir: loadedTz.projectDir,
          providerWarnings: loadedTz.warnings,
        });
        try {
          for (const c of dateCases) {
            const metric = c.mf.metrics[0]!;
            if (unsupportedMetrics.has(metric)) continue;
            const result = await tzKernel.query(toQuery(c));
            expect(result.trust, `${tz} ${c.id}`).toBe("governed");
            if (c.result_type === "scalar") {
              expect(close(Number(result.rows[0]![metric]), utcValues.get(c.id)!, c.tolerance), `${tz} ${c.id}`).toBe(true);
              if (c.expected.value != null) {
                expect(close(Number(result.rows[0]![metric]), c.expected.value, c.tolerance), `${tz} ${c.id} vs GT`).toBe(true);
              }
            }
          }
        } finally {
          await tzKernel.close();
        }
      }
    });
  });
});
