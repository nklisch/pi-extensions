import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  AdoptionDocumentKindRegistry,
  type AdoptionCandidateId,
} from "../../src/domain/adoption.js";
import {
  deriveProjectKey,
  ProjectIdentitySchema,
  type ScopeContext,
} from "../../src/domain/state/scope.js";
import type { Sha256, MarketplaceSource } from "../../src/domain/source.js";
import { MarketplaceNameSchema } from "../../src/domain/identity.js";
import {
  type AdoptionReaderRegistry,
  type ForeignStateFileObservation,
  type MarketplaceRegistrationResult,
} from "../../src/application/adoption-contract.js";
import { createAdoptionService } from "../../src/application/adoption-service.js";
import { MarketplaceAddResultSchema } from "../../src/application/marketplace-management-contract.js";
import type { ForeignStateFilesPort } from "../../src/application/ports/foreign-state-files.js";
import type { MarketplaceRegistrationPort } from "../../src/application/ports/marketplace-registration.js";
import { readClaudeKnownMarketplacesJson } from "../../src/formats/claude/state-reader.js";
import { readClaudeUserSettingsJson } from "../../src/formats/claude/state-reader.js";
import { readCodexUserConfigToml } from "../../src/formats/codex/state-reader.js";

const sha256: Sha256 = (bytes) => new Uint8Array(createHash("sha256").update(bytes).digest());
const readers: AdoptionReaderRegistry = {
  "claude-known-marketplaces": readClaudeKnownMarketplacesJson,
  "claude-user-settings": readClaudeUserSettingsJson,
  "codex-user-config": readCodexUserConfigToml,
};

function observations(sourceByDocument: Partial<Record<keyof typeof AdoptionDocumentKindRegistry extends never ? never : string, string>> = {}): ForeignStateFileObservation[] {
  return [
    sourceByDocument["claude-known-marketplaces"] === undefined
      ? { kind: "missing", document: "claude-known-marketplaces", host: "claude", path: "/home/.claude/plugins/known_marketplaces.json" }
      : { kind: "present", document: "claude-known-marketplaces", host: "claude", path: "/home/.claude/plugins/known_marketplaces.json", source: sourceByDocument["claude-known-marketplaces"] },
    sourceByDocument["claude-user-settings"] === undefined
      ? { kind: "missing", document: "claude-user-settings", host: "claude", path: "/home/.claude/settings.json" }
      : { kind: "present", document: "claude-user-settings", host: "claude", path: "/home/.claude/settings.json", source: sourceByDocument["claude-user-settings"] },
    sourceByDocument["codex-user-config"] === undefined
      ? { kind: "missing", document: "codex-user-config", host: "codex", path: "/home/.codex/config.toml" }
      : { kind: "present", document: "codex-user-config", host: "codex", path: "/home/.codex/config.toml", source: sourceByDocument["codex-user-config"] },
  ];
}

function serviceWith(
  fileObservations: ForeignStateFileObservation[] | (() => ForeignStateFileObservation[]),
  register: MarketplaceRegistrationPort["register"] = async () => ({ kind: "registered", marketplace: MarketplaceNameSchema.parse("catalog") }),
) {
  const files: ForeignStateFilesPort = { readAll: async () => typeof fileObservations === "function" ? fileObservations() : fileObservations };
  return createAdoptionService({ files, readers, registrations: { register }, sha256 });
}

const githubDocument = JSON.stringify({ catalog: { source: { source: "github", repo: "owner/catalog" } } });
const localDocument = JSON.stringify({ local: { source: { source: "directory", path: "/home/user/catalog" } } });

