import { describe, expect, it } from "vitest";
import { exampleKernel } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";

const kernel = exampleKernel();

describe("deterministic SQL compiler", () => {
  it("compiles revenue by country with a governed join", () => {
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(compiled.sql).toContain('FROM "public"."orders"');
    expect(compiled.sql).toContain(
      'JOIN "public"."customers" ON "orders"."customer_id" = "customers"."id"',
    );
    expect(compiled.sql).toContain('SUM("orders"."net_amount") FILTER (WHERE "orders"."status" = $1)');
    expect(compiled.sql).toContain('GROUP BY 1');
    // Inclusive end date compiles to an exclusive next-day bound.
    expect(compiled.params).toEqual(["completed", "2026-07-01", "2026-08-01"]);
    expect(compiled.sql).not.toMatch(/insert|update|delete/i);
  });

  it("is deterministic: same query, same SQL", () => {
    const query = { metrics: ["revenue"], dimensions: ["country", "channel"] };
    const a = kernel.compile(query).compiled;
    const b = kernel.compile(query).compiled;
    expect(a.sql).toBe(b.sql);
    expect(a.params).toEqual(b.params);
  });

  it("pre-aggregates one_to_many measures at the metric grain (fan-out safety)", () => {
    const { compiled } = kernel.compile({ metrics: ["payments_received"] });
    expect(compiled.sql).toContain('"m_payments_received" AS (');
    expect(compiled.sql).toContain('GROUP BY "payments"."order_id"');
    expect(compiled.sql).toContain(
      'LEFT JOIN "m_payments_received" ON "m_payments_received"."_key" = "orders"."id"',
    );
    // The metric's own filter is applied inside the CTE.
    expect(compiled.sql).toContain('"payments"."status" = $1');
    expect(compiled.plan.preAggregations).toEqual([
      expect.objectContaining({ metric: "payments_received", cte: "m_payments_received" }),
    ]);
  });

  it("keeps two fanning children (payments and refunds) in separate pre-aggregations", () => {
    const { compiled } = kernel.compile({
      metrics: ["payments_received", "refunded_amount"],
      dimensions: ["country"],
    });
    expect(compiled.plan.preAggregations).toHaveLength(2);
    expect(compiled.sql).toContain('"m_payments_received" AS (');
    expect(compiled.sql).toContain('"m_refunded_amount" AS (');
    // The outer query never joins the raw fanning tables directly.
    expect(compiled.sql).not.toContain('JOIN "public"."payments"');
    expect(compiled.sql).not.toContain('JOIN "public"."refunds"');
  });

  it("compiles ratio metrics as numerator/denominator with divide-by-zero safety", () => {
    const { compiled } = kernel.compile({ metrics: ["average_order_value"] });
    expect(compiled.sql).toContain("NULLIF");
    expect(compiled.metricVersions).toHaveProperty("revenue");
    expect(compiled.metricVersions).toHaveProperty("orders");
    expect(compiled.metricVersions).toHaveProperty("average_order_value");
  });

  it("applies time grain with date_trunc and orders by period", () => {
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      time: { from: "2026-01-01", to: "2026-06-30", grain: "month" },
    });
    expect(compiled.sql).toContain(`date_trunc('month', "orders"."completed_at")`);
    expect(compiled.sql).toContain('"period_month"');
    expect(compiled.sql).toContain('ORDER BY "period_month" ASC');
  });

  it("localizes time when the project timezone is not UTC", () => {
    const tzKernel = exampleKernelWithTimezone("Europe/London");
    const { compiled } = tzKernel.compile({
      metrics: ["revenue"],
      time: { from: "2026-07-01", to: "2026-07-31", grain: "day" },
    });
    expect(compiled.sql).toContain(`"orders"."completed_at"::timestamptz AT TIME ZONE 'Europe/London'`);
  });

  it("compiles dimension filters with parameters", () => {
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
      filters: [
        { field: "customer_type", operator: "=", value: "business" },
        { field: "channel", operator: "in", value: ["web", "mobile"] },
      ],
    });
    expect(compiled.sql).toContain('"customers"."customer_type" = $2');
    expect(compiled.sql).toContain('"orders"."channel" IN ($3, $4)');
    expect(compiled.params).toEqual(["completed", "business", "web", "mobile"]);
  });

  it("enforces the configured row limit cap", () => {
    const { compiled } = kernel.compile({ metrics: ["revenue"], limit: 999999 });
    expect(compiled.sql).toContain("LIMIT 10000");
  });
});

describe("deterministic refusals", () => {
  it("refuses dimensions that would fan out the metric grain", () => {
    try {
      kernel.compile({ metrics: ["revenue"], dimensions: ["product_category"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
      expect((err as GraneError).refusal.message).toContain("one_to_many");
    }
  });

  it("refuses queries mixing metrics of different grains", () => {
    try {
      kernel.compile({ metrics: ["revenue", "customers"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
    }
  });

  it("refuses unknown metrics with suggestions", () => {
    try {
      kernel.compile({ metrics: ["CAC"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("undefined_metric");
    }
  });

  it("refuses ordering by unselected fields", () => {
    try {
      kernel.compile({ metrics: ["revenue"], order: [{ field: "country", direction: "desc" }] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
    }
  });

  it("refuses malformed query model requests", () => {
    try {
      kernel.compile({ metrics: [] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
    }
  });
});

import { exampleConfig } from "../fixtures.js";
import { GraneKernel } from "../../src/kernel.js";

function exampleKernelWithTimezone(timezone: string): GraneKernel {
  const config = exampleConfig();
  config.project.timezone = timezone;
  return new GraneKernel(config);
}
