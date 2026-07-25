import { describe, expect, it } from "vitest";
import { createTrustedInstallServiceHarness } from "../fixtures/trusted-install/service-harness.js";

const hostile = "CANARY_SECRET\u0000\u202e/private/project?credential=exposed";

describe("trusted installation composed public-evidence security", () => {
  it("keeps hostile configuration and callback output out of session, progress, and results", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    expect(JSON.stringify(opened)).not.toContain("/private/staging");
    expect(JSON.stringify(opened)).not.toContain("/private/marketplace");

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session, { name: hostile, token: hostile }),
    }, {
      onProgress() { throw new Error(`${hostile}:callback`); },
    }, new AbortController().signal);

    expect(result.kind).toBe("succeeded");
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("CANARY_SECRET");
    expect(serialized).not.toContain("credential=");
    expect(serialized).not.toContain("/private/");
    expect(serialized).not.toMatch(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u);
    expect(serialized).not.toContain("secret-v1:");
    await harness.close();
  });

  it("fails closed on captured capability evidence staleness before mutation", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");
    harness.controls.setEvidenceStale();

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, new AbortController().signal);

    expect(result).toMatchObject({ kind: "stale", reason: "capability" });
    expect(harness.configurationStore.document).toBeUndefined();
    expect(harness.state.current.trust.records).toHaveLength(0);
    expect(harness.counters.promotions).toBe(0);
    await harness.close();
  });

  it("rejects a stale opaque project-root authority without user-scope fallback", async () => {
    const harness = createTrustedInstallServiceHarness({ project: true, projectRootStale: true });

    const result = await harness.service.open(harness.request, new AbortController().signal);

    expect(result).toEqual({ kind: "stale", reason: "project" });
    expect(result).not.toHaveProperty("session");
    expect(harness.configurationStore.document).toBeUndefined();
    expect(harness.state.current.trust.records).toHaveLength(0);
    await harness.close();
  });
});