describe("adoption service", () => {
  it("returns fixed missing statuses without requiring either foreign CLI", async () => {
    const service = serviceWith(observations());
    const result = await service.discover(new AbortController().signal);
    expect(result.candidates).toEqual([]);
    expect(result.documents.map((document) => document.kind)).toEqual(["missing", "missing", "missing"]);
    expect(result.documents.map((document) => document.document)).toEqual([
      "claude-known-marketplaces",
      "claude-user-settings",
      "codex-user-config",
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("keeps valid candidates when another document is unreadable", async () => {
    const service = serviceWith([
      { kind: "present", document: "claude-known-marketplaces", host: "claude", path: "/home/.claude/plugins/known_marketplaces.json", source: githubDocument },
      { kind: "unreadable", document: "claude-user-settings", host: "claude", path: "/home/.claude/settings.json", code: "INVALID_UTF8" },
      { kind: "missing", document: "codex-user-config", host: "codex", path: "/home/.codex/config.toml" },
    ]);
    const result = await service.discover(new AbortController().signal);
    expect(result.candidates).toHaveLength(1);
    expect(result.diagnostics).toMatchObject([{ code: "ADAPTER_FAILED", details: { reason: "INVALID_UTF8" } }]);
  });

  it("re-discovers before selection so a removed candidate cannot register", async () => {
    let current = observations({ "claude-known-marketplaces": githubDocument });
    const service = serviceWith(() => current);
    const presented = await service.discover(new AbortController().signal);
    const id = presented.candidates[0]!.id;
    current = observations();
    const registrar = vi.fn<MarketplaceRegistrationPort["register"]>();
    const importing = createAdoptionService({ files: { readAll: async () => current }, readers, registrations: { register: registrar }, sha256 });
    const result = await importing.adopt({ candidateIds: [id] }, new AbortController().signal);
    expect(result.outcomes).toEqual([{ candidateId: id, outcome: { kind: "candidate-unavailable" } }]);
    expect(registrar).not.toHaveBeenCalled();
  });

  it("passes only source, scope, and adoption origin to the normal registrar", async () => {
    const calls: unknown[] = [];
    const register: MarketplaceRegistrationPort["register"] = async (request) => {
      calls.push(request);
      return { kind: "registered", marketplace: MarketplaceNameSchema.parse("catalog") };
    };
    const service = serviceWith(observations({ "claude-known-marketplaces": githubDocument }), register);
    const discovered = await service.discover(new AbortController().signal);
    const result = await service.adopt({ candidateIds: [discovered.candidates[0]!.id] }, new AbortController().signal);
    expect(result.outcomes[0]!.outcome).toEqual({ kind: "registered", marketplace: "catalog" });
    expect(calls).toEqual([{
      source: { kind: "github", repository: "owner/catalog" },
      scope: { kind: "user" },
      origin: "adoption",
    }]);
    expect(JSON.stringify(calls)).not.toMatch(/alias|trust|credential|cache|install|enable|activation|revision/i);
  });

  it("blocks local sources before project registration while allowing remote sources", async () => {
    const identity = ProjectIdentitySchema.parse({
      kind: "path-only",
      canonicalRoot: "file:///tmp/project/",
      limitation: "identity-changes-with-canonical-root",
    });
    const scope: ScopeContext = {
      kind: "project",
      identity,
      projectKey: deriveProjectKey(identity, sha256),
    };
    const register = vi.fn<MarketplaceRegistrationPort["register"]>(async () => ({ kind: "registered", marketplace: MarketplaceNameSchema.parse("catalog") }));
    const localService = serviceWith(observations({ "claude-known-marketplaces": localDocument }), register);
    const localCandidate = (await localService.discover(new AbortController().signal)).candidates[0]!;
    const localResult = await localService.adopt({ candidateIds: [localCandidate.id], scope }, new AbortController().signal);
    expect(localResult.outcomes[0]!.outcome).toEqual({ kind: "not-portable" });
    expect(register).not.toHaveBeenCalled();

    const remoteService = serviceWith(observations({ "claude-known-marketplaces": githubDocument }), register);
    const remoteCandidate = (await remoteService.discover(new AbortController().signal)).candidates[0]!;
    await remoteService.adopt({ candidateIds: [remoteCandidate.id], scope }, new AbortController().signal);
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]![0].scope).toEqual(scope);
  });

  it("sorts partial outcomes and rethrows cancellation", async () => {
    const first = JSON.stringify({ zeta: { source: { source: "github", repo: "owner/zeta" } }, alpha: { source: { source: "github", repo: "owner/alpha" } } });
    const calls: MarketplaceSource[] = [];
    const controller = new AbortController();
    const register: MarketplaceRegistrationPort["register"] = async ({ source }) => {
      calls.push(source);
      controller.abort();
      return { kind: "registered", marketplace: MarketplaceNameSchema.parse("catalog") };
    };
    const service = serviceWith(observations({ "claude-known-marketplaces": first }), register);
    const candidates = (await service.discover(new AbortController().signal)).candidates;
    await expect(service.adopt({ candidateIds: candidates.map((candidate) => candidate.id) as [AdoptionCandidateId, ...AdoptionCandidateId[]] }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toHaveLength(1);
  });

  it("preserves typed registrar rejections and handles malformed adapter results safely", async () => {
    const registrar: MarketplaceRegistrationPort["register"] = async () => ({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
    const service = serviceWith(observations({ "claude-known-marketplaces": githubDocument }), registrar);
    const candidate = (await service.discover(new AbortController().signal)).candidates[0]!;
    const result = await service.adopt({ candidateIds: [candidate.id] }, new AbortController().signal);
    expect(result.outcomes[0]!.outcome).toEqual({ kind: "rejected", code: "PROJECT_UNTRUSTED" });
  });

  it("keeps a committed add and cancels only remaining import candidates", async () => {
    const document = JSON.stringify({
      alpha: { source: { source: "github", repo: "owner/alpha" } },
      zeta: { source: { source: "github", repo: "owner/zeta" } },
    });
    const controller = new AbortController();
    const added = MarketplaceAddResultSchema.parse({
      kind: "added",
      registration: {
        id: `marketplace-registration-v1:sha256:${"a".repeat(64)}`,
        scope: { kind: "user" },
        marketplace: "catalog",
        source: { kind: "github", repository: "owner/catalog" },
        sourceIdentity: `sha256:${"b".repeat(64)}`,
        origin: { kind: "native" },
        updateApplication: "manual",
        refresh: { consecutiveFailures: 0 },
        cache: { kind: "not-materialized" },
      },
    });
    const service = createAdoptionService({
      files: { readAll: async () => observations({ "claude-known-marketplaces": document }) },
      readers,
      registrations: { register: async () => ({ kind: "rejected", code: "ADAPTER_FAILED" }) },
      registry: {
        async add() {
          controller.abort(new Error("cancel after commit"));
          return added;
        },
        async list() { return { registrations: [] }; },
      },
      sha256,
    });
    const candidates = (await service.preview({ compareScope: "user" }, new AbortController().signal)).candidates
      .map((entry) => entry.candidate.id)
      .sort();
    const result = await service.import({ candidateIds: candidates, scope: "user" }, controller.signal);
    expect(result.outcomes).toEqual([
      { candidateId: candidates[0], outcome: added },
      { candidateId: candidates[1], outcome: { kind: "cancelled-before-start" } },
    ]);
  });

  it("previews without native writes and imports through normal registration with provenance", async () => {
    const readAll = vi.fn(async () => observations({ "claude-known-marketplaces": githubDocument }));
    const add = vi.fn(async () => ({
      kind: "rejected" as const,
      code: "SOURCE_UNAVAILABLE" as const,
    }));
    const service = createAdoptionService({
      files: { readAll },
      readers,
      registrations: { register: async () => ({ kind: "rejected", code: "ADAPTER_FAILED" }) },
      registry: {
        add,
        list: async () => ({ registrations: [] }),
      },
      sha256,
    });
    const preview = await service.preview({ compareScope: "all-current" }, new AbortController().signal);
    expect(preview.candidates[0]!.comparison).toEqual({ kind: "not-registered" });
    expect(add).not.toHaveBeenCalled();
    expect(readAll).toHaveBeenCalledTimes(1);

    const result = await service.import({ candidateIds: [preview.candidates[0]!.candidate.id], scope: "user" }, new AbortController().signal);
    expect(result.outcomes[0]!.outcome).toEqual({ kind: "rejected", code: "SOURCE_UNAVAILABLE" });
    expect(readAll).toHaveBeenCalledTimes(2);
    expect(add).toHaveBeenCalledWith(expect.objectContaining({
      scope: "user",
      origin: expect.objectContaining({
        kind: "adoption",
        candidateId: preview.candidates[0]!.candidate.id,
        documents: [expect.objectContaining({ host: "claude", document: "claude-known-marketplaces" })],
      }),
    }), expect.any(AbortSignal));
  });
});
