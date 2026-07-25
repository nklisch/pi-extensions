import { describe, expect, it } from "vitest";
import { createTrustedInstallServiceHarness } from "../fixtures/trusted-install/service-harness.js";

describe("trusted installation composed concurrency and cancellation", () => {
  it("admits one same-session activation while a real lifecycle transaction is in progress", async () => {
    const harness = createTrustedInstallServiceHarness({ holdReload: true });
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    const submission = harness.submission(opened.session);
    const first = harness.service.activate({ token: opened.session.token, submission }, {}, new AbortController().signal);
    await harness.controls.waitForReload();

    await expect(harness.service.activate({ token: opened.session.token, submission }, {}, new AbortController().signal))
      .resolves.toMatchObject({ kind: "conflict", reason: "operation-in-progress" });
    harness.controls.releaseReload();
    await expect(first).resolves.toMatchObject({ kind: "succeeded" });
    expect(harness.counters.promotions).toBe(1);
    await harness.close();
  });

  it("cancels before a durable transaction and reports the actual phase", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    const controller = new AbortController();
    controller.abort(new DOMException("cancelled", "AbortError"));

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, controller.signal);

    expect(result).toMatchObject({ kind: "cancelled", phase: "input-validation" });
    expect(harness.counters.promotions).toBe(0);
    expect(harness.counters.reloads).toBe(0);
    await harness.close();
  });

  it("returns CLEANUP_FAILED without publishing a session when stale acquired bytes cannot be discarded", async () => {
    const harness = createTrustedInstallServiceHarness();
    harness.controls.setCatalogStaleAfterAcquisition();
    harness.controls.failDiscards(1);

    const result = await harness.service.open(harness.request, new AbortController().signal);

    expect(result).toEqual({ kind: "unavailable", code: "CLEANUP_FAILED", diagnostics: [] });
    expect(result).not.toHaveProperty("session");
    expect(JSON.stringify(result)).not.toContain("/private/staging");
    await harness.close();
    expect(harness.counters.discards).toBe(2);
  });
});
