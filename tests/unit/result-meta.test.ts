import { describe, expect, it } from "vitest";
import {
  columnsFromDatabricksSchema,
  executedRowsFromClickHouseJson,
  executedRowsFromDatabricks,
  executedRowsFromBigQuery,
  schemaFromBigQueryResults,
} from "../../src/connectors/result-meta.js";

describe("ClickHouse JSON envelope", () => {
  it("keeps column names when data is empty", () => {
    const result = executedRowsFromClickHouseJson(
      {
        meta: [{ name: "revenue" }, { name: "country" }],
        data: [],
        rows: 0,
      },
      1000,
    );
    expect(result.columns).toEqual(["revenue", "country"]);
    expect(result.rows).toEqual([]);
  });

  it("uses meta even when rows exist", () => {
    const result = executedRowsFromClickHouseJson(
      {
        meta: [{ name: "revenue" }],
        data: [{ revenue: 10 }],
      },
      1000,
    );
    expect(result.columns).toEqual(["revenue"]);
    expect(result.rows).toEqual([{ revenue: 10 }]);
  });

  it("falls back for JSONEachRow arrays", () => {
    const empty = executedRowsFromClickHouseJson([], 10);
    expect(empty.columns).toEqual([]);
    expect(empty.rows).toEqual([]);
    const rows = executedRowsFromClickHouseJson([{ revenue: 1 }], 10);
    expect(rows.columns).toEqual(["revenue"]);
  });
});

describe("Databricks schema metadata", () => {
  it("reads Hive columnName on an empty fetchAll", () => {
    const result = executedRowsFromDatabricks([], { columns: [{ columnName: "revenue" }, { columnName: "country" }] }, 100);
    expect(result.columns).toEqual(["revenue", "country"]);
    expect(result.rows).toEqual([]);
  });

  it("accepts name as well as columnName", () => {
    expect(columnsFromDatabricksSchema({ columns: [{ name: "orders" }] })).toEqual(["orders"]);
  });

  it("falls back to the first row when schema is missing", () => {
    const result = executedRowsFromDatabricks([{ revenue: 1 }], null, 10);
    expect(result.columns).toEqual(["revenue"]);
  });
});

describe("BigQuery job schema metadata", () => {
  it("keeps column names when rows are empty", () => {
    const result = executedRowsFromBigQuery([], { fields: [{ name: "revenue" }, { name: "country" }] }, 100);
    expect(result.columns).toEqual(["revenue", "country"]);
    expect(result.rows).toEqual([]);
  });

  it("prefers schema over the first row", () => {
    const result = executedRowsFromBigQuery([{ revenue: 1, extra: 2 }], { fields: [{ name: "revenue" }] }, 10);
    expect(result.columns).toEqual(["revenue"]);
  });

  it("reads schema from getQueryResults apiResponse, not job.metadata", () => {
    const apiResponse = { schema: { fields: [{ name: "revenue" }, { name: "country" }] } };
    const job = { metadata: {} };
    expect(schemaFromBigQueryResults(apiResponse, job)).toEqual(apiResponse.schema);
    expect(schemaFromBigQueryResults(undefined, { metadata: { schema: { fields: [{ name: "nope" }] } } })).toBeUndefined();
  });

  it("falls back to statistics.query.schema when the apiResponse has none", () => {
    const dryRun = { fields: [{ name: "revenue" }] };
    expect(
      schemaFromBigQueryResults(undefined, { metadata: { statistics: { query: { schema: dryRun } } } }),
    ).toBe(dryRun);
  });
});
