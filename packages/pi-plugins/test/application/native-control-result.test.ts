import { describe, expect, it } from "vitest";
import { createNativeControlResultProjector } from "../../src/application/native-control-result.js";
import { createNativeControlParser } from "../../src/application/native-control-parser.js";
import { ControlReadyStatus } from "../fixtures/native-control/control-fixture.js";

const parser = createNativeControlParser();
const parsed = parser.parseArgv(["status"]);
if (parsed.kind !== "parsed") throw new Error("fixture failed");
const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;

describe("native control result projection", () => {
  it("preserves semantic status/exit across renderer-neutral projection", () => {
    const projector = createNativeControlResultProjector();
    expect(projector.project(parsed.command, { status: "stale", data: ControlReadyStatus, diagnostics: [], human: [] }, executionId)).toMatchObject({ status: "stale", exit: { classification: "conflict-or-stale", code: 5 } });
    expect(projector.project(parsed.command, { status: "recovery-required", data: ControlReadyStatus, diagnostics: [], human: [] }, executionId)).toMatchObject({ status: "recovery-required", exit: { code: 8 }, data: { status: "ready" } });
  });
});
