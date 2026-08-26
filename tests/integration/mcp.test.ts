import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import pg from "pg";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadConfig } from "../../src/config/load.js";
import { GraneKernel } from "../../src/kernel.js";
import { serveHttp } from "../../src/mcp/transport.js";

/** End-to-end MCP test: a real MCP client against Grane's streamable HTTP server. */

const DB_URL =
  process.env.GRANE_TEST_DATABASE_URL ??
  "postgres://grane_readonly:grane_readonly@localhost:5433/grane_demo";
const PORT = 8199;

const exampleDir = join(dirname(fileURLToPath(import.meta.url)), "../../example/analytics");

async function databaseUp(): Promise<boolean> {
  const pool = new pg.Pool({ connectionString: DB_URL, connectionTimeoutMillis: 3000 });
  try {
    await pool.query("SELECT 1");
    return true;
  } catch {
    return false;
  } finally {
    await pool.end();
  }
}

const dbUp = await databaseUp();

describe.skipIf(!dbUp)("MCP over streamable HTTP (integration)", () => {
  let kernel: GraneKernel;
  let client: Client;

  beforeAll(async () => {
    const { config } = loadConfig(exampleDir);
    config.connection.url = DB_URL;
    kernel = new GraneKernel(config);
    await serveHttp(kernel, PORT);

    client = new Client({ name: "grane-test-client", version: "0.0.1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://localhost:${PORT}/mcp`));
    await client.connect(transport);
  });

  afterAll(async () => {
    await client?.close();
    await kernel?.close();
  });

  const parseText = (result: Awaited<ReturnType<Client["callTool"]>>) => {
    const content = result.content as { type: string; text: string }[];
    const text = content[0]!.text;
    const start = text.indexOf("{");
    return JSON.parse(start >= 0 ? text.slice(start) : text) as Record<string, unknown>;
  };

  it("exposes the four-tool surface", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "catalog",
      "explain",
      "query",
      "validate",
    ]);
  });

  it("catalog() lists governed metrics with definitions and availability", async () => {
    const result = await client.callTool({ name: "catalog", arguments: { search: "revenue" } });
    const catalog = parseText(result);
    const metrics = catalog["metrics"] as { name: string; available_dimensions: string[] }[];
    const revenue = metrics.find((m) => m.name === "revenue")!;
    expect(revenue.available_dimensions).toContain("country");
    expect((catalog["server"] as { query_model: string }).query_model).toBe("v1");
    expect((catalog["exploration"] as { enabled: boolean }).enabled).toBe(true);
  });

  it("query() returns rows plus provenance marked trust: governed", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: {
        query: {
          metrics: ["revenue"],
          dimensions: ["country"],
          time: { from: "2000-01-01", to: "2100-01-01" },
        },
      },
    });
    const payload = parseText(result);
    expect((result.content as { text: string }[])[0]!.text.startsWith("trust: governed")).toBe(true);
    expect(payload["headline"]).toBe(
      "trust: governed — every field is an approved definition.",
    );
    expect(Object.keys(payload)[0]).toBe("trust");
    expect((payload["rows"] as unknown[]).length).toBeGreaterThan(0);
    const provenance = payload["provenance"] as Record<string, unknown>;
    expect(provenance["trust"]).toBe("governed");
    expect(payload["trust"]).toBe("governed");
    expect(provenance["query_id"]).toMatch(/^q_/);
    expect(provenance["generated_sql"]).toContain("SELECT");
  });

  it("query() can slice a governed metric by a raw column (trust: mixed)", async () => {
    const result = await client.callTool({
      name: "query",
      arguments: {
        query: {
          metrics: ["revenue"],
          raw_dimensions: ["customers.name"],
          limit: 3,
        },
      },
    });
    const payload = parseText(result);
    expect(payload["trust"]).toBe("mixed");
    expect(payload["ungoverned"]).toEqual(["customers.name"]);
    expect((payload["rows"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("explain() shows the join plan and SQL without executing", async () => {
    const result = await client.callTool({
      name: "explain",
      arguments: { query: { metrics: ["revenue"], dimensions: ["country"] } },
    });
    const payload = parseText(result);
    expect(payload["base_table"]).toBe("orders");
    expect(payload["generated_sql"]).toContain('JOIN "public"."customers"');
  });

  it("validate() refuses undefined metrics with a structured refusal", async () => {
    const result = await client.callTool({
      name: "validate",
      arguments: { query: { metrics: ["CAC"] } },
    });
    expect(result.isError).toBe(true);
    const payload = parseText(result);
    expect(payload["status"]).toBe("undefined_metric");
    expect(payload["requested"]).toBe("CAC");
  });
});
