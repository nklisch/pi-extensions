import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { createLocalMarketplace, extensionContext, fakePi, removePackagedMarketplaceFixture, runMarketplaceOperation } from "../helpers/packaged-marketplace.js";

describe("packaged marketplace discovery restart", () => {
  it("browses the selected immutable snapshot after the source disappears", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-restart-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const repository = await createLocalMarketplace(root);
    const firstContext = extensionContext(project, true, "first");
    const first = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
    try {
      await first.start({ type: "session_start", reason: "startup" } as never, firstContext as never);
      const added = await runMarketplaceOperation(first, firstContext, (marketplace, signal) =>
        marketplace.registration.add({ source: { kind: "local-git", path: repository }, scope: "user", origin: { kind: "native" } }, signal));
      if (added.kind !== "added") throw new Error("fixture registration failed");
      const token = added.registration.selected!.token;
      await first.dispose("quit");
      await rm(repository, { recursive: true, force: true });

      const secondContext = extensionContext(project, true, "second");
      const second = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
      try {
        await second.start({ type: "session_start", reason: "startup" } as never, secondContext as never);
        const page = await runMarketplaceOperation(second, secondContext, (marketplace, signal) =>
          marketplace.catalog.search({ scope: "user", query: "demo", limit: 50 }, signal));
        expect(page.candidates).toHaveLength(1);
        expect(page.candidates[0]!.snapshot).toBe(token);
        expect(page.observations).toMatchObject([{ status: "ready", cache: { kind: "unknown-local" } }]);
      } finally {
        await second.dispose("quit");
      }
    } finally {
      await first.dispose("quit").catch(() => undefined);
      await removePackagedMarketplaceFixture(root);
    }
  }, 30_000);
});
