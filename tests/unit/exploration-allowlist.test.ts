import { describe, expect, it } from "vitest";
import { exploringKernel, exploringConfig, exampleSchema } from "../fixtures.js";
import { GraneError } from "../../src/errors.js";
import {
  isExplorable,
  isExplorationPattern,
  matchColumnPattern,
  explorationPolicy,
} from "../../src/explore/policy.js";
import { listExplorableColumns } from "../../src/explore/raw.js";
import { validateModel } from "../../src/validate/validate.js";
import { SemanticModel } from "../../src/model/model.js";
import { GraneKernel } from "../../src/kernel.js";

function refuse(run: () => unknown): GraneError {
  try {
    run();
    expect.unreachable();
  } catch (err) {
    expect(err).toBeInstanceOf(GraneError);
    return err as GraneError;
  }
}

describe("exploration pattern matching", () => {
  it("matches table.*, *.column, and *_suffix", () => {
    expect(matchColumnPattern("customers.*", "customers", "email")).toBe(true);
    expect(matchColumnPattern("customers.*", "orders", "email")).toBe(false);
    expect(matchColumnPattern("*.email", "customers", "email")).toBe(true);
    expect(matchColumnPattern("*.email", "customers", "phone")).toBe(false);
    expect(matchColumnPattern("*_ssn", "users", "tax_ssn")).toBe(true);
    expect(matchColumnPattern("*_ssn", "users", "ssn")).toBe(false);
    expect(matchColumnPattern("*_hash", "customers", "password_hash")).toBe(true);
    expect(matchColumnPattern("orders.discount_code", "orders", "discount_code")).toBe(true);
    expect(matchColumnPattern("*", "orders", "discount_code")).toBe(true);
  });

  it("accepts exact refs and globs as config entries", () => {
    expect(isExplorationPattern("customers.email")).toBe(true);
    expect(isExplorationPattern("customers.*")).toBe(true);
    expect(isExplorationPattern("*.email")).toBe(true);
    expect(isExplorationPattern("*_ssn")).toBe(true);
    expect(isExplorationPattern("not a ref")).toBe(false);
    expect(isExplorationPattern("email")).toBe(false);
  });
});

describe("allowlist mode", () => {
  it("permits only included columns and refuses the rest", () => {
    const kernel = exploringKernel({
      exploration: {
        enabled: true,
        mode: "allowlist",
        schemas: ["public"],
        include: ["orders.*", "payments.failure_code"],
        exclude: [],
      },
    });
    const { resolved } = kernel.compile({
      metrics: ["revenue"],
      raw_dimensions: ["orders.discount_code"],
    });
    expect(resolved.ungoverned).toEqual(["orders.discount_code"]);
    const email = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["customers.email"] }),
    );
    expect(email.refusal.status).toBe("column_not_permitted");
    expect(email.refusal.message).toContain("allowlist");
    const names = listExplorableColumns(kernel.model, exampleSchema()).map(
      (c) => `${c.table}.${c.column}`,
    );
    expect(names).toContain("orders.discount_code");
    expect(names).toContain("payments.failure_code");
    expect(names).not.toContain("customers.email");
    expect(names).not.toContain("customers.name");
  });

  it("fail-closes when include is empty", () => {
    const kernel = exploringKernel({
      exploration: {
        enabled: true,
        mode: "allowlist",
        schemas: ["public"],
        include: [],
        exclude: [],
      },
    });
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
    expect(listExplorableColumns(kernel.model, exampleSchema())).toEqual([]);
  });

  it("still applies exclude after include", () => {
    const kernel = exploringKernel({
      exploration: {
        enabled: true,
        mode: "allowlist",
        schemas: ["public"],
        include: ["orders.*"],
        exclude: ["orders.discount_code"],
      },
    });
    const err = refuse(() =>
      kernel.compile({ metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] }),
    );
    expect(err.refusal.status).toBe("column_not_permitted");
    expect(err.refusal.message).toContain("excluded");
    kernel.compile({ metrics: ["revenue"], raw_dimensions: ["orders.device_type"] });
  });
});

describe("denylist wildcards", () => {
  it("blocks *.email and *_hash", () => {
    const kernel = exploringKernel({
      exploration: {
        enabled: true,
        mode: "denylist",
        schemas: ["public"],
        exclude: ["*.email", "*_hash"],
      },
    });
    expect(
      refuse(() => kernel.compile({ metrics: ["revenue"], raw_dimensions: ["customers.email"] }))
        .refusal.status,
    ).toBe("column_not_permitted");
    const policy = explorationPolicy(kernel.config);
    expect(isExplorable(policy, "customers", "password_hash")).toBe(false);
    expect(isExplorable(policy, "orders", "discount_code")).toBe(true);
  });
});

describe("per-agent exploration exclude", () => {
  it("narrows a granted explorer further", () => {
    const config = exploringConfig({
      exploration: {
        enabled: true,
        mode: "allowlist",
        schemas: ["public"],
        include: ["orders.*"],
        exclude: [],
      },
    });
    const kernel = new GraneKernel(config);
    kernel.setSchema(exampleSchema());
    const bound = kernel.bindAgent({
      id: "finance",
      metrics: null,
      dimensions: null,
      exploration: true,
      explorationExclude: ["orders.discount_code"],
    });
    expect(
      refuse(() =>
        bound.compile({ metrics: ["revenue"], raw_dimensions: ["orders.discount_code"] }),
      ).refusal.status,
    ).toBe("column_not_permitted");
    bound.compile({ metrics: ["revenue"], raw_dimensions: ["orders.device_type"] });
  });
});

describe("allowlist validation", () => {
  it("warns when allowlist include is empty", () => {
    const report = validateModel(
      new SemanticModel(
        exploringConfig({
          exploration: {
            enabled: true,
            mode: "allowlist",
            schemas: ["public"],
            include: [],
            exclude: [],
          },
        }),
      ),
      exampleSchema(),
    );
    expect(report.issues.some((issue) => issue.code === "empty_allowlist")).toBe(true);
  });

  it("accepts glob include/exclude entries", () => {
    const report = validateModel(
      new SemanticModel(
        exploringConfig({
          exploration: {
            enabled: true,
            mode: "allowlist",
            schemas: ["public"],
            include: ["orders.*", "payments.failure_code"],
            exclude: ["*.email", "customers.*"],
          },
        }),
      ),
      exampleSchema(),
    );
    expect(report.issues.filter((issue) => issue.subject === "exploration")).toEqual([]);
  });
});
