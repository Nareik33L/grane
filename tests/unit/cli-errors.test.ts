import { describe, expect, it } from "vitest";
import { GraneError, publicErrorMessage, warehouseUnreachable } from "../../src/errors.js";
import { formatHumanFailure, formatJsonFailure, wantsJson } from "../../src/cli/fail.js";

describe("publicErrorMessage", () => {
  it("uses message, then code, then String(err)", () => {
    expect(publicErrorMessage(new Error("connect ECONNREFUSED 127.0.0.1:1"))).toBe(
      "connect ECONNREFUSED 127.0.0.1:1",
    );
    expect(publicErrorMessage(Object.assign(new Error(""), { code: "ECONNREFUSED" }))).toBe(
      "Error (ECONNREFUSED)",
    );
    expect(publicErrorMessage({ code: "ENOTFOUND" })).toBe("ENOTFOUND");
    expect(publicErrorMessage("plain")).toBe("plain");
  });

  it("redacts credentials and drops stack frames", () => {
    const err = new Error(
      "connect postgres://readonly:hunter2@db.internal:5432/shop failed\n    at Client.connect",
    );
    const message = publicErrorMessage(err);
    expect(message).toContain("postgres:");
    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("at Client.connect");
  });
});

describe("CLI failure formatting", () => {
  it("prints a useful human ERROR when message is empty", () => {
    const err = Object.assign(new Error(""), { code: "ECONNREFUSED" });
    expect(formatHumanFailure(err)).toEqual(["ERROR: Error (ECONNREFUSED)"]);
  });

  it("keeps Grane refusals human-readable without --json", () => {
    const err = new GraneError({
      status: "undefined_metric",
      message: '"ghost" is not a defined metric in the Grane semantic model.',
      requested: "ghost",
      similar: ["revenue"],
    });
    expect(formatHumanFailure(err)[0]).toMatch(/^ERROR \(undefined_metric\):/);
    expect(wantsJson(["node", "grane", "query", "ghost"])).toBe(false);
  });

  it("emits machine-readable JSON for refusals when --json is requested", () => {
    const err = new GraneError({
      status: "unsafe_query",
      message: "fan-out",
      details: { reason: "cardinality" },
    });
    expect(formatJsonFailure(err)).toEqual({
      ok: false,
      status: "unsafe_query",
      message: "fan-out",
      details: { reason: "cardinality" },
    });
    expect(wantsJson(["node", "grane", "query", "revenue", "--json"])).toBe(true);
  });

  it("prefixes warehouse failures so a stranger can tell the connection failed", () => {
    const wrapped = warehouseUnreachable("PostgreSQL", Object.assign(new Error(""), { code: "ECONNREFUSED" }));
    expect(wrapped.message).toMatch(/Cannot reach the PostgreSQL warehouse/);
    expect(wrapped.message).toMatch(/ECONNREFUSED/);
    expect(formatJsonFailure(wrapped).status).toBe("error");
  });
});
