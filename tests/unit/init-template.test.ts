import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { graneYml } from "../../src/cli/templates.js";

describe("grane init templates", () => {
  it("keeps providers commented out by default", () => {
    const doc = parseYaml(graneYml()) as Record<string, unknown>;
    expect(doc.providers).toBeUndefined();
    expect(graneYml()).toContain("# providers:");
  });

  it("--provider writes a live providers block that auto-detects the project", () => {
    const text = graneYml("../jaffle_shop");
    const doc = parseYaml(text) as { providers: unknown; entities: unknown };
    expect(doc.providers).toEqual([{ path: "../jaffle_shop" }]);
    expect(doc.entities).toEqual({});
    expect(text).not.toContain("# providers:");
  });

  it("quotes provider paths that are not plain YAML scalars", () => {
    const doc = parseYaml(graneYml("../my project: v2")) as { providers: { path: string }[] };
    expect(doc.providers[0]?.path).toBe("../my project: v2");
  });
});
