import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createTrustedInstallSessionRegistry } from "../../src/application/trusted-install-session.js";
import { TrustedInstallSessionPolicy } from "../../src/application/trusted-install-contract.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const hostEpoch = `sha256:${"a".repeat(64)}` as never;

function setup() {
  let monotonic = 0;
  const release = vi.fn(async () => undefined);
  const registry = createTrustedInstallSessionRegistry({
    clock: { nowEpochMilliseconds: () => 1_000 + monotonic as never, monotonicMilliseconds: () => monotonic },
    sessionIds: { create: async () => "2d6737b6-7482-4a50-9310-cd35ce7ddcad" as never },
    hostEpoch, sha256,
  });
  const candidate = { lease: { release } } as never;
  return { registry, candidate, release, advance: (ms: number) => { monotonic += ms; } };
}

describe("trusted-install session registry", () => {
  it("expires idle sessions, rejects stale tokens, and releases once", async () => {
    const value = setup();
    const entry = await value.registry.create(value.candidate, new AbortController().signal);
    expect((await value.registry.lookup(entry.token)).kind).toBe("found");
    value.advance(TrustedInstallSessionPolicy.idleTtlMs + 1);
    expect((await value.registry.lookup(entry.token)).kind).toBe("expired");
    expect(value.release).toHaveBeenCalledTimes(1);
    expect((await value.registry.lookup(`${entry.token.slice(0, -1)}0` as never)).kind).toBe("missing");
  });

  it("projects fractional monotonic touches as integer epoch expiry without extending the lease", async () => {
    const value = setup();
    const entry = await value.registry.create(value.candidate, new AbortController().signal);
    value.advance(0.75);
    expect((await value.registry.lookup(entry.token)).kind).toBe("found");
    expect(value.registry.expiresAt(entry)).toBe(1_000 + TrustedInstallSessionPolicy.idleTtlMs);
    expect(Number.isInteger(value.registry.expiresAt(entry))).toBe(true);
  });

  it("never extends the absolute host-epoch lease", async () => {
    const value = setup();
    const entry = await value.registry.create(value.candidate, new AbortController().signal);
    for (let elapsed = 0; elapsed < TrustedInstallSessionPolicy.absoluteTtlMs; elapsed += TrustedInstallSessionPolicy.idleTtlMs / 2) {
      value.advance(TrustedInstallSessionPolicy.idleTtlMs / 2);
      await value.registry.lookup(entry.token);
    }
    value.advance(1);
    expect((await value.registry.lookup(entry.token)).kind).toBe("expired");
  });

  it("quiesces admission and closes every unclaimed lease idempotently", async () => {
    const value = setup();
    await value.registry.create(value.candidate, new AbortController().signal);
    value.registry.quiesce();
    await expect(value.registry.create(value.candidate, new AbortController().signal)).rejects.toThrow("closed");
    await value.registry.close();
    await value.registry.close();
    expect(value.release).toHaveBeenCalledTimes(1);
  });
});
