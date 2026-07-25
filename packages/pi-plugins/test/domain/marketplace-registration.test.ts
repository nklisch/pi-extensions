import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  deriveMarketplaceCandidateId,
  deriveMarketplaceRegistrationId,
  deriveMarketplaceSnapshotToken,
} from "../../src/domain/marketplace-registration.js";
import { createContentManifest, createMaterializationBinding } from "../../src/domain/content-manifest.js";
import { createMarketplaceSnapshotRecord } from "../../src/domain/state/installed-state.js";
import { createResolvedMarketplaceSource, type Sha256 } from "../../src/domain/source.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());

function snapshot(revision: string) {
  const source = createResolvedMarketplaceSource({
    declared: { kind: "github", repository: "owner/catalog" },
    revision,
  }, sha256);
  const content = createContentManifest([], sha256);
  return createMarketplaceSnapshotRecord({
    marketplace: "catalog",
    source,
    content,
    binding: createMaterializationBinding(source.hash, content.rootDigest, sha256),
  }, sha256);
}

describe("marketplace registration identities", () => {
  it("binds registration, snapshot, and candidate IDs to exact scope/source/revision/entry evidence", () => {
    const user = { kind: "user" as const };
    const identity = { kind: "path-only" as const, canonicalRoot: "file:///project/", limitation: "identity-changes-with-canonical-root" as const };
    const project = { kind: "project" as const, projectKey: deriveProjectKey(identity, sha256) };
    const source = { kind: "github" as const, repository: "owner/catalog" };
    const userId = deriveMarketplaceRegistrationId({ scope: user, source }, sha256);
    const projectId = deriveMarketplaceRegistrationId({ scope: project, source }, sha256);
    expect(userId).not.toBe(projectId);
    expect(userId).not.toBe(deriveMarketplaceRegistrationId({ scope: user, source: { kind: "github", repository: "owner/other" } }, sha256));

    const first = deriveMarketplaceSnapshotToken({ scope: user, registrationId: userId, snapshot: snapshot("a".repeat(40)) }, sha256);
    const second = deriveMarketplaceSnapshotToken({ scope: user, registrationId: userId, snapshot: snapshot("b".repeat(40)) }, sha256);
    expect(first).not.toBe(second);
    expect(deriveMarketplaceCandidateId({ snapshot: first, plugin: "one@catalog", source: { kind: "marketplace-path", path: "one" } }, sha256))
      .not.toBe(deriveMarketplaceCandidateId({ snapshot: first, plugin: "two@catalog", source: { kind: "marketplace-path", path: "two" } }, sha256));
  });
});
