import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/load.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { detectConnectorKinds } from "../../src/providers/detect.js";
import { loadCubeProvider } from "../../src/providers/cube.js";
import { loadLookmlProvider } from "../../src/providers/lookml.js";
import { loadOssieProvider } from "../../src/providers/ossie.js";
import { loadProvider } from "../../src/providers/registry.js";
import { GraneError } from "../../src/errors.js";

const root = dirname(fileURLToPath(import.meta.url));
const cubeShop = join(root, "../fixtures/cube-shop");
const ossieShop = join(root, "../fixtures/ossie-shop");
const lookmlShop = join(root, "../fixtures/lookml-shop");
const dbtShop = join(root, "../fixtures/dbt-shop");

describe("universal connector detection", () => {
  it("sniffs dbt, Cube, LookML and Ossie projects", () => {
    expect(detectConnectorKinds(dbtShop)).toContain("dbt");
    expect(detectConnectorKinds(cubeShop)).toEqual(["cube"]);
    expect(detectConnectorKinds(lookmlShop)).toEqual(["lookml"]);
    expect(detectConnectorKinds(ossieShop)).toEqual(["ossie"]);
  });

  it("auto-loads a dbt project when type is omitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-auto-"));
    writeFileSync(
      join(dir, "grane.yml"),
      `
connection: { type: postgres }
providers:
  - path: ${JSON.stringify(dbtShop)}
`,
    );
    const loaded = loadConfig(dir);
    expect(loaded.config.metrics.revenue?.source?.provider).toBe("dbt");
    expect(loaded.config.providers[0]?.type).toBeUndefined();
  });
});

describe("Cube YAML", () => {
  it("imports cubes, measures, dimensions and joins", () => {
    const contribution = loadCubeProvider({ path: cubeShop }, { projectDir: cubeShop });
    expect(contribution.metrics.revenue?.sql).toBe("${orders.net_amount}");
    expect(contribution.metrics.revenue?.type).toBe("sum");
    expect(contribution.dimensions.country?.sql).toBe("${customers.country}");
    expect(contribution.relationships.orders_to_customers).toEqual(
      expect.objectContaining({
        from: "orders.customer_id",
        to: "customers.id",
        type: "many_to_one",
      }),
    );
    expect(contribution.metrics.revenue?.source?.provider).toBe("cube");
  });
});

describe("Apache Ossie", () => {
  it("imports datasets, simple aggregates and relationships", () => {
    const contribution = loadOssieProvider({ path: ossieShop }, { projectDir: ossieShop });
    expect(contribution.metrics.revenue?.sql).toBe("${orders.net_amount}");
    expect(contribution.metrics.revenue?.synonyms).toContain("sales");
    expect(contribution.dimensions.country?.sql).toBe("${customers.country}");
    expect(contribution.relationships.orders_to_customers.from).toBe("orders.customer_id");
    expect(contribution.metrics.customer_lifetime_value).toBeUndefined();
    expect(contribution.warnings.some((w) => w.includes("customer_lifetime_value"))).toBe(true);
  });
});

describe("LookML", () => {
  it("imports views, measures and explore joins", () => {
    const contribution = loadLookmlProvider({ path: lookmlShop }, { projectDir: lookmlShop });
    expect(contribution.metrics.revenue?.sql).toBe("${orders.net_amount}");
    expect(contribution.metrics.revenue?.filters).toEqual({ "orders.status": "completed" });
    expect(contribution.dimensions.country?.sql).toBe("${customers.country}");
    expect(contribution.relationships.orders_to_customers.from).toBe("orders.customer_id");
    expect(contribution.entities.orders?.primary_key).toBe("id");
  });

  it("uses primary_key: yes instead of the first number dimension", () => {
    const contribution = loadLookmlProvider({ path: lookmlShop }, { projectDir: lookmlShop });
    expect(contribution.entities.orders?.primary_key).toBe("id");
    expect(contribution.dimensions.net_amount?.sql).toBe("${orders.net_amount}");
  });

  it("maps LookML view.field joins onto warehouse table.column", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-lkml-"));
    writeFileSync(
      join(dir, "shop.lkml"),
      `
view: order_facts {
  sql_table_name: public.orders ;;
  dimension: pk {
    primary_key: yes
    sql: \${TABLE}.id ;;
  }
  measure: revenue { type: sum sql: \${TABLE}.net_amount ;; }
}
view: customer {
  sql_table_name: customers ;;
  dimension: id { primary_key: yes sql: \${TABLE}.id ;; }
}
explore: order_facts {
  join: customer {
    sql_on: \${order_facts.customer_id} = \${customer.id} ;;
    relationship: many_to_one
  }
}
`,
    );
    const contribution = loadLookmlProvider({ path: dir }, { projectDir: dir });
    expect(contribution.entities.order_facts?.table).toBe("orders");
    expect(contribution.entities.order_facts?.primary_key).toBe("id");
    expect(contribution.relationships.order_facts_to_customer).toEqual(
      expect.objectContaining({
        from: "orders.customer_id",
        to: "customers.id",
        type: "many_to_one",
      }),
    );
  });
});

describe("unknown connector", () => {
  it("refuses kinds that are not registered", () => {
    expect(() => loadProvider({ type: "powerbi", path: dbtShop }, { projectDir: dbtShop })).toThrow(GraneError);
  });
});
