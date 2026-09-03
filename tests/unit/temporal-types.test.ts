import { describe, expect, it } from "vitest";
import { classifyTemporalType, type WarehouseType } from "../../src/connectors/dialect.js";
import { columnDataType, type DatabaseSchema } from "../../src/connectors/types.js";

describe("classifyTemporalType", () => {
  const date = [
    "date",
    "DATE",
    "Date",
    "date32",
    "DATE32",
  ];
  const naive = [
    "timestamp",
    "timestamp without time zone",
    "timestamp without timezone",
    "TIMESTAMP_NTZ",
    "timestamp_ntz",
    "datetime",
    "DATETIME",
    "datetime64",
    "TIMESTAMP_S",
    "TIMESTAMP_MS",
    "TIMESTAMP_NS",
  ];
  const instant = [
    "timestamptz",
    "timestamp with time zone",
    "timestamp with timezone",
    "TIMESTAMP WITH TIME ZONE",
    "TIMESTAMP_TZ",
    "TIMESTAMP_LTZ",
    "timestamptz(6)",
  ];

  it("classifies civil DATE types", () => {
    for (const type of date) expect(classifyTemporalType(type), type).toBe("date");
  });

  it("classifies naive timestamps before the DATE token in datetime", () => {
    for (const type of naive) expect(classifyTemporalType(type), type).toBe("timestamp_naive");
  });

  it("classifies instants", () => {
    for (const type of instant) expect(classifyTemporalType(type), type).toBe("timestamp_instant");
  });

  it("treats BigQuery TIMESTAMP as an instant and DATETIME as naive", () => {
    expect(classifyTemporalType("TIMESTAMP", "bigquery")).toBe("timestamp_instant");
    expect(classifyTemporalType("DATETIME", "bigquery")).toBe("timestamp_naive");
    expect(classifyTemporalType("DATE", "bigquery")).toBe("date");
    expect(classifyTemporalType("TIMESTAMP", "postgres")).toBe("timestamp_naive");
    expect(classifyTemporalType("TIMESTAMP", "duckdb")).toBe("timestamp_naive");
  });

  it("does not guess at time-of-day or numeric types", () => {
    expect(classifyTemporalType("time")).toBe("unknown");
    expect(classifyTemporalType("numeric")).toBe("unknown");
    expect(classifyTemporalType(null)).toBe("unknown");
    expect(classifyTemporalType("")).toBe("unknown");
  });

  it("is stable across the supported warehouses for DATE", () => {
    const warehouses: WarehouseType[] = [
      "postgres",
      "mysql",
      "snowflake",
      "bigquery",
      "duckdb",
      "clickhouse",
      "redshift",
      "databricks",
    ];
    for (const warehouse of warehouses) {
      expect(classifyTemporalType("DATE", warehouse), warehouse).toBe("date");
    }
  });
});

describe("columnDataType", () => {
  const schema: DatabaseSchema = {
    schemaName: "main",
    tables: [
      {
        schema: "main",
        name: "facts",
        columns: [
          { name: "d", dataType: "DATE", nullable: false },
          { name: "ts", dataType: "TIMESTAMP WITH TIME ZONE", nullable: true },
        ],
      },
    ],
    foreignKeys: [],
  };

  it("looks up exact and case-insensitive names", () => {
    expect(columnDataType(schema, "facts", "d")).toBe("DATE");
    expect(columnDataType(schema, "FACTS", "D")).toBe("DATE");
    expect(columnDataType(schema, "facts", "ts")).toBe("TIMESTAMP WITH TIME ZONE");
    expect(columnDataType(schema, "missing", "d")).toBeNull();
    expect(columnDataType(null, "facts", "d")).toBeNull();
  });
});
