import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import type {
  ConfigWarning,
  ResolvedConfig,
  ResolvedReviewerConfig,
} from "../../../src/config/loader.ts";
import type { PackageRegistrationSnapshot } from "../../../src/packs/package-registration.ts";
import { createPackRegistry } from "../../../src/packs/registry.ts";
import type {
  Decision,
  DecisionEffect,
  EffectivePolicy,
  PolicyRule,
} from "../../../src/policy/core.ts";
import { inspectable, program } from "../../../src/policy/core.ts";
import type {
  PolicyResolver,
  PolicyResolverResult,
  ResolvedPolicy,
} from "../../../src/runtime/policy-cache.ts";
import {
  type AutoReviewerListHistoryFamiliesDetails,
  createAutoReviewerListHistoryFamiliesTool,
} from "../../../src/runtime/ratchet-tools/history.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";
import {
  defaultResolvedDisplay,
  defaultResolvedPackEnablement,
  defaultResolvedProjectScope,
  defaultResolvedReviewer,
} from "../../fixtures/resolved-config.ts";

const TEST_CWD = "/repo";
const TEST_SESSION_ID = "session-1";

const DEFAULT_REVIEWER: ResolvedReviewerConfig = defaultResolvedReviewer();

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function decision(effect: DecisionEffect): Decision {
  return {
    effect,
    reason: `${effect} fixture decision`,
    provenance: { source: "generated", packId: "test-pack" },
  };
}

function policyRule(
  id: string,
  effect: DecisionEffect,
  executable: string,
): PolicyRule {
  return {
    id,
    effect,
    match: inspectable(program(executable)),
    reason: `${effect} ${executable}`,
    provenance: { source: "generated", packId: "test-pack", ruleId: id },
  };
}

function effectivePolicy(): EffectivePolicy {
  return {
    active: [
      policyRule("allow-git", "allow", "git"),
      policyRule("allow-pnpm", "allow", "pnpm"),
    ],
    floor: [policyRule("deny-rm", "deny", "rm")],
  };
}

function resolvedConfig(
  options: { readonly warnings?: readonly ConfigWarning[] } = {},
): ResolvedConfig {
  return {
    version: 1,
    cwd: TEST_CWD,
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
    warnings: options.warnings ?? [],
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
    effectivePolicy: effectivePolicy(),
    registry: createPackRegistry({ resolvedConfig: config }),
    packageRegistration: emptyPackageRegistrationSnapshot(),
    warnings: [],
  };
}

function dependencies(result: PolicyResolverResult): RatchetToolDependencies {
  const policyResolver: PolicyResolver = {
    async resolve() {
      return result;
    },
    invalidate() {},
  };
  const audit: AuditLogger = { async log() {} };

  return {
    policyResolver,
    packageRegistration: emptyPackageRegistrationSnapshot,
    audit,
  };
}

function sessionToolCall(id: string, command: string, second: number): unknown {
  return {
    type: "message",
    timestamp: timestamp(second),
    message: {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id,
          name: "bash",
          arguments: { command },
        },
      ],
    },
  };
}

function timestamp(second: number): string {
  return `2026-01-01T00:00:${String(second).padStart(2, "0")}Z`;
}

function sessionEntries(): readonly unknown[] {
  return [
    sessionToolCall("tc-git", "git status", 0),
    sessionToolCall("tc-pnpm", "pnpm test", 1),
    sessionToolCall("tc-rm", "rm -rf /tmp/foo", 2),
    sessionToolCall("tc-git-var", "git $FOO status", 3),
    sessionToolCall("tc-redirect", "echo ok > out.txt", 4),
  ];
}

