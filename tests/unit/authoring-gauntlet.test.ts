import { describe, expect, it } from "vitest";
import { runAuthoringActivateGauntlet } from "../gauntlet/authoring-activate.js";
import { runAuthoringMcpSweep } from "../gauntlet/authoring-sweep.js";
import {
  runAuthoringActiveWrites,
  runAuthoringHostileArgs,
  runAuthoringPromptInjection,
  runAuthoringSelfApprove,
} from "../gauntlet/authoring-hostile.js";
import {
  runAuthoringDemoGrain,
  runAuthoringExplorationPolicy,
  runAuthoringHugeSchema,
  runAuthoringTimeLikeGroupBy,
} from "../gauntlet/authoring-schema.js";
import { runTamperedActivePinGauntlet } from "../gauntlet/active-pin-tamper.js";

describe("V2-14 authoring gauntlet", () => {
  it("MCP sweep covers every registered tool and leaves pin/main/proposal refs unmoved", async () => {
    const verdict = await runAuthoringMcpSweep();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  }, 60_000);

  it("prompt injection in comments/samples cannot merge, pin, approve, or run SQL", async () => {
    const verdict = await runAuthoringPromptInjection();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("self-approve is refused", async () => {
    const verdict = await runAuthoringSelfApprove();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses active YAML and .grane/active.json writes", async () => {
    const verdict = await runAuthoringActiveWrites();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("refuses hostile slug and path arguments", async () => {
    const verdict = await runAuthoringHostileArgs();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("discovery outside the exploration policy is refused", async () => {
    const verdict = await runAuthoringExplorationPolicy();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("huge schemas do not move main or write a pin", async () => {
    const verdict = await runAuthoringHugeSchema();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("time-like number/text columns must not pass group_by", async () => {
    const verdict = await runAuthoringTimeLikeGroupBy();
    expect(verdict.code, verdict.detail).toMatch(/^PASS/);
  });

  it("nullable UNIQUE is not grain; demo PG composite/keyless skipped", async () => {
    const verdict = await runAuthoringDemoGrain();
    expect(verdict.code, verdict.detail).toMatch(/^PASS/);
  });

  it("pin tamper table fails closed", async () => {
    const verdict = await runTamperedActivePinGauntlet();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });

  it("activate walk still refuses pins and keeps main SHA", async () => {
    const verdict = await runAuthoringActivateGauntlet();
    expect(verdict.code, verdict.detail).toBe("PASS — POLICY");
  });
});
