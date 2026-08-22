import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PENDING_DELETE_GRACE_MS,
  createPendingDeleteMarkerStore,
  replayPendingDeleteMarkers,
} from "../../src/infrastructure/cleanup/pending-data-deletion.js";
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
  it("creates one atomically named file and replays it", async () => {
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

  it("retains a marker for an installed plugin until the 60-minute gate", async () => {
    const root = await mkdtemp(join(tmpdir(), "pending-delete-"));
    roots.push(root);
    const markers = createPendingDeleteMarkerStore({ root });
    const now = 10_000_000;
    const pending = marker(now - PENDING_DELETE_GRACE_MS + 1);
    await markers.create(pending);
    const data = { async remove() { throw new Error("must not delete installed data"); } };
    const beforeGate = await replayPendingDeleteMarkers({ markers, data, now, isInstalled: async () => true, signal: new AbortController().signal });
    expect(beforeGate[0]?.outcome).toBe("retained");
    expect(await markers.list()).toHaveLength(1);

    const atGate = await replayPendingDeleteMarkers({ markers, data, now: now + 1, isInstalled: async () => true, signal: new AbortController().signal });
    expect(atGate[0]?.outcome).toBe("discarded-installed");
    expect(await markers.list()).toHaveLength(0);
  });

  it("deletes data and unlinks the marker when the plugin is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "pending-delete-"));
    roots.push(root);
    const markers = createPendingDeleteMarkerStore({ root });
    await markers.create(marker(1));
    const removed: string[] = [];
    const data = { async remove(plan: { plugin: string }) { removed.push(plan.plugin); return "removed" as const; } };
    const result = await replayPendingDeleteMarkers({ markers, data, isInstalled: async () => false, signal: new AbortController().signal });
    expect(result[0]?.outcome).toBe("deleted");
    expect(removed).toEqual(["demo@local"]);
    expect(await markers.list()).toHaveLength(0);
  });
});
