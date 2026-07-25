import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import type {
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../../../src/config/loader.ts";
import type { PackageRegistrationSnapshot } from "../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../src/packs/registry.ts";
import type { EffectivePolicy } from "../../../src/policy/core.ts";
import type {
  PolicyResolver,
  PolicyResolverResult,
  ResolvedPolicy,
} from "../../../src/runtime/policy-cache.ts";
import {
  RATCHET_TOOL_PREFIX,
  type RatchetModeManager,
  type RatchetModeStatus,
  type RatchetToolDefinition,
} from "../../../src/runtime/ratchet-mode.ts";
import { createRatchetBatchCache } from "../../../src/runtime/ratchet-tools/batch-cache.ts";
import {
  RATCHET_TOOL_IDS,
  registerRatchetAnalysisTools,
} from "../../../src/runtime/ratchet-tools/index.ts";
import type { AutoReviewerStatusDetails } from "../../../src/runtime/ratchet-tools/status.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../../fixtures/resolved-config.ts";

const EMPTY_POLICY: EffectivePolicy = { rules: [] };

const DEFAULT_REVIEWER: ResolvedReviewerConfig = defaultResolvedReviewer();

function fakeManager(): {
  readonly manager: RatchetModeManager;
  readonly registered: RatchetToolDefinition[];
  readonly status: RatchetModeStatus;
} {
  const registered: RatchetToolDefinition[] = [];
  const status: RatchetModeStatus = {
    active: false,
    previousActiveTools: [],
    ratchetToolNames: Object.values(RATCHET_TOOL_IDS),
  };
  const manager = {
    getStatus: () => status,
    registerRatchetTool(tool: RatchetToolDefinition): void {
      registered.push(tool);
    },
  } as unknown as RatchetModeManager;

  return { manager, registered, status };
}

function resolvedConfig(): ResolvedConfig {
  return {
    version: 1,
    cwd: "/tmp/project",
    mode: "ask",
    unknownToolPosture: "review",
    projectScope: defaultResolvedProjectScope(),
    packEnablement: defaultResolvedPackEnablement(),
    display: defaultResolvedDisplay(),
    globalPacks: [],
    projectPacks: [],
    repoPacks: [],
    trustedProject: {
      trusted: true,
    },
    reviewer: DEFAULT_REVIEWER,

    errors: [],
    warnings: [],
  };
}

function emptyPackageRegistrationSnapshot(): PackageRegistrationSnapshot {
  return {
    requestId: null,
    packs: [],
    issues: [],
  };
}

function resolvedPolicy(): ResolvedPolicy {
  const config = resolvedConfig();
  return {
    config,
    effectivePolicy: EMPTY_POLICY,
    registry: createPackRegistry({ resolvedConfig: config }),
    packageRegistration: emptyPackageRegistrationSnapshot(),
    warnings: [],
  };
}

function fakeDependencies(
  result: PolicyResolverResult = { ok: true, policy: resolvedPolicy() },
): RatchetToolDependencies {
  const policyResolver: PolicyResolver = {
    async resolve() {
      return result;
    },
    invalidate() {},
  };
  const audit: AuditLogger = {
    async log() {},
  };

  return {
    policyResolver,
    packageRegistration: emptyPackageRegistrationSnapshot,
    audit,
  };
}

function fakeContext(): ExtensionContext {
  return {
    cwd: "/tmp/project",
    isProjectTrusted: () => true,
  } as ExtensionContext;
}

function toolByName(
  registered: readonly RatchetToolDefinition[],
  name: string,
): RatchetToolDefinition {
  const tool = registered.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    throw new Error(`expected registered tool ${name}`);
  }
  return tool;
}

