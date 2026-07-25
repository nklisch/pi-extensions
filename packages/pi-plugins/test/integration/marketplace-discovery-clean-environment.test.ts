import { mkdtemp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { createLocalMarketplace, extensionContext, fakePi, removePackagedMarketplaceFixture, runMarketplaceOperation } from "../helpers/packaged-marketplace.js";

describe("packaged marketplace discovery in a clean environment", () => {
  it("adds, lists, searches, and details a local marketplace without foreign CLIs", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-clean-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const repository = await createLocalMarketplace(root);
    const fake = fakePi();
    const context = extensionContext(project);
    const host = createPackagedPluginHost({ pi: fake.api as never, agentDir });
    try {
      const started = await host.start({ type: "session_start", reason: "startup" } as never, context as never);
      expect(Object.keys(started.application)).toEqual(["control"]);
      const added = await runMarketplaceOperation(host, context, (marketplace, signal) =>
        marketplace.registration.add({ source: { kind: "local-git", path: repository }, scope: "user", origin: { kind: "native" } }, signal));
      if (added.kind !== "added") throw new Error(`fixture registration failed: ${JSON.stringify(added)}`);
      expect(added).toMatchObject({ kind: "added", registration: { marketplace: "community", cache: { kind: "unknown-local" }, selected: { revision: expect.stringMatching(/^[0-9a-f]{40}$/) } } });
      const listed = await runMarketplaceOperation(host, context, (marketplace, signal) =>
        marketplace.registration.list({ scope: "all-current", limit: 50 }, signal));
      expect(listed.registrations).toHaveLength(1);
      const page = await runMarketplaceOperation(host, context, (marketplace, signal) =>
        marketplace.catalog.search({ scope: "all-current", query: "offline demo", limit: 50 }, signal));
      expect(page.candidates).toHaveLength(2);
      expect(page.candidates).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "demo", marketplace: "community", scope: expect.objectContaining({ kind: "user" }), trust: "untrusted-not-inspected" }),
        expect.objectContaining({ name: "demo", marketplace: "community", scope: expect.objectContaining({ kind: "project" }), trust: "untrusted-not-inspected" }),
      ]));
      const candidate = page.candidates[0]!;
      await expect(runMarketplaceOperation(host, context, (marketplace, signal) =>
        marketplace.catalog.detail({ candidateId: candidate.id, snapshot: candidate.snapshot }, signal)))
        .resolves.toMatchObject({ kind: "found", candidate: { id: candidate.id, marketplaceRevision: added.kind === "added" ? added.registration.selected?.revision : undefined } });
      expect(started.application).not.toHaveProperty("marketplace");
    } finally {
      await host.dispose("quit");
      await removePackagedMarketplaceFixture(root);
    }
  }, 30_000);
});
