import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { writeInitProject } from "../../src/cli/init-project.js";
import { graneYml } from "../../src/cli/templates.js";

describe("grane init templates", () => {
  it("keeps providers commented out by default", () => {
    const doc = parseYaml(graneYml()) as Record<string, unknown>;
    expect(doc.providers).toBeUndefined();
    expect(graneYml()).toContain("fail_closed: true");
    expect(graneYml()).toContain("token_sha256:");
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

  it("writeInitProject scaffolds YAML and skips existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "grane-init-"));
    const first = writeInitProject(dir);
    expect(first.written).toEqual(["grane.yml", "metrics.yml", "dimensions.yml", "relationships.yml"]);
    expect(readFileSync(join(dir, "grane.yml"), "utf8")).toContain("type: postgres");
    const second = writeInitProject(dir);
    expect(second.written).toEqual([]);
    expect(second.skipped).toHaveLength(4);
    rmSync(dir, { recursive: true, force: true });
  });
});
