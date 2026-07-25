import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createExactTrustGrantService } from "../../src/application/exact-trust-grant-service.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createTrustCandidate, grantTrust } from "../../src/domain/trust-policy.js";
import { HostConfigDocumentSchema } from "../../src/domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../../src/domain/state/installed-state.js";
import { StatePointersDocumentSchema } from "../../src/domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../../src/domain/state/trust-state.js";
import { capabilities, directPlugin, sha256 as fixtureSha } from "../fixtures/compatibility/common.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const digest = `sha256:${"0".repeat(64)}` as never;
const blob = `state-blob-v1:sha256:${"1".repeat(64)}` as never;

function candidate() {
  const plugin = directPlugin();
  const content = createContentManifest([], fixtureSha);
  return createTrustCandidate({
    scope: { kind: "user" },
    marketplaceSource: createResolvedMarketplaceSource({ declared: { kind: "github", repository: "owner/market" }, revision: "a".repeat(40) }, fixtureSha),
    plugin,
    compatibility: evaluateCompatibility({ plugin, capabilities: capabilities() }),
    content,
    materializationBinding: createMaterializationBinding(plugin.source.hash, content.rootDigest, fixtureSha),
  }, fixtureSha);
}

function snapshot(records: readonly ReturnType<typeof grantTrust>[] = [], generation = 0) {
  const scope = { kind: "user" as const };
  return {
    scope, generation,
    pointers: StatePointersDocumentSchema.parse({ schemaVersion: 1, scope, generation, documents: ["hostConfig", "installedUser", "trust"].map((kind) => ({ kind, generation, blob, digest })) }),
    config: HostConfigDocumentSchema.parse({ schemaVersion: 4, generation, records: [] }),
    installed: InstalledUserStateDocumentSchema.parse({ schemaVersion: 2, generation, marketplaces: [], plugins: [] }),
    trust: TrustStateDocumentSchema.parse({ schemaVersion: 1, generation, records }),
    corruptions: [],
  } as never;
}

function setup(records: readonly ReturnType<typeof grantTrust>[] = [], outcome: "committed" | "ambiguous" = "committed") {
  const initial = snapshot(records);
  let replacement: unknown;
  const runPreparedMutation = vi.fn(async (_request, prepare) => {
    const prepared = await prepare({ snapshot: initial, assertOwned: async () => undefined });
    replacement = prepared.mutation.replace;
    if (outcome === "ambiguous") return { kind: "commit-ambiguous" as const, value: prepared.value, expected: 0 };
    return { kind: "committed" as const, value: prepared.value, snapshot: snapshot((prepared.mutation.replace as never as { trust: { records: ReturnType<typeof grantTrust>[] } }).trust.records, 1) };
  });
  const service = createExactTrustGrantService({
    state: { read: vi.fn(async () => ({ ok: true as const, snapshot: initial })), commit: vi.fn() },
    mutations: { runPreparedMutation } as never,
    projectTrust: { assess: vi.fn(async () => ({ kind: "trusted" as const })) },
    projectRoots: { acquire: vi.fn(), verify: vi.fn((_, scope) => scope) },
    sha256: fixtureSha,
  });
  return { service, runPreparedMutation, replacement: () => replacement };
}

describe("exact trust grant service", () => {
  it("records the exact candidate on existing user trust authority", async () => {
    const trust = candidate();
    const { service, replacement } = setup();
    const result = await service.grant({ candidate: trust, scope: { kind: "user" } }, new AbortController().signal);
    expect(result).toMatchObject({ kind: "recorded", subject: trust.subject, generation: 1 });
    expect(replacement()).toMatchObject({ trust: { records: [{ subject: trust.subject, status: "granted", evidence: trust.evidence }] } });
  });

  it("is idempotent for the exact already-granted subject", async () => {
    const trust = candidate();
    const { service, runPreparedMutation } = setup([grantTrust(trust, fixtureSha)]);
    await expect(service.grant({ candidate: trust, scope: { kind: "user" } }, new AbortController().signal))
      .resolves.toMatchObject({ kind: "already-recorded", subject: trust.subject, generation: 0 });
    expect(runPreparedMutation).not.toHaveBeenCalled();
  });

  it("reports ambiguous commits as recovery-required", async () => {
    const trust = candidate();
    const { service } = setup([], "ambiguous");
    await expect(service.grant({ candidate: trust, scope: { kind: "user" } }, new AbortController().signal))
      .resolves.toEqual({ kind: "recovery-required", subject: trust.subject });
  });
});
