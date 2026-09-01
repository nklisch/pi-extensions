import { describe, expect, it } from "vitest";
import { AgentTypeRegistry } from "#src/config/agent-types";
import { fileSnapshotSource, liveFileSource, listNavigableAgents } from "#src/ui/session-navigation";
import { makeNavigable } from "#test/helpers/make-navigable";

const registry = new AgentTypeRegistry(() => new Map());

describe("session navigation after retention release", () => {
  it("uses the shared Pi file adapter for a released transcript", () => {
    const source = fileSnapshotSource("/sessions/child.jsonl", () => [
      JSON.stringify({ type: "session", id: "s1", cwd: "/tmp", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "from file", timestamp: 1 } }),
    ].join("\n"));
    expect(source.getMessages()).toEqual([expect.objectContaining({ role: "user", content: "from file" })]);
    expect(source.availability?.()).toEqual({ kind: "file", path: "/sessions/child.jsonl" });
  });

  it("swaps a live source to a file after release and retains content on a missing file", () => {
    let released = false;
    let onRelease: (() => void) | undefined;
    const record = makeNavigable({
      outputFile: "/sessions/child.jsonl",
      isSessionReady: () => !released,
      agentMessages: [{ role: "user", content: "live", timestamp: 1 } as never],
      subscribeToRecordUpdates: (callback) => { onRelease = callback; return () => { onRelease = undefined; }; },
    });
    const source = liveFileSource(record, () => [
      JSON.stringify({ type: "session", id: "s1", cwd: "/tmp", timestamp: new Date().toISOString() }),
      JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: "file", timestamp: 2 } }),
    ].join("\n"));
    expect(source.getMessages()[0]).toMatchObject({ content: "live" });
    released = true;
    onRelease?.();
    expect(source.availability?.()).toEqual({ kind: "file", path: "/sessions/child.jsonl" });
    expect(source.getMessages()[0]).toMatchObject({ content: "file" });

    const missing = liveFileSource({ ...record, outputFile: "/missing.jsonl", isSessionReady: () => false }, () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); });
    expect(missing.getMessages()[0]).toMatchObject({ content: "live" });
    expect(missing.availability?.()).toMatchObject({ kind: "unavailable", path: "/missing.jsonl" });
  });

  it("sources a released record from its persisted transcript", () => {
    const entries = listNavigableAgents([
      makeNavigable({
        isSessionReady: () => false,
        outputFile: "/sessions/child.jsonl",
      }),
    ], registry);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "evicted",
      outputFile: "/sessions/child.jsonl",
    });
    expect(entries[0].label).toContain("released (snapshot)");
  });
});
