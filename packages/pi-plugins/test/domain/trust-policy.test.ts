import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createTrustCandidate,
  describeTrustChange,
  evaluateTrust,
  grantTrust,
  revokeTrust,
} from "../../src/domain/trust-policy.js";
import { createContentManifest, hashContent } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { directPlugin, claimFixture, componentId } from "../fixtures/compatibility/common.js";
import { createCompatibilityReport } from "../../src/domain/compatibility.js";
import { flattenComponents } from "../../src/domain/components.js";
import type { NormalizedPlugin } from "../../src/domain/plugin.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

function reportFor(plugin: NormalizedPlugin) {
  return createCompatibilityReport({
    plugin: plugin.identity,
    activatable: true,
    components: flattenComponents(plugin.components).map((component) => ({
      componentId: component.id,
      verdict: { kind: "supported" },
      requirementIds: [],
      diagnostics: [],
    })),
    requirements: [],
    diagnostics: [],
  });
}

function candidate(plugin = directPlugin(), scope: { kind: "user" } | { kind: "project"; projectKey: string } = { kind: "user" }) {
  const marketplaceSource = createResolvedMarketplaceSource({
    declared: { kind: "github", repository: "example/marketplace" },
    revision: "b".repeat(40),
  }, sha256);
  const contentBytes = new TextEncoder().encode("manifest");
  const content = createContentManifest([{
    kind: "file",
    path: "README.md",
    mode: 0o644,
    size: contentBytes.byteLength,
    digest: hashContent(contentBytes, sha256),
  }], sha256);
  return createTrustCandidate({
    scope,
    marketplaceSource,
    plugin,
    compatibility: reportFor(plugin),
    content,
  }, sha256);
}

describe("exact trust policy", () => {
  it("binds trust to complete materialization and executable surface evidence", () => {
    const first = candidate();
    const changed = candidate(directPlugin({ components: { hooks: [{
      kind: "hook",
      id: componentId("hook", "1"),
      event: claimFixture("SessionStart"),
      handler: claimFixture({ kind: "shell" as const, command: "changed" }),
      metadata: [],
    }] } }));
    expect(first.evidence.immutableRevision).toMatch(/^sha256:/);
    expect(first.subject).toBeDefined();
    expect(changed.subject).not.toBe(first.subject);
    expect(evaluateTrust(first, [grantTrust(first, sha256)], sha256)).toEqual({
      kind: "authorized",
      subject: first.subject,
    });
  });

  it("does not infer sibling revisions, scopes, or sources", () => {
    const first = candidate();
    const project = candidate(directPlugin(), {
      kind: "project",
      projectKey: `project-v1:sha256:${"1".repeat(64)}`,
    });
    expect(evaluateTrust(project, [grantTrust(first, sha256)], sha256)).toEqual({
      kind: "denied",
      reason: "ABSENT",
    });
  });

  it("makes revoke and duplicate grants exact and idempotent", () => {
    const current = candidate();
    const granted = grantTrust(current, sha256);
    expect(grantTrust(current, sha256)).toEqual(granted);
    const revoked = revokeTrust(current, sha256);
    expect(revokeTrust(current, sha256)).toEqual(revoked);
    expect(evaluateTrust(current, [revoked], sha256)).toEqual({ kind: "denied", reason: "REVOKED" });
    expect(evaluateTrust(current, [], sha256)).toEqual({ kind: "denied", reason: "ABSENT" });
  });

  it("rejects forged source, binding, compatibility, and subject evidence", () => {
    const current = candidate();
    expect(() => createTrustCandidate({
      scope: current.evidence.scope,
      marketplaceSource: {
        declared: { kind: "github", repository: "example/marketplace" },
        revision: "b".repeat(40),
        canonical: current.evidence.marketplaceSource,
        hash: "sha256:" + "f".repeat(64),
      },
      plugin: directPlugin(),
      compatibility: reportFor(directPlugin()),
      content: createContentManifest([], sha256),
      materializationBinding: current.evidence.immutableRevision as never,
    }, sha256)).toThrow();
    expect(evaluateTrust({ ...current, subject: `trust-subject-v1:sha256:${"f".repeat(64)}` as typeof current.subject }, [], sha256))
      .toEqual({ kind: "denied", reason: "EVIDENCE_MISMATCH" });
  });

  it("describes only safe surface identities and field names", () => {
    const before = candidate();
    const after = candidate(directPlugin({ configuration: { options: [{
      key: "SECRET",
      label: claimFixture("Secret"),
      value: { kind: "string" },
      required: true,
      sensitive: true,
      provenance: [claimFixture("SECRET_VALUE").provenance[0]!],
    }] } }));
    const change = describeTrustChange(before, after, sha256);
    const serialized = JSON.stringify(change);
    expect(serialized).not.toContain("SECRET_VALUE");
    expect(change.added).toEqual([{ kind: "configuration", identity: "SECRET" }]);
    expect(change).not.toHaveProperty("surface");
  });
});
