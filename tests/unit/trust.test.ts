import { describe, expect, it } from "vitest";
import { mcpTrustText, payloadWithTrustFirst, trustHeadline } from "../../src/query/trust.js";

describe("trust headlines", () => {
  it("leads MCP text with the headline and puts trust first in JSON", () => {
    const text = mcpTrustText({
      trust: "mixed",
      rows: [{ revenue: 1 }],
      ungoverned: ["orders.discount_code"],
    });
    expect(text.startsWith("trust: mixed —")).toBe(true);
    const json = JSON.parse(text.slice(text.indexOf("{"))) as Record<string, unknown>;
    expect(Object.keys(json).slice(0, 2)).toEqual(["trust", "headline"]);
    expect(json.trust).toBe("mixed");
    expect(json.headline).toBe(trustHeadline("mixed"));
    expect(json.rows).toEqual([{ revenue: 1 }]);
  });

  it("covers all three trust levels", () => {
    expect(trustHeadline("governed")).toContain("approved definition");
    expect(trustHeadline("mixed")).toContain("not approved truth");
    expect(trustHeadline("exploratory")).toContain("not governed");
    expect(payloadWithTrustFirst({ trust: "governed", x: 1 }).headline).toBe(trustHeadline("governed"));
  });
});
