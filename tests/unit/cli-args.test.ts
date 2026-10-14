import { describe, expect, it } from "vitest";
import { parseFilterSpec, resolveSetupInvocation } from "../../src/cli/args.js";

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

describe("resolveSetupInvocation", () => {
  it("treats --import <dir> as inspect-only, even with --yes", () => {
    expect(resolveSetupInvocation({ import: "./analytics" })).toEqual({ kind: "import", dir: "./analytics" });
    expect(resolveSetupInvocation({ import: "  ./shop  ", yes: true })).toEqual({ kind: "import", dir: "./shop" });
  });

  it("rejects empty --import, --path, and --activate-offline with --import", () => {
    expect(() => resolveSetupInvocation({ import: "  " })).toThrow(/--import requires a directory/);
    expect(() => resolveSetupInvocation({ import: "./a", path: "demo" })).toThrow(/cannot be combined with --path/);
    expect(() => resolveSetupInvocation({ import: "./a", activateOffline: true })).toThrow(/never pins/);
  });

  it("keeps --yes --path demo|own and interactive defaults", () => {
    expect(resolveSetupInvocation({ yes: true, path: "demo" })).toEqual({ kind: "yes", path: "demo" });
    expect(resolveSetupInvocation({ nonInteractive: true, path: "own" })).toEqual({ kind: "yes", path: "own" });
    expect(resolveSetupInvocation({})).toEqual({ kind: "interactive", path: undefined });
    expect(() => resolveSetupInvocation({ yes: true })).toThrow(/--path demo or --path own, or --import/);
    expect(() => resolveSetupInvocation({ path: "import" })).toThrow(/Unknown --path "import"/);
  });
});
