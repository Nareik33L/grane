import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inferRelationships } from "../../src/connectors/types.js";
import {
  planRelationshipWrite,
  writeDiscoveredRelationships,
} from "../../src/discover/relationships.js";
import type { DatabaseSchema } from "../../src/connectors/types.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("inferRelationships", () => {
  it("uniquifies two FKs between the same table pair", () => {
    const schema: DatabaseSchema = {
      schemaName: "public",
      tables: [],
      foreignKeys: [
        {
          constraintName: "orders_customer_id_fkey",
          table: "orders",
          column: "customer_id",
          refTable: "customers",
          refColumn: "id",
        },
        {
          constraintName: "orders_bill_to_fkey",
          table: "orders",
          column: "bill_to_customer_id",
          refTable: "customers",
          refColumn: "id",
        },
      ],
    };
    const inferred = inferRelationships(schema);
    expect(inferred.orders_to_customers).toEqual({
      from: "orders.customer_id",
      to: "customers.id",
      type: "many_to_one",
    });
    expect(inferred.orders_to_customers_2).toEqual({
      from: "orders.bill_to_customer_id",
      to: "customers.id",
      type: "many_to_one",
    });
  });
});

describe("planRelationshipWrite", () => {
  it("adds new FKs and skips existing keys and from→to pairs", () => {
    const plan = planRelationshipWrite({
      fileRelationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
      catalogRelationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        payments_to_orders: { from: "payments.order_id", to: "orders.id", type: "many_to_one" },
      },
      inferred: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        payments_to_orders: { from: "payments.order_id", to: "orders.id", type: "many_to_one" },
        refunds_to_orders: { from: "refunds.order_id", to: "orders.id", type: "many_to_one" },
      },
    });
    expect(plan.added).toEqual(["refunds_to_orders"]);
    expect(plan.skipped.map((s) => s.name).sort()).toEqual(["orders_to_customers", "payments_to_orders"]);
    expect(plan.nextFile.refunds_to_orders?.from).toBe("refunds.order_id");
    expect(plan.nextFile.orders_to_customers).toEqual({
      from: "orders.customer_id",
      to: "customers.id",
      type: "many_to_one",
    });
  });

  it("renames when the preferred key is taken by a different pair", () => {
    const plan = planRelationshipWrite({
      fileRelationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
      catalogRelationships: {
        orders_to_customers: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
      inferred: {
        orders_to_customers: {
          from: "orders.bill_to_customer_id",
          to: "customers.id",
          type: "many_to_one",
        },
      },
    });
    expect(plan.added).toEqual(["orders_to_customers_2"]);
    expect(plan.nextFile.orders_to_customers_2?.from).toBe("orders.bill_to_customer_id");
  });
});

describe("writeDiscoveredRelationships", () => {
  it("merges into relationships.yml without clobbering existing keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-discover-"));
    dirs.push(dir);
    writeFileSync(
      join(dir, "relationships.yml"),
      `relationships:\n  keep_me:\n    from: orders.customer_id\n    to: customers.id\n    type: many_to_one\n`,
    );
    const result = writeDiscoveredRelationships(
      dir,
      {
        keep_me: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
        payments_to_orders: { from: "payments.order_id", to: "orders.id", type: "many_to_one" },
      },
      {
        keep_me: { from: "orders.customer_id", to: "customers.id", type: "many_to_one" },
      },
    );
    expect(result.added).toEqual(["payments_to_orders"]);
    const written = readFileSync(join(dir, "relationships.yml"), "utf8");
    expect(written).toContain("keep_me:");
    expect(written).toContain("payments_to_orders:");
    expect(written).toContain("Existing keys were kept");
  });

  it("does not create a file when there is nothing to add", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-discover-empty-"));
    dirs.push(dir);
    const result = writeDiscoveredRelationships(dir, {}, {});
    expect(result.added).toEqual([]);
    expect(() => readFileSync(join(dir, "relationships.yml"), "utf8")).toThrow();
  });
});
