import { describe, expect, it } from "vitest";
import { runAuthoringActivateGauntlet } from "../gauntlet/authoring-activate.js";

describe("MCP authoring cannot activate demo YAML", () => {
  it("walks Set up Grane through submit_proposal, refuses .grane writes, and writes no pin", async () => {
    const verdict = await runAuthoringActivateGauntlet();
    expect(verdict.code).toBe("PASS — POLICY");
    expect(verdict.detail).toMatch(/no active\.json/i);
  });

  it("fails when an agent commit lands on main (mutation)", async () => {
    const verdict = await runAuthoringActivateGauntlet({ mutateMainCommit: true });
    expect(verdict.code).toBe("SECURITY CRITICAL");
    expect(verdict.detail).toMatch(/main SHA moved/);
  });
});
