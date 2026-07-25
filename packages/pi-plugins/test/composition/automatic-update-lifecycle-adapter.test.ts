import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAutomaticUpdateLifecycleAdapter } from "../../src/composition/automatic-update-lifecycle-adapter.js";
import { ContentDigestSchema } from "../../src/domain/content-manifest.js";
import {
  UpdateNoticeSchema,
  deriveMarketplaceSourceIdentity,
  derivePluginSourceIdentity,
} from "../../src/domain/update-policy.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const signal = new AbortController().signal;

describe("automatic update lifecycle adapter", () => {
  it.each([
    ["configured", { configuration: "valid", secrets: "available" }],
    ["unavailable", { configuration: "valid", secrets: "unavailable" }],
  ] as const)("projects candidate configuration custody state %s", async (fieldState, expected) => {
    const marketplaceSource = { kind: "github" as const, repository: "example/community" };
    const pluginSource = { kind: "git" as const, url: "https://example.invalid/demo.git" };
    const marketplaceIdentity = deriveMarketplaceSourceIdentity(marketplaceSource, sha256);
    const pluginIdentity = derivePluginSourceIdentity(pluginSource, sha256);
    const installedRevision = ContentDigestSchema.parse(`sha256:${"a".repeat(64)}`);
    const candidateRevision = ContentDigestSchema.parse(`sha256:${"b".repeat(64)}`);
    const notice = UpdateNoticeSchema.parse({
      id: `update-notice-v1:sha256:${"1".repeat(64)}`, scope: { kind: "user" }, plugin: "demo@community",
      registrationId: `marketplace-registration-v1:sha256:${"2".repeat(64)}`, snapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}`,
      candidateId: `marketplace-candidate-v1:sha256:${"4".repeat(64)}`, candidate: `update-candidate-v1:sha256:${"5".repeat(64)}`,
      available: { immutableRevision: candidateRevision, marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity, sourceRevision: "b".repeat(40) },
      display: { installed: "1.0.0", available: "1.1.0" }, disposition: "automatic-pending", publication: "pending", unread: true, discoveredAt: 1,
    });
    const capture = vi.fn(async () => ({ binding: { currentProject: { projectKey: `project-v1:sha256:${"8".repeat(64)}`, trust: { kind: "trusted" }, epoch: `sha256:${"7".repeat(64)}` } } } as never));
    let detailCalls = 0;
    const detail = vi.fn(async () => {
      detailCalls += 1;
      if (detailCalls === 1) return { kind: "stale" as const };
      return { kind: "found" as const, detail: { summary: { revision: { immutable: candidateRevision } }, configuration: [{ required: true, sensitive: true, state: fieldState }], compatibility: { status: "activatable", requirements: [] } } } as never;
    });
    const adapter = createAutomaticUpdateLifecycleAdapter({
      state: { async read() { return { ok: true as const, snapshot: { scope: { kind: "user" }, generation: 0, installed: { plugins: [{ plugin: notice.plugin, selectedRevision: installedRevision, activation: "enabled", revisions: [{ revision: installedRevision, configurationRef: `plugin-configuration-v1:sha256:${"9".repeat(64)}`, evidence: { source: { marketplaceSourceIdentity: marketplaceIdentity, pluginSourceIdentity: pluginIdentity } } }] }] } } as never }; } },
      catalog: { async resolve() { return { kind: "resolved" as const, candidate: { marketplace: { source: { declared: marketplaceSource } }, entry: { source: { value: pluginSource } } } as never }; } },
      evidence: { capture } as never,
      inspection: { detail } as never,
      lifecycle: { update: vi.fn() } as never, projectTrust: {} as never, projectRoots: {} as never,
      userBaseDirectory: "/virtual", sha256,
    });
    await expect(adapter.inspect(notice, signal)).resolves.toMatchObject(expected);
    expect(capture).toHaveBeenCalledTimes(2);
    expect(detail).toHaveBeenCalledTimes(2);
  });

  it("rejects installed source drift before entering lifecycle", async () => {
    const marketplaceSource = { kind: "github" as const, repository: "example/community" };
    const pluginSource = { kind: "git" as const, url: "https://example.invalid/demo.git" };
    const marketplaceIdentity = deriveMarketplaceSourceIdentity(marketplaceSource, sha256);
    const pluginIdentity = derivePluginSourceIdentity(pluginSource, sha256);
    const revision = ContentDigestSchema.parse(`sha256:${"a".repeat(64)}`);
    const notice = UpdateNoticeSchema.parse({
      id: `update-notice-v1:sha256:${"1".repeat(64)}`,
      scope: { kind: "user" },
      plugin: "demo@community",
      registrationId: `marketplace-registration-v1:sha256:${"2".repeat(64)}`,
      snapshot: `marketplace-snapshot-v1:sha256:${"3".repeat(64)}`,
      candidateId: `marketplace-candidate-v1:sha256:${"4".repeat(64)}`,
      candidate: `update-candidate-v1:sha256:${"5".repeat(64)}`,
      available: {
        immutableRevision: revision,
        marketplaceSourceIdentity: marketplaceIdentity,
        pluginSourceIdentity: pluginIdentity,
        sourceRevision: "a".repeat(40),
      },
      display: { installed: "1.0.0", available: "1.1.0" },
      disposition: "automatic-pending",
      publication: "pending",
      unread: true,
      discoveredAt: 1,
    });
    const lifecycleUpdate = vi.fn();
    const adapter = createAutomaticUpdateLifecycleAdapter({
      state: { async read() {
        return {
          ok: true as const,
          snapshot: {
            scope: { kind: "user" },
            generation: 0,
            installed: { plugins: [{
              plugin: notice.plugin,
              selectedRevision: revision,
              activation: "enabled",
              revisions: [{
                revision,
                evidence: { source: {
                  marketplaceSourceIdentity: marketplaceIdentity,
                  pluginSourceIdentity: `sha256:${"f".repeat(64)}`,
                } },
              }],
            }] },
          } as never,
        };
      }, async commit() { throw new Error("must not commit"); } },
      catalog: { async resolve() {
        return {
          kind: "resolved" as const,
          candidate: {
            marketplace: { source: { declared: marketplaceSource } },
            entry: { source: { value: pluginSource } },
          } as never,
        };
      } },
      inspection: {} as never,
      evidence: {} as never,
      lifecycle: { update: lifecycleUpdate } as never,
      projectTrust: {} as never,
      projectRoots: {} as never,
      userBaseDirectory: "/virtual",
      sha256,
    });

    await expect(adapter.apply(notice, signal)).resolves.toEqual({ kind: "rejected", code: "UNTRUSTED" });
    expect(lifecycleUpdate).not.toHaveBeenCalled();
  });
});
