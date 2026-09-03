import { describe, expect, it } from "vitest";
import { parseFilterSpec } from "../../src/cli/args.js";

describe("cli --filter parsing", () => {
  it("keeps field=value exactly as before, including = inside the value", () => {
    expect(parseFilterSpec("country=DE")).toEqual({ field: "country", operator: "=", value: "DE" });
    expect(parseFilterSpec("orders.status=a=b")).toEqual({ field: "orders.status", operator: "=", value: "a=b" });
    expect(parseFilterSpec("note=x<y")).toEqual({ field: "note", operator: "=", value: "x<y" });
    expect(parseFilterSpec("country=")).toEqual({ field: "country", operator: "=", value: "" });
  });

  it("preserves != and <> as the kernel's != operator", () => {
    expect(parseFilterSpec("country!=DE")).toEqual({ field: "country", operator: "!=", value: "DE" });
    expect(parseFilterSpec("country<>DE")).toEqual({ field: "country", operator: "!=", value: "DE" });
    expect(parseFilterSpec("country!= DE")).toEqual({ field: "country", operator: "!=", value: " DE" });
  });

  it("rejects expressions without a supported operator or without a field", () => {
    expect(() => parseFilterSpec("country")).toThrow(/use field=value, field!=value or field<>value/);
    expect(() => parseFilterSpec("=DE")).toThrow(/Invalid --filter/);
    expect(() => parseFilterSpec("country>100")).toThrow(/Invalid --filter/);
  });
});
