import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { exampleKernel, exploringKernel, exploringConfig, exampleSchema } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import { planPromotion, writePromotedDimension } from "../../src/explore/promote.js";
import { SemanticModel } from "../../src/model/model.js";
import { recordRawUsage, usageRanked } from "../../src/explore/usage.js";
import { listExplorableColumns } from "../../src/explore/raw.js";

describe("controlled exploration", () => {
  it("keeps fully governed queries at trust: governed", () => {
    const kernel = exploringKernel();
    const { resolved, compiled } = kernel.compile({
      metrics: ["revenue"],
      dimensions: ["country"],
    });
    expect(resolved.trust).toBe("governed");
    expect(resolved.ungoverned).toEqual([]);
    expect(compiled.trust).toBe("governed");
    expect(compiled.warning).toBeNull();
  });

  it("marks revenue by raw discount_code as trust: mixed", () => {
    const kernel = exploringKernel();
    const { resolved, compiled } = kernel.compile({
      metrics: ["revenue"],
      raw_dimensions: ["orders.discount_code"],
    });
    expect(resolved.trust).toBe("mixed");
    expect(resolved.governed).toContain("revenue");
    expect(resolved.ungoverned).toEqual(["orders.discount_code"]);
    expect(resolved.warning).toContain("orders.discount_code");
    expect(compiled.sql).toContain('"orders"."discount_code" AS "orders.discount_code"');
    expect(compiled.sql).toContain('SUM("orders"."net_amount")');
    expect(compiled.sql).toContain('GROUP BY 1');
  });

  it("does not treat an implicit metric time_dimension as an extra governed field", () => {
    const kernel = exploringKernel();
    const { resolved } = kernel.compile({
      metrics: ["revenue"],
      raw_dimensions: ["orders.discount_code"],
      time: { from: "2026-07-01", to: "2026-07-31" },
    });
    expect(resolved.trust).toBe("mixed");
    expect(resolved.governed).toEqual(["revenue"]);
    expect(resolved.ungoverned).toEqual(["orders.discount_code"]);
  });

  it("marks raw-only aggregations as trust: exploratory", () => {
    const kernel = exploringKernel();
    const { resolved, compiled } = kernel.compile({
      raw_metrics: [{ field: "payments.id", type: "count" }],
      raw_dimensions: ["payments.status"],
    });
    expect(resolved.trust).toBe("exploratory");
    expect(resolved.governed).toEqual([]);
    expect(resolved.ungoverned).toEqual(["payments.status", "payments.id"]);
    expect(compiled.sql).toContain('FROM "public"."payments"');
    expect(compiled.sql).toContain('COUNT("payments"."id") AS "count_payments_id"');
    expect(compiled.sql).toContain('"payments"."status" AS "payments.status"');
    expect(compiled.sql).not.toContain("orders");
  });

  it("refuses raw dimensions when exploration is disabled", () => {
    const kernel = exampleKernel();
    try {
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      expect((err as GraneError).refusal.status).toBe("exploration_disabled");
    }
  });

  it("refuses columns on the exploration exclude list", () => {
    const kernel = exploringKernel();
    try {
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["customers.email"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("column_not_permitted");
    }
  });

  it("refuses raw columns that do not exist", () => {
    const kernel = exploringKernel();
    try {
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["orders.no_such_column"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("undefined_column");
    }
  });

  it("refuses raw dimensions that would fan out the metric grain", () => {
    const kernel = exploringKernel();
    try {
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["payments.status"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("unsafe_query");
      expect((err as GraneError).refusal.message).toContain("one_to_many");
    }
  });

  it("refuses mixing governed metrics with raw_metrics", () => {
    const kernel = exploringKernel();
    try {
      kernel.compile({
        metrics: ["revenue"],
        raw_metrics: [{ field: "orders.id", type: "count" }],
      });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toContain("raw_metrics");
    }
  });

  it("allows filters on permitted raw columns", () => {
    const kernel = exploringKernel();
    const { compiled } = kernel.compile({
      metrics: ["revenue"],
      filters: [{ field: "orders.discount_code", operator: "=", value: "SUMMER50" }],
    });
    expect(compiled.trust).toBe("mixed");
    expect(compiled.sql).toContain('"orders"."discount_code" = $');
    expect(compiled.params).toContain("SUMMER50");
  });

  it("hints raw_dimensions when an ungoverned column name is requested as a dimension", () => {
    const kernel = exploringKernel();
    try {
      kernel.compile({ metrics: ["revenue"], dimensions: ["discount_code"] });
      expect.unreachable();
    } catch (err) {
      expect((err as GraneError).refusal.status).toBe("invalid_query");
      expect((err as GraneError).refusal.message).toContain("raw_dimensions");
      expect((err as GraneError).refusal.message).toContain("orders.discount_code");
    }
  });

  it("lists explorable columns excluding governed and denylisted fields", () => {
    const kernel = exploringKernel();
    const columns = listExplorableColumns(kernel.model, exampleSchema());
    const names = columns.map((c) => `${c.table}.${c.column}`);
    expect(names).toContain("orders.discount_code");
    expect(names).toContain("orders.device_type");
    expect(names).not.toContain("customers.email");
    expect(names).not.toContain("customers.country");
    expect(names).not.toContain("orders.net_amount");
    expect(names).not.toContain("orders.channel");
  });
});

describe("promotion", () => {
  it("plans a governed dimension from a raw column", () => {
    const model = new SemanticModel(exploringConfig());
    const planned = planPromotion(model, "orders.discount_code", { schema: exampleSchema() });
    expect(planned.name).toBe("discount_code");
    expect(planned.config.entity).toBe("order");
    expect(planned.config.sql).toBe("${orders.discount_code}");
    expect(planned.config.type).toBe("string");
  });

  it("appends the promoted dimension to dimensions.yml", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-promote-"));
    try {
      const model = new SemanticModel(exploringConfig());
      const planned = planPromotion(model, "orders.discount_code", { schema: exampleSchema() });
      const file = writePromotedDimension(dir, planned.name, planned.config);
      const written = readFileSync(file, "utf8");
      expect(written).toContain("discount_code:");
      expect(written).toContain("sql: ${orders.discount_code}");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("exploratory usage tracking", () => {
  it("records and ranks raw column usage", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-usage-"));
    try {
      recordRawUsage(dir, ["orders.discount_code"]);
      recordRawUsage(dir, ["orders.discount_code", "orders.device_type"]);
      const ranked = usageRanked(dir);
      expect(ranked[0]).toMatchObject({ column: "orders.discount_code", count: 2 });
      expect(ranked[1]).toMatchObject({ column: "orders.device_type", count: 1 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
