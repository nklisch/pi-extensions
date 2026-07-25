import { describe, expect, it } from "vitest";
import { createNativeControlHumanProjector } from "../../src/application/native-control-human.js";
import { createNativeControlEnvelope } from "../../src/application/native-control-contract.js";
import { ControlReadyStatus } from "../fixtures/native-control/control-fixture.js";

describe("native control human fields", () => {
  it("returns only prevalidated safe fields and never machine JSON", () => {
    const envelope = createNativeControlEnvelope({
      executionId: "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never,
      command: "status",
      status: "ok",
      data: {
        ...ControlReadyStatus,
        capabilities: {
          ...ControlReadyStatus.capabilities,
          mcp: { status: "unavailable", explanation: "secretMachineCanary" },
        },
      },
      human: [{ text: "Host ready", escaped: false, truncated: false }],
    });
    const fields = createNativeControlHumanProjector().render(envelope);
    expect(fields).toEqual([{ text: "Host ready", escaped: false, truncated: false }]);
    expect(JSON.stringify(fields)).not.toContain("secretMachineCanary");
  });
});
