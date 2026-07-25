import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { authorizeTrustCandidate } from "../../src/application/trust-service.js";
import { grantTrust } from "../../src/domain/trust-policy.js";
import { createTrustCandidate } from "../../src/domain/trust-policy.js";
import { createResolvedMarketplaceSource } from "../../src/domain/source.js";
import { createContentManifest } from "../../src/domain/content-manifest.js";
import { createCompatibilityReport } from "../../src/domain/compatibility.js";
import { directPlugin } from "../fixtures/compatibility/common.js";

const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function candidate(scope: { kind: "user" } | { kind: "project"; projectKey: string }) {
  const plugin = directPlugin();
  return createTrustCandidate({
    scope,
    marketplaceSource: createResolvedMarketplaceSource({
      declared: { kind: "github", repository: "example/marketplace" },
      revision: "b".repeat(40),
    }, sha256),
    plugin,
    compatibility: createCompatibilityReport({
      plugin: plugin.identity,
      activatable: true,
      components: [],
      requirements: [],
      diagnostics: [],
    }),
    content: createContentManifest([], sha256),
  }, sha256);
}

describe("trust authorization service", () => {
  it("gates project scope before exact plugin trust and skips the port for users", async () => {
    const user = candidate({ kind: "user" });
    const project = candidate({ kind: "project", projectKey: `project-v1:sha256:${"1".repeat(64)}` });
    const assess = vi.fn(async () => ({ kind: "untrusted" as const }));
    const projectTrust = { assess };
    expect(await authorizeTrustCandidate({ candidate: user, records: [grantTrust(user, sha256)] }, { projectTrust, sha256 }, new AbortController().signal))
      .toEqual({ kind: "authorized", subject: user.subject });
    expect(assess).not.toHaveBeenCalled();
    expect(await authorizeTrustCandidate({ candidate: project, records: [grantTrust(project, sha256)] }, { projectTrust, sha256 }, new AbortController().signal))
      .toEqual({ kind: "denied", code: "PROJECT_UNTRUSTED" });
    expect(assess).toHaveBeenCalledWith(project.evidence.scope.kind === "project" ? project.evidence.scope.projectKey : "", expect.any(AbortSignal));
  });

  it("returns stable safe codes and preserves abort/adapter failure", async () => {
    const current = candidate({ kind: "user" });
    const project = candidate({ kind: "project", projectKey: `project-v1:sha256:${"2".repeat(64)}` });
    const projectTrust = { assess: vi.fn(async () => ({ kind: "trusted" as const })) };
    expect(await authorizeTrustCandidate({ candidate: current, records: [] }, { projectTrust, sha256 }, new AbortController().signal))
      .toEqual({ kind: "denied", code: "TRUST_ABSENT" });

    const error = await authorizeTrustCandidate({ candidate: project, records: [grantTrust(project, sha256)] }, {
      projectTrust: { assess: async () => { throw new Error("CANARY_SECRET"); } },
      sha256,
    }, new AbortController().signal).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "ADAPTER_FAILED" });
    expect(JSON.stringify(error)).not.toContain("CANARY_SECRET");

    const abort = Object.assign(new Error("adapter cancelled"), { code: "ABORT_ERR" });
    await expect(authorizeTrustCandidate({ candidate: project, records: [grantTrust(project, sha256)] }, {
      projectTrust: { assess: async () => { throw abort; } },
      sha256,
    }, new AbortController().signal)).rejects.toBe(abort);

    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(authorizeTrustCandidate({ candidate: current, records: [] }, { projectTrust, sha256 }, controller.signal))
      .rejects.toMatchObject({ message: "cancelled" });
  });
});
