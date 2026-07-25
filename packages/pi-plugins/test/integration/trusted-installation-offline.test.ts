import { describe, expect, it } from "vitest";
import { createTrustedInstallServiceHarness } from "../fixtures/trusted-install/service-harness.js";

describe("trusted installation offline and stale authority", () => {
  it("activates acquired bytes after open without a second source materialization", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    expect(harness.counters.materializations).toBe(1);

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, new AbortController().signal);

    expect(result.kind).toBe("succeeded");
    expect(harness.counters.materializations).toBe(1);
    await harness.close();
  });

  it("returns configuration-stale before promotion or reload when R changes after readExact", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    harness.controls.mutateConfigurationAfterNextAuthoritativeRead();

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, new AbortController().signal);

    expect(result).toMatchObject({ kind: "stale", reason: "configuration" });
    expect(harness.counters.promotions).toBe(0);
    expect(harness.counters.reloads).toBe(0);
    expect(harness.state.current.installed.plugins).toHaveLength(0);
    await harness.close();
  });
});
