import { describe, expect, it } from "vitest";
import { createControlFixture } from "../fixtures/native-control/control-fixture.js";

describe("native control adversarial contract", () => {
  it.each([
    ["unknown option", ["status", "--unknown"]],
    ["duplicate option", ["list", "--limit", "1", "--limit", "2"]],
    ["Unicode option lookalike", ["list", "—limit", "2"]],
    ["credential source", ["marketplace", "add", "https://bearer:secret@example.test/repo.git", "--source-kind", "git"]],
    ["giant value", ["browse", "x".repeat(8193)]],
    ["NUL", ["browse", "a\0b"]],
    ["ANSI", ["browse", "a\u001b[31m"]],
    ["bidi", ["browse", "a\u2066b"]],
    ["lone surrogate", ["browse", "\ud800"]],
  ])("rejects %s before effects", async (_label, argv) => {
    const { service, applications, ids } = createControlFixture();
    const result = await service.runArgv(argv, { mode: "headless", output: "json" }, new AbortController().signal);
    expect(result.envelope).toMatchObject({ status: "failed", exit: { code: 2 } });
    expect(ids.issue).not.toHaveBeenCalled();
    expect(applications.status.snapshot).not.toHaveBeenCalled();
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("bearer");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("\u001b");
  });

  it("treats partial quotes as completion metadata, never executable input", async () => {
    const { service, ids } = createControlFixture();
    expect(service.parseText("browse 'partial", "complete")).toMatchObject({ kind: "incomplete", diagnostics: [{ code: "CONTROL_PARTIAL_INPUT" }] });
    const executed = await service.runText("browse 'partial", { mode: "headless", output: "json" }, new AbortController().signal);
    expect(executed.envelope.exit.code).toBe(2);
    expect(ids.issue).not.toHaveBeenCalled();
  });
});
