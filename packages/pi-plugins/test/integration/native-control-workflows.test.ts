import { describe, expect, it } from "vitest";
import { createControlFixture } from "../fixtures/native-control/control-fixture.js";

describe("native control workflow acceptance", () => {
  it("runs read and mutation owners through the same envelope path", async () => {
    const { service, applications } = createControlFixture();
    const list = await service.runArgv(["marketplace", "list"], { mode: "direct", output: "json" }, new AbortController().signal);
    expect(list.envelope).toMatchObject({ status: "ok", data: { registrations: [] } });
    const add = await service.runArgv(["marketplace", "add", "owner/repo"], { mode: "direct", output: "json" }, new AbortController().signal);
    expect(add.envelope).toMatchObject({ status: "rejected", data: { kind: "rejected", code: "SOURCE_UNAVAILABLE" } });
    expect(applications.marketplace.registration.add).toHaveBeenCalledOnce();
  });

  it("preserves partial notice acknowledgment and recovery-relevant exit class", async () => {
    const { service } = createControlFixture();
    const notice = `update-notice-v1:sha256:${"a".repeat(64)}`;
    const result = await service.runArgv(["updates", "notices", "acknowledge", notice], { mode: "headless", output: "json" }, new AbortController().signal);
    expect(result.envelope).toMatchObject({ status: "partial", exit: { code: 8 }, data: { missing: [notice] } });
  });
});
