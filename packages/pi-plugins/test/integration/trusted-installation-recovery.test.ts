import { describe, expect, it } from "vitest";
import { createTrustedInstallServiceHarness } from "../fixtures/trusted-install/service-harness.js";

async function openAndActivate(harness: ReturnType<typeof createTrustedInstallServiceHarness>) {
  const opened = await harness.service.open(harness.request, new AbortController().signal);
  if (opened.kind !== "opened") throw new Error("open failed");
  const result = await harness.service.activate({
    token: opened.session.token,
    submission: harness.submission(opened.session),
  }, {}, new AbortController().signal);
  return { opened, result };
}

describe("trusted installation composed rollback and recovery", () => {
  it("returns verified rollback when reload rejects the committed candidate", async () => {
    const harness = createTrustedInstallServiceHarness({ rejectReload: true });
    const { result } = await openAndActivate(harness);
    expect(result).toMatchObject({ kind: "rolled-back", restored: true, retained: { configuration: true, trust: true } });
    expect(harness.state.current.installed.plugins).toHaveLength(0);
    expect(harness.counters.reloads).toBe(2);
    await harness.close();
  });

  it("rolls back when configuration changes across reload observation", async () => {
    const harness = createTrustedInstallServiceHarness();
    harness.controls.mutateConfigurationDuringReload();
    const { result } = await openAndActivate(harness);
    expect(result).toMatchObject({ kind: "rolled-back", restored: true });
    expect(harness.state.current.installed.plugins).toHaveLength(0);
    expect(harness.counters.reloads).toBe(2);
    await harness.close();
  });

  it("cites lifecycle recovery only for an actual ambiguous lifecycle transition", async () => {
    const harness = createTrustedInstallServiceHarness({ lifecycleRecovery: true });
    const { result } = await openAndActivate(harness);
    expect(result).toMatchObject({ kind: "recovery-required", action: "run-recovery" });
    expect(result).not.toHaveProperty("session");
    expect(harness.counters.reloads).toBe(0);
    await harness.close();
  });

  it("settles stored credential cleanup through configuration recovery before continuing", async () => {
    const harness = createTrustedInstallServiceHarness();
    const first = await openAndActivate(harness);
    expect(first.result.kind).toBe("succeeded");
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("second open failed");
    harness.controls.failSecretCleanup(2);

    const pending = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session, { name: "updated", token: "rotated-token" }),
    }, {}, new AbortController().signal);
    expect(pending).toMatchObject({ kind: "recovery-required", action: "retry-configuration-recovery" });
    if (pending.kind !== "recovery-required" || pending.session === undefined) throw new Error("configuration recovery session missing");

    const recovered = await harness.service.recover({
      token: opened.session.token,
      submission: harness.submission(pending.session, { name: "updated", token: "rotated-token" }),
    }, {}, new AbortController().signal);
    expect(recovered).toMatchObject({ kind: "current-state", reason: "already-active" });
    expect(harness.secretStore.values.size).toBe(1);
    expect(JSON.stringify(pending)).not.toContain("secret-v1:");
    await harness.close();
  });
});
