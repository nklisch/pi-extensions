import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { createArtifactGc } from "../../../src/infrastructure/convergence/artifact-gc.js";

const roots: string[] = [];
const oldAge = 8 * 86_400_000;
const recentAge = 6 * 86_400_000;
const digest = (value: string) => value.repeat(64 / value.length);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "artifact-gc-"));
  roots.push(root);
  return root;
}
async function directory(path: string, ageMs?: number, now = Date.now()) {
  await mkdir(path, { recursive: true });
  if (ageMs !== undefined) await utimes(path, new Date(now - ageMs), new Date(now - ageMs));
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("artifact GC contract", () => {
  it("removes old orphans, retains recent orphans, and retains referenced artifacts on both sides of grace", async () => {
    const root = await fixture();
    const now = Date.now();
    const oldOrphan = join(root, "stores", "v1", "plugins", digest("a"));
    const recentOrphan = join(root, "stores", "v1", "plugins", digest("b"));
    const oldReferenced = join(root, "stores", "v1", "plugins", digest("c"));
    await directory(oldOrphan, oldAge, now);
    await directory(recentOrphan, recentAge, now);
    await directory(oldReferenced, oldAge, now);

    const gc = createArtifactGc({ hostRoot: root, maxItems: 100, budgetMs: 10_000 });
    const report = await gc.sweep({ referenced: new Set([`revision:${digest("c")}`]), signal: new AbortController().signal, now });

    await expect(stat(oldOrphan)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(recentOrphan)).resolves.toBeTruthy();
    await expect(stat(oldReferenced)).resolves.toBeTruthy();
    expect(report.removed).toBe(1);
  });

  it("retains the affected category when its evidence root cannot be read", async () => {
    const root = await fixture();
    const now = Date.now();
    const oldRevision = join(root, "stores", "v1", "plugins", digest("a"));
    await directory(oldRevision, oldAge, now);
    await mkdir(join(root, "stores", "v1"), { recursive: true });
    await writeFile(join(root, "stores", "v1", "marketplaces"), "not a directory");

    const gc = createArtifactGc({ hostRoot: root, maxItems: 100, budgetMs: 10_000 });
    const report = await gc.sweep({ referenced: new Set(), signal: new AbortController().signal, now });

    expect(report.incompleteEvidence).toBe(true);
    expect(report.deferred).toBe(true);
    await expect(stat(oldRevision)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, "stores", "v1", "marketplaces"))).resolves.toBeTruthy();
  });

  it("does not collect persistent data directories", async () => {
    const root = await fixture();
    const data = join(root, "data", "v1", "orphan-data");
    await directory(data, oldAge);
    const gc = createArtifactGc({ hostRoot: root, maxItems: 100, budgetMs: 10_000 });

    await gc.sweep({ referenced: new Set(), signal: new AbortController().signal });

    await expect(stat(data)).resolves.toBeTruthy();
  });

  it("collects projection staging orphans under the staging rule", async () => {
    const root = await fixture();
    const staging = join(root, "generated", "v1", ".staging", digest("a"));
    await directory(staging, oldAge);
    const gc = createArtifactGc({ hostRoot: root, maxItems: 100, budgetMs: 10_000 });

    await gc.sweep({ referenced: new Set(), signal: new AbortController().signal });

    await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies separate staging and orphan policy grace periods", async () => {
    const previous = process.env.PI_PLUGINS_CONVERGENCE_GRACE_DAYS;
    delete process.env.PI_PLUGINS_CONVERGENCE_GRACE_DAYS;
    try {
      const root = await fixture();
      const now = Date.now();
      const staging = join(root, "staging", "v1", digest("a"));
      const revision = join(root, "stores", "v1", "plugins", digest("b"));
      await directory(staging, oldAge, now);
      await directory(revision, oldAge, now);
      const gc = createArtifactGc({
        hostRoot: root,
        maxItems: 100,
        budgetMs: 10_000,
        stagingGraceMs: 9 * 86_400_000,
        orphanGraceMs: 7 * 86_400_000,
      });

      await gc.sweep({ referenced: new Set(), signal: new AbortController().signal, now });

      await expect(stat(staging)).resolves.toBeTruthy();
      await expect(stat(revision)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      if (previous === undefined) delete process.env.PI_PLUGINS_CONVERGENCE_GRACE_DAYS;
      else process.env.PI_PLUGINS_CONVERGENCE_GRACE_DAYS = previous;
    }
  });
});
