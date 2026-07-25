import { describe, expect, it } from "vitest";
import { createControlFixture } from "../fixtures/native-control/control-fixture.js";

describe("native control concurrency acceptance", () => {
  it("isolates concurrent executions and ordered frame streams", async () => {
    const { service } = createControlFixture();
    const streams = [[], []] as any[][];
    const reports = await Promise.all(streams.map((frames) => service.runArgv(["status"], { mode: "headless", output: "json", sink: { write: async (frame) => { frames.push(frame); }, close: async () => undefined } }, new AbortController().signal)));
    expect(new Set(reports.map((report) => report.envelope.executionId)).size).toBe(2);
    expect(streams.every((frames) => frames.map((frame) => frame.sequence).join() === "0,1")).toBe(true);
  });

  it("rejects forged/stale owner tokens without a latest-session fallback", async () => {
    const { service, applications, ids } = createControlFixture();
    const forged = await service.runArgv(["operation", "status", "native-operation-session-v1:forged"], { mode: "headless", output: "json" }, new AbortController().signal);
    expect(forged.envelope).toMatchObject({ status: "failed", exit: { code: 2 } });
    expect(ids.issue).not.toHaveBeenCalled();
    expect(applications.operations.status).not.toHaveBeenCalled();
  });
});
