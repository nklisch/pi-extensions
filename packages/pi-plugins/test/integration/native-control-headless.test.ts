import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createNodeControlInput } from "../../src/infrastructure/control/node-control-input.js";
import { NativeControlDeliveryClosedError } from "../../src/application/native-control-progress.js";
import { createControlFixture } from "../fixtures/native-control/control-fixture.js";

const token = `trusted-install-session-v1:123e4567-e89b-42d3-a456-426614174000.${"a".repeat(64)}`;
const session = {
  token,
  version: 0,
  fields: [],
  consent: { consentId: `trusted-install-consent-v1:sha256:${"b".repeat(64)}` },
  binding: { plugin: "demo@market", scope: { kind: "user" }, immutableRevision: `sha256:${"c".repeat(64)}`, executableSurfaceDigest: `sha256:${"d".repeat(64)}` },
};

describe("native control headless acceptance", () => {
  it("never prompts and reports missing/no-TTY input before activation", async () => {
    const { service, applications } = createControlFixture();
    applications.trustedInstallation.status.mockResolvedValue({ kind: "found", session } as never);
    const tty = Readable.from([]) as Readable & { isTTY?: boolean };
    tty.isTTY = true;
    const report = await service.runArgv(["--input-stdin", "install", "apply", token], { mode: "headless", output: "json", input: createNodeControlInput({ stdin: tty }) }, new AbortController().signal);
    expect(report.envelope).toMatchObject({ status: "input-required", exit: { code: 3 }, diagnostics: [{ code: "CONTROL_INPUT_REQUIRED" }] });
    expect(applications.trustedInstallation.activate).not.toHaveBeenCalled();
  });

  it("keeps semantic mutation truth when stdout closes during result", async () => {
    const { service } = createControlFixture();
    let writes = 0;
    const sink = { async write() { writes += 1; if (writes === 2) throw new NativeControlDeliveryClosedError(); }, async close() {} };
    const registration = `marketplace-registration-v1:sha256:${"a".repeat(64)}`;
    const report = await service.runArgv(["marketplace", "remove", registration, "--yes"], { mode: "headless", output: "json", sink }, new AbortController().signal);
    expect(report.envelope).toMatchObject({ status: "no-change", data: { kind: "unchanged" } });
    expect(report.delivery).toBe("closed");
    expect(report.deliveredThrough).toBe(0);
  });

  it("does not disclose hostile argv or native failures", async () => {
    const { service, applications, ids } = createControlFixture();
    const hostile = await service.runArgv(["browse", "secret\u202e"], { mode: "headless", output: "json" }, new AbortController().signal);
    expect(hostile.envelope).toMatchObject({ status: "failed", exit: { code: 2 } });
    expect(JSON.stringify(hostile)).not.toContain("secret");
    expect(ids.issue).not.toHaveBeenCalled();

    const native = await service.runArgv(["list"], { mode: "headless", output: "json" }, new AbortController().signal);
    expect(native.envelope).toMatchObject({ status: "unavailable", diagnostics: [{ code: "ADAPTER_FAILED" }] });
    expect(JSON.stringify(native)).not.toContain("private canary");
    expect(applications.inspection.list).toHaveBeenCalledOnce();
  });
});
