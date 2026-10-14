/**
 * V2-15 AC2: unsupported or ambiguous YAML is rejected with an actionable
 * error that tells the user how to fix it. One test per case.
 */
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { exampleConfig } from "../fixtures.js";
import { SemanticModel } from "../../src/model/model.js";
import { validateModel, type ValidationIssue } from "../../src/validate/validate.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function issuesOf(config = exampleConfig()): ValidationIssue[] {
  const report = validateModel(new SemanticModel(config));
  return [...report.issues, ...report.metrics.flatMap((metric) => metric.issues)];
}

function expectActionable(issue: ValidationIssue | undefined, code: string, howTo: RegExp) {
  expect(issue, `missing ${code}`).toBeTruthy();
  expect(issue!.code).toBe(code);
  expect(issue!.severity).toBe("error");
  expect(issue!.message, issue!.message).toMatch(/How to fix:/);
  expect(issue!.message, issue!.message).toMatch(howTo);
}

describe("unsupported / ambiguous YAML is rejected with a fix-it error", () => {
  it("ambiguous_relationship tells the user to keep a single path", () => {
    const config = exampleConfig();
    config.relationships["payments_to_orders_alt"] = {
      from: "payments.legacy_order_id",
      to: "orders.id",
      type: "many_to_one",
    };
    const issue = issuesOf(config).find((item) => item.code === "ambiguous_relationship");
    expectActionable(issue, "ambiguous_relationship", /single relationship path|remove the extra relationship/);
  });

  it("unsupported_additive_none tells the user to use additive or semi", () => {
    const config = exampleConfig();
    config.metrics["stock"] = {
      entity: "product",
      type: "sum",
      sql: "${products.id}",
      additive: "none",
      status: "approved",
      synonyms: [],
    };
    const issue = issuesOf(config).find((item) => item.code === "unsupported_additive_none");
    expectActionable(issue, "unsupported_additive_none", /additive: additive|additive: semi/);
  });

  it("unknown_entity tells the user to define it under entities", () => {
    const config = exampleConfig();
    config.metrics["orphans"] = {
      entity: "missing",
      type: "count",
      sql: "${orders.id}",
      status: "approved",
      synonyms: [],
    };
    const issue = issuesOf(config).find((item) => item.code === "unknown_entity");
    expect(issue?.message).toMatch(/Define it under "entities"/);
    expect(issue?.severity).toBe("error");
  });

  it("unknown_metric on a ratio tells the user to define or rename", () => {
    const config = exampleConfig();
    config.metrics["broken_ratio"] = {
      entity: "order",
      type: "ratio",
      numerator: "not_a_metric",
      denominator: "orders",
      status: "approved",
      synonyms: [],
    };
    const issue = issuesOf(config).find((item) => item.code === "unknown_metric");
    expectActionable(issue, "unknown_metric", /define "not_a_metric"|correct the name/);
  });

  it("nested_ratio tells the user to point at a non-ratio metric", () => {
    const config = exampleConfig();
    config.metrics["nested"] = {
      entity: "order",
      type: "ratio",
      numerator: "average_order_value",
      denominator: "orders",
      status: "approved",
      synonyms: [],
    };
    const issue = issuesOf(config).find((item) => item.code === "nested_ratio");
    expectActionable(issue, "nested_ratio", /sum\/count\/min\/max|not another ratio/);
  });

  it("invalid ratio YAML (missing numerator) is a load error with a fix", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-bad-ratio-"));
    try {
      writeFileSync(
        join(dir, "grane.yml"),
        `project: { name: shop, timezone: UTC }
connection: { type: postgres, schema: public }
entities:
  order: { table: orders, primary_key: id }
metrics:
  broken:
    entity: order
    type: ratio
    denominator: orders
`,
      );
      expect(() => loadConfig(dir)).toThrow(/numerator and 'denominator'|Invalid Grane configuration/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("generated temporal semi-additive group_by errors with a fix", () => {
    const config = exampleConfig();
    config.metrics["on_hand"] = {
      entity: "order",
      type: "sum",
      sql: "${orders.net_amount}",
      time_dimension: "${orders.completed_at}",
      additive: "semi",
      semi_additive: { window: "last", group_by: ["${orders.completed_at}"] },
      status: "approved",
      synonyms: [],
    };
    const report = validateModel(new SemanticModel(config), undefined, { generated: true });
    const issue = report.metrics
      .find((metric) => metric.metric === "on_hand")
      ?.issues.find((item) => item.code === "temporal_semi_additive_group_by");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toMatch(/Use group_by: \[\]|non-temporal series key/);
  });
});
