import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNodeForeignStateFiles } from "../../../src/infrastructure/adoption/node-foreign-state-files.js";

async function home(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-adoption-"));
  await mkdir(join(root, ".claude", "plugins"), { recursive: true });
  await mkdir(join(root, ".codex"), { recursive: true });
  return root;
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

describe("Node foreign-state files adapter", () => {
  it("reads exactly the three fixed paths and tolerates absent hosts", async () => {
    const root = await home();
    try {
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), "{}", "utf8");
      const port = createNodeForeignStateFiles({ userHome: root });
      const observations = await port.readAll(new AbortController().signal);
      expect(observations.map((observation) => observation.document)).toEqual([
        "claude-known-marketplaces",
        "claude-user-settings",
        "codex-user-config",
      ]);
      expect(observations.map((observation) => observation.kind)).toEqual(["present", "missing", "missing"]);
      expect(observations[0]!.path).toBe(".claude/plugins/known_marketplaces.json");
      expect(JSON.stringify(observations)).not.toContain(root);
    } finally {
      await cleanup(root);
    }
  });

  it("rejects symlink leaves and directories", async () => {
    const root = await home();
    try {
      const target = join(root, "known.json");
      await writeFile(target, "{}", "utf8");
      await symlink(target, join(root, ".claude", "plugins", "known_marketplaces.json"));
      await mkdir(join(root, ".claude", "settings.json"));
      const observations = await createNodeForeignStateFiles({ userHome: root }).readAll(new AbortController().signal);
      expect(observations[0]).toMatchObject({ kind: "unreadable", code: "SYMLINK" });
      expect(observations[1]).toMatchObject({ kind: "unreadable", code: "NOT_REGULAR" });
    } finally {
      await cleanup(root);
    }
  });

  it("rejects a fixed document that escapes through a parent symlink", async () => {
    const root = await home();
    const outside = await mkdtemp(join(tmpdir(), "pi-adoption-outside-"));
    try {
      await writeFile(join(outside, "known_marketplaces.json"), "{}", "utf8");
      await rm(join(root, ".claude", "plugins"), { recursive: true });
      await symlink(outside, join(root, ".claude", "plugins"));
      const observations = await createNodeForeignStateFiles({ userHome: root }).readAll(new AbortController().signal);
      expect(observations[0]).toMatchObject({ kind: "unreadable", code: "ESCAPES_ROOT" });
      expect(JSON.stringify(observations)).not.toContain(outside);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  });

  it("bounds size before and during decoding and rejects invalid UTF-8", async () => {
    const root = await home();
    try {
      await writeFile(join(root, ".claude", "plugins", "known_marketplaces.json"), "123456", "utf8");
      await writeFile(join(root, ".claude", "settings.json"), Buffer.from([0xc3, 0x28]));
      const observations = await createNodeForeignStateFiles({ userHome: root, maxDocumentBytes: 5 }).readAll(new AbortController().signal);
      expect(observations[0]).toMatchObject({ kind: "unreadable", code: "TOO_LARGE" });
      expect(observations[1]).toMatchObject({ kind: "unreadable", code: "INVALID_UTF8" });
    } finally {
      await cleanup(root);
    }
  });

  it("does not create or inspect cache, credential, trust, or activation paths", async () => {
    const root = await home();
    try {
      const sentinels = [
        join(root, ".claude", "plugins", "cache", "sentinel"),
        join(root, ".claude", "credentials.json"),
        join(root, ".codex", "auth.json"),
        join(root, ".codex", "trust.json"),
      ];
      await mkdir(join(root, ".claude", "plugins", "cache"), { recursive: true });
      for (const sentinel of sentinels) await writeFile(sentinel, "sentinel", "utf8");
      await createNodeForeignStateFiles({ userHome: root }).readAll(new AbortController().signal);
      await expect(readFile(sentinels[0]!, "utf8")).resolves.toBe("sentinel");
      await expect(readFile(sentinels[1]!, "utf8")).resolves.toBe("sentinel");
    } finally {
      await cleanup(root);
    }
  });

  it("honors cancellation before reading the next fixed path", async () => {
    const root = await home();
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(createNodeForeignStateFiles({ userHome: root }).readAll(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await cleanup(root);
    }
  });
});
