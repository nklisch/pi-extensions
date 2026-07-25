import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { claim } from "../../src/domain/provenance.js";
import {
  createActiveProjectionExpectation,
  createInactiveProjectionExpectation,
  createPluginRuntimeProjection,
  verifyProjectionExpectation,
} from "../../src/application/ports/runtime-projection.js";
import {
  createLifecycleTransitionRecord,
} from "../../src/application/ports/lifecycle-transition-store.js";
import { deriveLifecyclePendingTransitionRef } from "../../src/application/plugin-lifecycle-contract.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const provenance = { location: { host: "claude" as const, documentKind: "manifest" as const, path: "plugin.json", pointer: "" } };
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "demo@community", marketplaceName: "community", marketplaceEntryName: "demo" },
  source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/demo.git", revision: "a".repeat(40) }, sha256),
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({
  plugin: plugin.identity,
  activatable: true,
  components: [],
  requirements: [],
  diagnostics: [],
});
const content = createContentManifest([], sha256);

function revision(scope: { kind: "user" } | { kind: "project"; projectKey: string }) {
  return createInstalledRevisionRecord({ plugin, compatibility, content, scope }, sha256);
}

function installed(scope: { kind: "user" } | { kind: "project"; projectKey: string }) {
  const value = revision(scope);
  return createInstalledPluginRecord({
    plugin: plugin.identity.key,
    activation: "enabled",
    revisions: [value],
    scope,
  }, sha256);
}

describe("lifecycle contracts", () => {
  it("derives active projection evidence from logical fields only", () => {
    const userRevision = revision({ kind: "user" });
    const projectRevision = revision({ kind: "project", projectKey: `project-v1:sha256:${"1".repeat(64)}` });
    const user = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision: userRevision, sha256 });
    const project = createPluginRuntimeProjection({ scope: projectRevision.dataRef.startsWith("plugin-data") ? { kind: "project", projectKey: `project-v1:sha256:${"1".repeat(64)}` } : { kind: "user" }, plugin, compatibility, revision: projectRevision, sha256 });
    expect(user.digest).not.toBe(project.digest);
    expect(JSON.stringify(user)).not.toContain("example.invalid");
    expect(JSON.stringify(user)).not.toContain("file://");
    expect(createActiveProjectionExpectation(user, sha256).projectionRef).toMatch(/^runtime-projection-v1:sha256:/);
  });

  it("rejects forged active evidence and keeps inactive tombstones deterministic", () => {
    const value = createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision: revision({ kind: "user" }), sha256 });
    const active = createActiveProjectionExpectation(value, sha256);
    expect(verifyProjectionExpectation(active, sha256)).toEqual(active);
    expect(() => verifyProjectionExpectation({ ...active, projectionRef: "runtime-projection-v1:sha256:" + "0".repeat(64) }, sha256)).toThrow();
    expect(() => createPluginRuntimeProjection({ scope: { kind: "user" }, plugin, compatibility, revision: revision({ kind: "user" }), sha256, digest: "sha256:" + "0".repeat(64) })).toThrow();

    const first = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
    const second = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
    const other = createInactiveProjectionExpectation({ scope: { kind: "project", projectKey: `project-v1:sha256:${"2".repeat(64)}` }, plugin: plugin.identity.key, sha256 });
    expect(first).toEqual(second);
    expect(first.digest).not.toBe(other.digest);
    expect(first.digest).not.toBe(value.digest);
  });

  it("binds transition records to an operation, target, generation, and opaque reference", () => {
    const previous = installed({ kind: "user" });
    const reference = deriveLifecyclePendingTransitionRef({
      operationId: "00000000-0000-4000-8000-000000000001",
      scope: { kind: "user" },
      plugin: plugin.identity.key,
      startingGeneration: 3,
    }, sha256);
    const record = createLifecycleTransitionRecord({
      operationId: "00000000-0000-4000-8000-000000000001",
      operation: "update",
      origin: "manual",
      scope: { kind: "user" },
      plugin: plugin.identity.key,
      startingGeneration: 3,
      previous,
      candidate: previous,
      final: previous,
      projection: createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 }),
      retainedData: "keep",
      reference,
      sha256,
    });
    expect(record.reference).toBe(reference);
    expect(record.previous).not.toHaveProperty("pendingTransition");
    expect(() => createLifecycleTransitionRecord({
      ...record,
      reference: "pending-transition-v1:sha256:" + "0".repeat(64),
      sha256,
    })).toThrow(/reference/);
  });
});
