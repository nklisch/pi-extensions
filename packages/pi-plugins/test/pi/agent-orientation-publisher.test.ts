import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assembleAgentOrientation, type OrientationPlugin } from "../../src/application/agent-orientation.js";
import { createAgentOrientationPublisher } from "../../src/pi/agent-orientation-publisher.js";

const sha256 = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());

function orientation(): ReturnType<typeof assembleAgentOrientation> {
  const plugin: OrientationPlugin = {
    scope: { kind: "user" },
    plugin: "demo@market",
    marketplace: "market",
    version: "1.0.0",
    revision: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    activation: "enabled",
    active: true,
    skills: [{ name: "demo", description: "demo skill" }],
    hooks: [],
    mcpServers: [],
  };
  return assembleAgentOrientation({
    packageVersion: "0.3.9",
    briefPath: "/brief.md",
    scopeLabel: "user scope",
    plugins: [plugin],
    degraded: [],
    sha256,
  });
}

function context(entries: readonly unknown[]): ExtensionContext {
  return {
    sessionManager: { buildContextEntries: () => entries },
  } as unknown as ExtensionContext;
}

describe("agent orientation Pi publisher", () => {
  it("deduplicates against active context, not the raw transcript", async () => {
    const sendMessage = vi.fn();
    const publisher = createAgentOrientationPublisher({ pi: { sendMessage } as unknown as Pick<ExtensionAPI, "sendMessage"> });
    const content = orientation();
    const entry = {
      type: "custom_message",
      customType: "plugin-host:agent-orientation-v1",
      details: { factsDigest: content.factsDigest },
    };
    const root = await mkdtemp(join(tmpdir(), "pi-orientation-"));
    const path = join(root, "agent-brief.md");
    try {
      await publisher.publish(content, path, context([entry]));
      expect(sendMessage).not.toHaveBeenCalled();
      await publisher.publish(content, path, context([]));
      expect(sendMessage).toHaveBeenCalledOnce();
      await publisher.publish({ ...content, factsDigest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as typeof content.factsDigest }, path, context([entry]));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      await publisher.publish(content, path, context([entry]));
      expect(sendMessage).toHaveBeenCalledTimes(2);
      const written = await readFile(path, "utf8");
      expect(written).toContain("Installed plugins");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reinjects after compaction removes the orientation from active context", async () => {
    const sendMessage = vi.fn();
    const publisher = createAgentOrientationPublisher({ pi: { sendMessage } as unknown as Pick<ExtensionAPI, "sendMessage"> });
    const content = orientation();
    const root = await mkdtemp(join(tmpdir(), "pi-orientation-"));
    try {
      await publisher.publish(content, join(root, "brief.md"), context([
        { type: "custom_message", customType: "other", details: { factsDigest: content.factsDigest } },
      ]));
      expect(sendMessage).toHaveBeenCalledOnce();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("atomically replaces a stale brief with an unavailable marker", async () => {
    const sendMessage = vi.fn();
    const publisher = createAgentOrientationPublisher({ pi: { sendMessage } as unknown as Pick<ExtensionAPI, "sendMessage"> });
    const root = await mkdtemp(join(tmpdir(), "pi-orientation-"));
    const path = join(root, "project", "agent-brief.md");
    try {
      await publisher.publishUnavailable({
        briefPath: path,
        code: "STATE_CORRUPT",
        packageVersion: "0.3.9",
        sha256,
        context: context([]),
      });
      expect(await readFile(path, "utf8")).toContain("Orientation unavailable this session");
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.stringContaining("STATE_CORRUPT"),
        display: false,
      }), { triggerTurn: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
