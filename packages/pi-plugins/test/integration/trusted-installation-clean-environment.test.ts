import { describe, expect, it } from "vitest";
import { createTrustedInstallServiceHarness } from "../fixtures/trusted-install/service-harness.js";

describe("trusted installation composed service flow", () => {
  it("opens, configures, trusts, installs, reloads, and observes one complete plugin", async () => {
    const harness = createTrustedInstallServiceHarness();
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    expect(opened.kind).toBe("opened");
    if (opened.kind !== "opened") return;

    const result = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, new AbortController().signal);

    expect(result).toMatchObject({
      kind: "succeeded",
      components: { skills: 1, hooks: 1, mcpServers: 1 },
      retained: { configuration: true, trust: true },
    });
    expect(harness.state.current.installed.plugins[0]).toMatchObject({ activation: "enabled" });
    expect(harness.state.current.trust.records).toHaveLength(1);
    expect(harness.configurationStore.document).toBeDefined();
    expect(harness.counters).toMatchObject({ materializations: 1, promotions: 1, reloads: 1, observations: 1 });
    await harness.close();
  });

  it("settles ambiguous configuration writes through the advertised opaque operation", async () => {
    const harness = createTrustedInstallServiceHarness();
    harness.controls.commitConfigurationThenThrow(2);
    const opened = await harness.service.open(harness.request, new AbortController().signal);
    if (opened.kind !== "opened") throw new Error("open failed");

    const first = await harness.service.activate({
      token: opened.session.token,
      submission: harness.submission(opened.session),
    }, {}, new AbortController().signal);
    expect(first).toMatchObject({
      kind: "recovery-required",
      action: "retry-configuration-recovery",
      session: { version: 1 },
    });
    expect(first).not.toHaveProperty("transition");

    const recovered = await harness.service.recover({
      token: opened.session.token,
      submission: harness.submission((first as Extract<typeof first, { kind: "recovery-required" }>).session!),
    }, {}, new AbortController().signal);
    expect(recovered.kind).toBe("succeeded");
    expect(harness.secretStore.values).toHaveLength(1);
    await harness.close();
  });
});
