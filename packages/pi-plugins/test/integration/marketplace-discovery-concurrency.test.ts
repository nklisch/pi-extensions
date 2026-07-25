import { spawn } from "node:child_process";
import { mkdtemp, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPackagedPluginHost } from "../../src/composition/create-packaged-plugin-host.js";
import { createLocalMarketplace, extensionContext, fakePi, removePackagedMarketplaceFixture, runMarketplaceOperation } from "../helpers/packaged-marketplace.js";

const childFixture = resolve(process.cwd(), "test/fixtures/marketplace/child-packaged-marketplace.mjs");
const sourceLoader = resolve(process.cwd(), "test/fixtures/locking/source-loader.mjs");

function child(agentDir: string, project: string, repository: string, mode: "add" | "refresh" | "remove" | "list", registrationId = ""): Promise<any> {
  return new Promise((resolvePromise, rejectPromise) => {
    const handle = spawn(process.execPath, [
      "--experimental-strip-types",
      "--experimental-transform-types",
      "--loader",
      sourceLoader,
      childFixture,
      agentDir,
      project,
      repository,
      mode,
      registrationId,
    ], { cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: "", VITEST: undefined }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    handle.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    handle.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    handle.once("close", (code) => {
      if (code !== 0) rejectPromise(new Error(`marketplace child failed: ${stderr}`));
      else resolvePromise(JSON.parse(stdout.trim()));
    });
  });
}

describe("packaged marketplace discovery concurrency", () => {
  it("coalesces duplicate adds and keeps refresh/remove publication atomic", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-concurrency-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const repository = await createLocalMarketplace(root);
    const context = extensionContext(project);
    const host = createPackagedPluginHost({ pi: fakePi().api as never, agentDir });
    try {
      await host.start({ type: "session_start", reason: "startup" } as never, context as never);
      const request = { source: { kind: "local-git" as const, path: repository }, scope: "user" as const, origin: { kind: "native" as const } };
      const added = await Promise.all([
        runMarketplaceOperation(host, context, (marketplace, signal) => marketplace.registration.add(request, signal)),
        runMarketplaceOperation(host, context, (marketplace, signal) => marketplace.registration.add(request, signal)),
      ]);
      expect(added.map((result) => result.kind).sort()).toEqual(["added", "unchanged"]);
      const registration = added.find((result) => result.kind === "added" || result.kind === "unchanged")!;
      if (registration.kind !== "added" && registration.kind !== "unchanged") throw new Error("registration unavailable");

      const [refresh, removal] = await Promise.all([
        runMarketplaceOperation(host, context, (marketplace, signal) => marketplace.refresh.refresh({ trigger: "explicit", scope: "user", registrationIds: [registration.registration.id] }, signal)),
        runMarketplaceOperation(host, context, (marketplace, signal) => marketplace.registration.remove({ scope: "user", registrationId: registration.registration.id }, signal)),
      ]);
      expect(removal).toMatchObject({ kind: "removed" });
      expect(refresh.outcomes[0]?.kind).toMatch(/refreshed|failed|not-configured/);
      if (refresh.outcomes[0]?.kind === "failed") expect(refresh.outcomes[0].code).toBe("REMOVED_DURING_REFRESH");
      const listed = await runMarketplaceOperation(host, context, (marketplace, signal) =>
        marketplace.registration.list({ scope: "user", limit: 50 }, signal));
      expect(listed.registrations).toEqual([]);
    } finally {
      await host.dispose("quit");
      await removePackagedMarketplaceFixture(root);
    }
  }, 30_000);

  it("selects exact winners across two add processes and a refresh/remove race", async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-marketplace-process-concurrency-"));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await Promise.all([mkdir(agentDir), mkdir(project)]);
    const repository = await createLocalMarketplace(root);
    try {
      const additions = await Promise.all([
        child(agentDir, project, repository, "add"),
        child(agentDir, project, repository, "add"),
      ]);
      expect(additions.map((result) => result.kind).sort()).toEqual(["added", "unchanged"]);
      const winner = additions.find((result) => result.kind === "added") ?? additions[0];
      const registrationId = winner.registration.id as string;

      const [refresh, removal] = await Promise.all([
        child(agentDir, project, repository, "refresh", registrationId),
        child(agentDir, project, repository, "remove", registrationId),
      ]);
      expect(removal).toMatchObject({ kind: "removed", registrationId });
      expect(refresh.outcomes[0]?.kind).toMatch(/refreshed|failed|not-configured/);
      if (refresh.outcomes[0]?.kind === "failed") expect(["REMOVED_DURING_REFRESH", "STATE_STALE"]).toContain(refresh.outcomes[0].code);
      await expect(child(agentDir, project, repository, "list")).resolves.toEqual({ registrations: [] });
    } finally {
      await removePackagedMarketplaceFixture(root);
    }
  }, 60_000);
});
