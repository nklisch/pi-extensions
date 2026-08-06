import { describe, expect, it } from "vitest";

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../../src/config/loader.ts";
import { createPackRegistry } from "../../src/packs/registry.ts";
import {
  handleClearanceCommand,
  type AutoReviewerCommandDependencies,
} from "../../src/runtime/command-registry.ts";
import type { CommandPi } from "../../src/runtime/config-commands/types.ts";

const emptyPackageRegistration = () => ({
  requestId: null,
  packs: [],
  issues: [],
});

describe("/clearance command routing", () => {
  it("routes bare /clearance to setup while mode without arguments remains settings", async () => {
    const cwd = "/repo";
    const config = await loadConfig({ cwd });
    const resolver = {
      async resolve() {
        return {
          ok: true as const,
          policy: {
            config,
            effectivePolicy: { rules: [] },
            registry: createPackRegistry({ resolvedConfig: config }),
            packageRegistration: emptyPackageRegistration(),
            warnings: [],
          },
        };
      },
      invalidate() {},
    };
    const deps = {
      manager: {
        getStatus: () => ({
          active: false,
          previousActiveTools: [],
          ratchetToolNames: [],
        }),
      },
      policyResolver: resolver,
      packageRegistration: emptyPackageRegistration,
      audit: { async log() {} },
      recentDecisionSource: { readRecent: () => ({ items: [], warnings: [] }) },
      analyzerRegistry: {
        analyze: async () => ({
          kind: "unknown",
          toolName: "x",
          rawInput: {},
          diagnostics: [],
        }),
      },
    } as unknown as AutoReviewerCommandDependencies;
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select: async () => undefined,
        notify() {},
      },
    } as unknown as ExtensionCommandContext;
    const pi = {
      getActiveTools: () => [],
      getAllTools: () => [],
      sendMessage() {},
    } as unknown as CommandPi;

    const bare = await handleClearanceCommand("", ctx, pi, deps);
    expect(bare.title).toBe("Setup cancelled");

    const mode = await handleClearanceCommand("mode", ctx, pi, deps);
    expect(mode.title).toBe("Pi Clearance settings unavailable");
  });
});
