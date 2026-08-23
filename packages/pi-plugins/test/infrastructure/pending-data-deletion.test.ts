import { mkdtemp, readFile, readdir, rm, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPendingDeleteMarkerStore } from "../../src/infrastructure/cleanup/pending-data-deletion.js";
import type { PendingDeleteMarker } from "../../src/infrastructure/cleanup/pending-data-deletion.js";

const roots: string[] = [];
const marker = (requestedAt: number): PendingDeleteMarker => ({
  scope: { kind: "user" },
  plugin: "demo@local" as never,
  dataRef: `plugin-data-v1:sha256:${"a".repeat(64)}` as never,
  requestedAt,
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pending-delete markers", () => {
  it("creates one atomically named file and reads it", async () => {
    const root = await mkdtemp(join(tmpdir(), "pending-delete-"));
    roots.push(root);
    const markers = createPendingDeleteMarkerStore({ root: join(root, "cleanup", "v1", "pending-deletes") });
    await markers.create(marker(10));
    const names = await readdir(markers.root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^[0-9a-f]{64}\.json$/u);
    expect(JSON.parse(await readFile(join(markers.root, names[0]!), "utf8"))).toMatchObject({ plugin: "demo@local" });
    expect(await markers.list()).toHaveLength(1);
    await markers.remove(marker(10));
    expect(await markers.list()).toHaveLength(0);
  });

  it("removes stale atomic-write leftovers but leaves recent writers alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "pending-delete-"));
    roots.push(root);
    const markers = createPendingDeleteMarkerStore({ root });
    await markers.create(marker(Date.now()));
    const stale = join(markers.root, "stale.tmp");
    const recent = join(markers.root, "recent.tmp");
    await writeFile(stale, "stale", "utf8");
    await writeFile(recent, "recent", "utf8");
    const old = new Date(Date.now() - 6 * 60_000);
    await utimes(stale, old, old);

    await markers.list();

    await expect(stat(stale)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(recent)).resolves.toBeTruthy();
    await unlink(recent);
  });
});
