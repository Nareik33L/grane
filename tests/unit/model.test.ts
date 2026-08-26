import { describe, expect, it } from "vitest";
import { exampleModel } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import { parseColumnRef } from "../../src/model/refs.js";

describe("column references", () => {
  it("parses ${table.column} and bare table.column", () => {
    expect(parseColumnRef("${orders.net_amount}")).toEqual({
      table: "orders",
      column: "net_amount",
    });
    expect(parseColumnRef("orders.status")).toEqual({ table: "orders", column: "status" });
    expect(parseColumnRef("just_a_name")).toBeNull();
    expect(parseColumnRef("a.b.c")).toBeNull();
  });
});

describe("metric resolution", () => {
  const model = exampleModel();

  it("resolves canonical names and synonyms", () => {
    expect(model.resolveMetric("revenue").name).toBe("revenue");
    expect(model.resolveMetric("sales").name).toBe("revenue");
    expect(model.resolveMetric("AOV").name).toBe("average_order_value");
  });

  it("refuses unknown metrics with structured similar suggestions", () => {
    try {
      model.resolveMetric("revenu");
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GraneError);
      const refusal = (err as GraneError).refusal;
      expect(refusal.status).toBe("undefined_metric");
      expect(refusal.requested).toBe("revenu");
      expect(refusal.similar).toContain("revenue");
    }
  });

  it("refuses undefined business concepts rather than inventing them", () => {
    expect(() => model.resolveMetric("CAC")).toThrowError(GraneError);
  });

  it("assigns stable definition versions that change with the definition", () => {
    const a = exampleModel().resolveMetric("revenue").definitionVersion;
    const b = exampleModel().resolveMetric("revenue").definitionVersion;
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(model.resolveMetric("orders").definitionVersion).not.toBe(a);
  });
});

describe("dimension availability and grain safety", () => {
  const model = exampleModel();

  it("lists dimensions reachable without fan-out", () => {
    const revenue = model.resolveMetric("revenue");
    const available = model.availableDimensions(revenue);
    expect(available).toContain("country");
    expect(available).toContain("channel");
    // products are below the order grain (via order_items, one_to_many).
    expect(available).not.toContain("product_category");
  });

  it("finds safe join paths and flags fan-out paths", () => {
    const safe = model.graph.findPath("orders", "customers");
    expect(safe?.fansOut).toBe(false);
    expect(safe?.ambiguous).toBeFalsy();
    const fanning = model.graph.findPath("orders", "payments");
    expect(fanning?.fansOut).toBe(true);
    expect(model.graph.findPath("orders", "nonexistent")).toBeNull();
  });
});

describe("catalog search", () => {
  const model = exampleModel();

  it("matches names, synonyms and descriptions", () => {
    expect(model.search("revenue").metrics).toContain("revenue");
    expect(model.search("sales").metrics).toContain("revenue");
    expect(model.search("country").dimensions).toContain("country");
  });
});
