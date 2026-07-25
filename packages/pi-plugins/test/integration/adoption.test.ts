import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeAdoptionService } from "../../src/composition/create-adoption-service.js";
import { deriveProjectKey } from "../../src/domain/state/scope.js";
import type { MarketplaceRegistrationPort } from "../../src/application/ports/marketplace-registration.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());

async function setup(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-adoption-integration-"));
  await mkdir(join(root, ".claude", "plugins"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  return root;
}

async function clean(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

const known = (source: unknown, alias = "catalog") => JSON.stringify({ [alias]: { source } });

describe("read-only adoption integration", () => {
  it("runs without either CLI and merges equivalent Claude/Codex declarations", async () => {
    const root = await setup();
    const calls: unknown[] = [];
    const registrations: MarketplaceRegistrationPort = {
      async register(request) {
        calls.push(request);
        return { kind: "registered", marketplace: "catalog" };
      },
    };
    try {
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), known({ source: "git", url: "https://example.com/catalog.git", ref: "main" }), "utf8");
      await writeFile(join(root, ".claude", "settings.json"), JSON.stringify({ extraKnownMarketplaces: { settingsCatalog: { source: { source: "git", url: "https://example.com/catalog.git", ref: "main" } } } }), "utf8");
      await writeFile(join(root, ".codex", "config.toml"), [
        "[marketplaces.codexCatalog]",
        'source_type = "git"',
        'source = "https://example.com/catalog.git"',
        'ref = "main"',
      ].join("\n"), "utf8");
      await mkdir(join(root, ".claude", "plugins", "cache"), { recursive: true });
      await writeFile(join(root, ".claude", "plugins", "cache", "sentinel"), "must not be read", "utf8");
      await writeFile(join(root, ".codex", "auth.json"), "must not be read", "utf8");

      const service = createNodeAdoptionService({ userHome: root, registrations });
      const discovered = await service.discover(new AbortController().signal);
      expect(discovered.candidates).toHaveLength(1);
      expect(discovered.candidates[0]!.nativeHosts).toEqual(["claude", "codex"]);
      expect(calls).toEqual([]);
      const candidate = discovered.candidates[0]!;
      const result = await service.adopt({ candidateIds: [candidate.id] }, new AbortController().signal);
      expect(result.outcomes).toEqual([{ candidateId: candidate.id, outcome: { kind: "registered", marketplace: "catalog" } }]);
      expect(calls).toEqual([{
        source: { kind: "git", url: "https://example.com/catalog.git", ref: "main" },
        scope: { kind: "user" },
        origin: "adoption",
      }]);
    } finally {
      await clean(root);
    }
  });

  it("previews and imports through the native registry without mutating foreign state", async () => {
    const root = await setup();
    const registrations: MarketplaceRegistrationPort = { register: async () => ({ kind: "rejected", code: "ADAPTER_FAILED" }) };
    const adds: unknown[] = [];
    try {
      const path = join(root, ".claude", "plugins", "known_marketplaces.json");
      const source = known({ source: "github", repo: "owner/catalog" });
      await writeFile(path, source, "utf8");
      const service = createNodeAdoptionService({
        userHome: root,
        registrations,
        registry: {
          list: async () => ({ registrations: [] }),
          add: async (request) => {
            adds.push(request);
            return { kind: "rejected", code: "SOURCE_UNAVAILABLE" };
          },
        },
      });
      const preview = await service.preview({ compareScope: "all-current" }, new AbortController().signal);
      expect(preview.candidates).toMatchObject([{ comparison: { kind: "not-registered" } }]);
      expect(adds).toEqual([]);
      const candidate = preview.candidates[0]!.candidate;
      const imported = await service.import({ candidateIds: [candidate.id], scope: "user" }, new AbortController().signal);
      expect(imported.outcomes).toEqual([{ candidateId: candidate.id, outcome: { kind: "rejected", code: "SOURCE_UNAVAILABLE" } }]);
      expect(adds).toEqual([expect.objectContaining({ origin: expect.objectContaining({ kind: "adoption", candidateId: candidate.id }) })]);
      expect(await readFile(path, "utf8")).toBe(source);
    } finally {
      await clean(root);
    }
  });

  it("rejects stale selections and local project sources before normal registration", async () => {
    const root = await setup();
    const register = async () => ({ kind: "registered" as const, marketplace: "catalog" as const });
    const registrations = { register };
    try {
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), known({ source: "git", url: "https://example.com/old.git" }), "utf8");
      const service = createNodeAdoptionService({ userHome: root, registrations });
      const oldCandidate = (await service.discover(new AbortController().signal)).candidates[0]!;
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), known({ source: "git", url: "https://example.com/new.git" }), "utf8");
      const stale = await service.adopt({ candidateIds: [oldCandidate.id] }, new AbortController().signal);
      expect(stale.outcomes).toEqual([{ candidateId: oldCandidate.id, outcome: { kind: "candidate-unavailable" } }]);

      const localCalls: unknown[] = [];
      const localService = createNodeAdoptionService({
        userHome: root,
        registrations: { register: async (request) => { localCalls.push(request); return { kind: "registered", marketplace: "catalog" }; } },
      });
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), known({ source: "directory", path: "/home/user/catalog" }), "utf8");
      const localCandidate = (await localService.discover(new AbortController().signal)).candidates[0]!;
      const identity = { kind: "path-only" as const, canonicalRoot: "file:///tmp/project/", limitation: "identity-changes-with-canonical-root" as const };
      const scope = { kind: "project" as const, identity, projectKey: deriveProjectKey(identity, sha256) };
      const result = await localService.adopt({ candidateIds: [localCandidate.id], scope }, new AbortController().signal);
      expect(result.outcomes).toEqual([{ candidateId: localCandidate.id, outcome: { kind: "not-portable" } }]);
      expect(localCalls).toEqual([]);
    } finally {
      await clean(root);
    }
  });
});
