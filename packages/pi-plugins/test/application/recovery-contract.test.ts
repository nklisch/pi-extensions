import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CompatibilityReportSchema } from "../../src/domain/compatibility.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { NormalizedPluginSchema } from "../../src/domain/plugin.js";
import { claim } from "../../src/domain/provenance.js";
import { createInstalledPluginRecord, createInstalledRevisionRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedPluginSource } from "../../src/domain/source.js";
import { createInactiveProjectionExpectation } from "../../src/application/ports/runtime-projection.js";
import { createLifecycleTransitionRecord } from "../../src/application/ports/lifecycle-transition-store.js";
import { classifyInterruptedTransition, stateWithoutPending } from "../../src/application/recovery-contract.js";
import { deriveLifecyclePendingTransitionRef } from "../../src/application/plugin-lifecycle-contract.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const plugin = NormalizedPluginSchema.parse({
  identity: { key: "recovery@community", marketplaceName: "community", marketplaceEntryName: "recovery" },
  source: createResolvedPluginSource({ kind: "git", url: "https://example.invalid/recovery.git", revision: "a".repeat(40) }, sha256),
  configuration: { options: [] },
  components: { skills: [], hooks: [], mcpServers: [], foreign: [] },
  metadata: [],
});
const compatibility = CompatibilityReportSchema.parse({ plugin: plugin.identity, activatable: true, components: [], requirements: [], diagnostics: [] });
const content = createContentManifest([], sha256);
const state = createInstalledPluginRecord({ plugin: plugin.identity.key, activation: "disabled", revisions: [{ plugin, compatibility, content }], scope: { kind: "user" } }, sha256);
const projection = createInactiveProjectionExpectation({ scope: { kind: "user" }, plugin: plugin.identity.key, sha256 });
const reference = deriveLifecyclePendingTransitionRef({ operationId: "00000000-0000-4000-8000-000000000001", scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0 }, sha256);
const record = createLifecycleTransitionRecord({ operationId: "00000000-0000-4000-8000-000000000001", operation: "disable", origin: "manual", scope: { kind: "user" }, plugin: plugin.identity.key, startingGeneration: 0, previous: state, candidate: state, final: state, previousProjection: projection, candidateProjection: projection, retainedData: "keep", reference, sha256 });

describe("recovery contracts", () => {
  it("keeps journal state evidence pending-free and classifies uncertain observation conservatively", () => {
    const pending = { ...state, pendingTransition: reference };
    expect(stateWithoutPending(pending)).toEqual(state);
    expect(classifyInterruptedTransition({ record, current: pending })).toEqual({ kind: "compensate", projection });
  });

  it("rejects a reference forged for a different operation identity", () => {
    expect(() => createLifecycleTransitionRecord({ ...record, operationId: "00000000-0000-4000-8000-000000000002", sha256 })).toThrow(/reference/);
  });
});
