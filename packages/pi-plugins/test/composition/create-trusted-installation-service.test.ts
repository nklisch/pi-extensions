import { describe, expect, it, vi } from "vitest";
import { createComposedTrustedInstallationService } from "../../src/composition/create-trusted-installation-service.js";

describe("trusted-install packaged composition", () => {
  it("constructs without candidate acquisition or network work", async () => {
    const resolve = vi.fn();
    const acquire = vi.fn();
    const composition = createComposedTrustedInstallationService({
      catalog: { resolve },
      candidateContent: { acquire, withMaterialized: vi.fn() } as never,
      inspector: { inspect: vi.fn() },
      readiness: { trust: vi.fn(), configuration: vi.fn(), secretCustody: () => ({ status: "available", explanation: "ready" }) },
      evidence: { capture: vi.fn(), validate: vi.fn() },
      configuration: { save: vi.fn(), remove: vi.fn() } as never,
      configurations: { read: vi.fn(), replace: vi.fn(), remove: vi.fn() },
      configurationPaths: { normalizeAndInspect: vi.fn() },
      secretCustody: { status: "available", explanation: "ready" },
      userBaseDirectory: "/session/cwd",
      state: { read: vi.fn(), commit: vi.fn() },
      mutations: { runPreparedMutation: vi.fn() },
      projectTrust: { assess: vi.fn() },
      projectRoots: { acquire: vi.fn(), verify: vi.fn() },
      lifecycle: { application: { install: vi.fn(), enable: vi.fn(), disable: vi.fn(), update: vi.fn(), uninstall: vi.fn() }, preparedInstall: { installPrepared: vi.fn() } } as never,
      clock: { nowEpochMilliseconds: () => 0 as never, monotonicMilliseconds: () => 0 },
      sessionIds: { create: vi.fn() },
      hostEpoch: `sha256:${"1".repeat(64)}` as never,
      sha256: () => new Uint8Array(32),
    });
    expect(composition.application).toMatchObject({ open: expect.any(Function), activate: expect.any(Function), run: expect.any(Function), status: expect.any(Function), cancel: expect.any(Function) });
    expect(resolve).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    composition.quiesce();
    await composition.close();
  });
});