describe("ratchet analysis tool catalog", () => {
  it("declares exactly the eight Tune-only analysis tool ids", () => {
    expect(Object.values(RATCHET_TOOL_IDS)).toEqual([
      "clearance_status",
      "clearance_list_packs",
      "clearance_list_history_families",
      "clearance_generate_proposals",
      "clearance_show_proposal",
      "clearance_replay_proposal",
      "clearance_validate_pack",
      "clearance_adversarial_cases",
    ]);
  });

  it("keeps every declared id under the ratchet prefix", () => {
    expect(
      Object.values(RATCHET_TOOL_IDS).every((id) =>
        id.startsWith(RATCHET_TOOL_PREFIX),
      ),
    ).toBe(true);
  });

  it("registers exactly the declared tools with prompt metadata", () => {
    const { manager, registered } = fakeManager();

    registerRatchetAnalysisTools(
      manager,
      fakeDependencies(),
      createRatchetBatchCache(),
    );

    expect(registered).toHaveLength(8);
    expect(registered.map((tool) => tool.name)).toEqual(
      Object.values(RATCHET_TOOL_IDS),
    );

    for (const tool of registered) {
      expect(tool.label).not.toHaveLength(0);
      expect(tool.description).not.toMatch(/placeholder|not implemented/i);
      expect(tool.promptSnippet).toBeTypeOf("string");
      expect(tool.promptGuidelines?.[0]).toContain(tool.name);
    }
  });

  it("throws during wiring if a declared id violates the prefix invariant", () => {
    const ids = RATCHET_TOOL_IDS as { status: string };
    const original = ids.status;
    ids.status = "bad_status";

    try {
      const { manager } = fakeManager();
      expect(() =>
        registerRatchetAnalysisTools(
          manager,
          fakeDependencies(),
          createRatchetBatchCache(),
        ),
      ).toThrow(/must start with clearance_/);
    } finally {
      ids.status = original;
    }
  });

  it("wires status and list_packs to real implementations", async () => {
    const { manager, registered, status } = fakeManager();
    registerRatchetAnalysisTools(
      manager,
      fakeDependencies(),
      createRatchetBatchCache(),
    );

    const statusResult = await toolByName(
      registered,
      RATCHET_TOOL_IDS.status,
    ).execute("tool-call-1", {}, undefined, undefined, fakeContext());
    const statusDetails = statusResult.details as AutoReviewerStatusDetails;
    expect(statusDetails).toMatchObject({
      ratchet: status,
      mode: "ask",
      reviewer: {
        promptPosture: "reviewer.default",
      },
      project: { trusted: true, cwd: "/tmp/project" },
    });
    const statusContent = statusResult.content[0];
    if (statusContent?.type !== "text") {
      throw new Error("expected status text result");
    }
    expect(statusContent.text).toContain("# Clearance status");

    const packsResult = await toolByName(
      registered,
      RATCHET_TOOL_IDS.listPacks,
    ).execute(
      "tool-call-2",
      { source: "shipped" },
      undefined,
      undefined,
      fakeContext(),
    );
    expect(packsResult.details).toMatchObject({
      packs: expect.arrayContaining([
        expect.objectContaining({ id: "floor.deny", source: "shipped" }),
      ]),
      warnings: [],
    });
    const packsContent = packsResult.content[0];
    if (packsContent?.type !== "text") {
      throw new Error("expected packs text result");
    }
    expect(packsContent.text).toContain("# Clearance packs");
  });

  it("wires list_history_families to the real implementation", async () => {
    const { manager, registered } = fakeManager();
    registerRatchetAnalysisTools(
      manager,
      fakeDependencies(),
      createRatchetBatchCache(),
    );

    const result = await toolByName(
      registered,
      RATCHET_TOOL_IDS.listHistoryFamilies,
    ).execute(
      "tool-call-1",
      { sources: ["session"], limit: 0 },
      undefined,
      undefined,
      fakeContext(),
    );

    expect(result.details).toMatchObject({
      summary: { totalRecords: 0 },
      families: [],
      records: [],
      page: { offset: 0, limit: 0, total: 0 },
      warnings: expect.any(Array),
    });
    const content = result.content[0];
    if (content?.type !== "text") {
      throw new Error("expected history text result");
    }
    expect(content.text).toContain("# Clearance history families");
  });

  it("has no placeholder tools remaining in the analysis catalog", () => {
    const { manager, registered } = fakeManager();
    registerRatchetAnalysisTools(
      manager,
      fakeDependencies(),
      createRatchetBatchCache(),
    );

    expect(registered.map((tool) => tool.name)).toEqual(
      Object.values(RATCHET_TOOL_IDS),
    );
    for (const tool of registered) {
      expect(tool.description).not.toMatch(/placeholder|not implemented/i);
      expect(tool.promptSnippet).not.toMatch(/placeholder|not implemented/i);
      expect(tool.parameters).toBeDefined();
      expect(tool.execute).toBeTypeOf("function");
    }
  });
});
