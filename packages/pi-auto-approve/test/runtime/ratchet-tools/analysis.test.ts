import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

import type { AuditLogger } from "../../../src/audit/logger.ts";
import type {
  PolicyResolver,
  PolicyResolverResult,
  ResolvedPolicy,
} from "../../../src/runtime/policy-cache.ts";
import {
  buildRatchetCorpusModel,
  resolveRatchetPolicy,
} from "../../../src/runtime/ratchet-tools/analysis.ts";
import type { RatchetToolDependencies } from "../../../src/runtime/ratchet-tools/types.ts";

function fakeContext(entries?: readonly unknown[]): ExtensionContext {
  const sessionManager =
    entries === undefined
      ? undefined
      : {
          getSessionId: () => "session-1",
          getEntries: () => entries,
          getBranch: () => entries,
        };

  return {
    cwd: "/tmp/pi-auto-approve-test-project",
    ...(sessionManager === undefined ? {} : { sessionManager }),
  } as unknown as ExtensionContext;
}

function sessionToolCall(id: string, command: string): unknown {
  return {
    type: "message",
    timestamp: "2026-01-01T00:00:00Z",
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

function resolvedPolicy(): ResolvedPolicy {
  return {
    config: {
      cwd: "/tmp/pi-auto-approve-test-project",
      homeDirectory: "/home/user",
      projectScope: {
        roots: ["/tmp/pi-auto-approve-test-project"],
        writableDirectories: ["/tmp/pi-auto-approve-test-project"],
        tempDirectories: ["/tmp"],
        deniedDirectories: [],
        safeHomeDirectories: [],
        unknownPathBehavior: "review",
  sensitivePathBehavior: "review",
  homePathBehavior: "allow",
      },
    },
    effectivePolicy: { rules: [] },
    registry: {},
    packageRegistration: {
      requestId: null,
      packs: [],
      issues: [],
    },
    warnings: [],
  } as unknown as ResolvedPolicy;
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
    packageRegistration: () => ({
      requestId: null,
      packs: [],
      issues: [],
    }),
    audit,
  };
}

describe("ratchet tool analysis helpers", () => {
  it("resolves policy through the shared dependency", async () => {
    const policy = resolvedPolicy();

    await expect(
      resolveRatchetPolicy(fakeContext(), dependencies({ ok: true, policy })),
    ).resolves.toBe(policy);
  });

  it("surfaces policy composition failures as tool-facing errors", async () => {
    await expect(
      resolveRatchetPolicy(
        fakeContext(),
        dependencies({ ok: false, reason: "bad config" }),
      ),
    ).rejects.toThrow("clearance policy resolution failed: bad config");
  });

  it("builds a corpus query model with path-fact context", async () => {
    const model = await buildRatchetCorpusModel(
      fakeContext([
        sessionToolCall("tc-git", "git status"),
        sessionToolCall("tc-test", "pnpm test"),
      ]),
      resolvedPolicy(),
      { includeFullShape: false },
    );

    expect(model.summary.totalRecords).toBeGreaterThan(0);
    expect(model.families.length).toBeGreaterThan(0);
    expect(model.warnings).toEqual(expect.any(Array));
  });

  it("passes runtime home directory into ratchet path-fact enrichment", async () => {
    const model = await buildRatchetCorpusModel(
      fakeContext([sessionToolCall("tc-home", "touch ~/notes")]),
      resolvedPolicy(),
      { includeFullShape: false },
    );

    expect(model.records[0]?.parsed.pathFacts?.facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          raw: "~/notes",
          scope: "home",
          absolutePath: "/home/user/notes",
        }),
      ]),
    );
  });
});