function fakeContext(
  entries: readonly unknown[] = sessionEntries(),
): ExtensionContext {
  const sessionManager = {
    getSessionId: () => TEST_SESSION_ID,
    getEntries: () => entries,
    getBranch: () => entries,
  };

  return {
    cwd: TEST_CWD,
    sessionManager,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function throwingSessionContext(): ExtensionContext {
  const sessionManager = {
    getSessionId: () => TEST_SESSION_ID,
    getEntries: () => {
      throw new Error("session unavailable");
    },
    getBranch: () => {
      throw new Error("session unavailable");
    },
  };

  return {
    cwd: TEST_CWD,
    sessionManager,
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function reviewerDecisionAuditEntry(): Record<string, unknown> {
  return {
    version: 1,
    timestamp: timestamp(1),
    entryType: "reviewer.decision",
    reviewerMode: "model",
    toolName: "bash",
    toolInput: { command: "pnpm test" },
    originalDecision: decision("review"),
    finalDecision: decision("allow"),
    sessionId: TEST_SESSION_ID,
    toolCallId: "tc-pnpm",
  };
}

function isolateUserConfig(
  auditEntries: readonly Record<string, unknown>[] = [
    reviewerDecisionAuditEntry(),
  ],
): void {
  const root = mkdtempSync(join(tmpdir(), "pi-auto-approve-history-"));
  tempRoots.push(root);
  vi.stubEnv("XDG_CONFIG_HOME", root);

  const configRoot = join(root, "pi", "pi-auto-approve");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, "audit.log"),
    auditEntries.map((entry) => JSON.stringify(entry)).join("\n"),
  );
}

async function executeHistory(
  params: unknown,
  ctx: ExtensionContext = fakeContext(),
): Promise<{
  readonly details: AutoReviewerListHistoryFamiliesDetails;
  readonly text: string;
}> {
  const tool = createAutoReviewerListHistoryFamiliesTool(
    dependencies({ ok: true, policy: resolvedPolicy() }),
  );
  const result = await tool.execute(
    "tool-call-1",
    params,
    undefined,
    undefined,
    ctx,
  );
  const content = result.content[0];
  if (content?.type !== "text") {
    throw new Error("expected history text result");
  }

  return {
    details: result.details as AutoReviewerListHistoryFamiliesDetails,
    text: content.text,
  };
}

function commands(
  details: AutoReviewerListHistoryFamiliesDetails,
): readonly string[] {
  return details.records.map((record) => record.command);
}

describe("clearance_list_history_families", () => {
  it("returns summary, families, records, page, warnings, and markdown", async () => {
    isolateUserConfig();

    const { details, text } = await executeHistory({
      sources: ["session"],
      orderBy: "timestamp",
      limit: 3,
      offset: 0,
    });

    expect(details.summary.totalRecords).toBe(5);
    expect(details.families.length).toBeGreaterThan(0);
    expect(details.records).toHaveLength(3);
    expect(details.page).toEqual({ offset: 0, limit: 3, total: 5 });
    expect(details.warnings).toEqual([]);
    expect(commands(details)).toEqual([
      "git status",
      "pnpm test",
      "rm -rf /tmp/foo",
    ]);

    expect(text).toContain("# Clearance history families");
    expect(text).toContain("Matching records: 5");
    expect(text).toContain("Records returned: 3");
    expect(text).toContain("Warnings: 0");
    expect(text).toContain(
      "Filters: sources=[session], orderBy=timestamp, limit=3, offset=0",
    );
    expect(text).toContain("## Top families");
  });

  it("honors pagination and family, replay status, captured outcome, and diagnostics filters", async () => {
    isolateUserConfig();

    const familyPage = await executeHistory({
      sources: ["session"],
      familyIds: ["bash:git:status:clean"],
      limit: 1,
      offset: 0,
    });
    expect(commands(familyPage.details)).toEqual(["git status"]);
    expect(familyPage.details.page).toEqual({ offset: 0, limit: 1, total: 1 });

    const modelReviewedFastPath = await executeHistory({
      sources: ["session"],
      replayStatuses: ["fast_path"],
      capturedOutcomeLabels: ["model-allow"],
    });
    expect(commands(modelReviewedFastPath.details)).toEqual(["pnpm test"]);
    expect(modelReviewedFastPath.details.summary.replayStatusCounts).toEqual([
      { label: "fast_path", calls: 1 },
    ]);
    expect(modelReviewedFastPath.details.summary.capturedOutcomeCounts).toEqual(
      [{ label: "model-allow", calls: 1 }],
    );

    const diagnostics = await executeHistory({
      sources: ["session"],
      hasParserDiagnostics: true,
    });
    expect(commands(diagnostics.details)).toEqual(["git $FOO status"]);
    expect(
      diagnostics.details.records[0]?.parsed.summary.diagnosticCodes,
    ).toContain("bash:variable-expansion");
  });

  it("does not throw when session history cannot be read", async () => {
    isolateUserConfig([]);

    const { details } = await executeHistory(
      { sources: ["session"] },
      throwingSessionContext(),
    );

    expect(details.summary.totalRecords).toBe(0);
    expect(details.families).toEqual([]);
    expect(details.records).toEqual([]);
    expect(details.page).toEqual({ offset: 0, limit: 0, total: 0 });
    expect(details.warnings).toEqual([
      "could not read session history: session unavailable",
    ]);
  });

  it("ignores invalid enum and malformed string-list filters with warnings", async () => {
    isolateUserConfig();

    const { details } = await executeHistory({
      familyIds: "bash:git:status:clean",
      sources: ["session", "not-a-source"],
      replayStatuses: ["fast_path", "not-a-status"],
      capturedOutcomeLabels: ["model-allow", "model-maybe"],
      fidelity: ["high", "low"],
      orderBy: "surprise",
    });

    expect(commands(details)).toEqual(["pnpm test"]);
    expect(details.warnings).toEqual([
      "Ignoring familyIds filter because it must be an array of strings.",
      'Ignoring invalid replayStatuses filter "not-a-status". Expected one of: fast_path, review, hard_block.',
      'Ignoring invalid capturedOutcomeLabels filter "model-maybe". Expected one of: deterministic-allow, deterministic-deny, deterministic-review, model-allow, model-deny, model-review, human-allow, human-deny, block-and-log, fixture-fast-path, fixture-review, fixture-hard-block, no-captured-outcome.',
      'Ignoring invalid sources filter "not-a-source". Expected one of: session, audit, corpus.',
      'Ignoring invalid fidelity filter "low". Expected one of: high, redacted.',
      'Ignoring invalid orderBy "surprise". Expected one of: friction, timestamp, command, family.',
    ]);
  });
});
