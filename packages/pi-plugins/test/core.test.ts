import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeRelativePath,
  createPluginHost,
  isPathContained,
  mergeMarketplaceCatalogs,
  resolveContainedPath,
} from "../src/index.js";

const temporary: string[] = [];

async function tempDir(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-plugins-core-"));
  temporary.push(value);
  return value;
}

async function pluginRepository(root: string, entries: Record<string, string> = {}): Promise<void> {
  await mkdir(join(root, ".agents/plugins"), { recursive: true });
  await mkdir(join(root, "plugins/demo/skills/demo"), { recursive: true });
  await writeFile(join(root, ".agents/plugins/marketplace.json"), JSON.stringify({
    name: "fixture-marketplace",
    plugins: [{ name: "demo", source: { source: "local", path: "./plugins/demo" }, description: "Demo", version: "1.0.0" }],
  }));
  await writeFile(join(root, "plugins/demo/skills/demo/SKILL.md"), "---\nname: demo\ndescription: demo\n---\n# Demo\n");
  for (const [path, contents] of Object.entries(entries)) {
    await mkdir(join(root, "plugins/demo", path, ".."), { recursive: true }).catch(() => undefined);
    await writeFile(join(root, "plugins/demo", path), contents);
  }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("filesystem-first plugin core", () => {
  it("rejects traversal and preserves real containment boundaries", () => {
    expect(assertSafeRelativePath("./plugins/demo/")).toBe("plugins/demo");
    expect(() => assertSafeRelativePath("../outside")).toThrow();
    expect(() => assertSafeRelativePath("plugins/../outside")).toThrow();
    expect(isPathContained("/tmp/checkout", "/tmp/checkout/plugins/demo")).toBe(true);
    expect(isPathContained("/tmp/checkout", "/tmp/checkout-escape")).toBe(false);
    expect(resolveContainedPath("/tmp/checkout", "./plugins/demo")).toBe("/tmp/checkout/plugins/demo");
  });

  it("merges permissive local and string catalog entries", () => {
    const merged = mergeMarketplaceCatalogs([
      { name: "market", path: ".agents/plugins/marketplace.json", plugins: [{ name: "one", source: { kind: "local", path: "plugins/one" }, raw: "plugins/one" }] },
      { name: "market", path: ".claude-plugin/marketplace.json", plugins: [{ name: "two", source: { kind: "local", path: "plugins/two" }, raw: "plugins/two" }] },
    ]);
    expect(merged.catalog.plugins.map((item) => item.name)).toEqual(["one", "two"]);
  });

  it("adds, installs, updates, toggles, and removes bundles using only filesystem truth", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, { "version.txt": "one" });
    const host = createPluginHost(agentDir);

    const marketplace = await host.addMarketplace(repository);
    expect(marketplace.name).toBe("fixture-marketplace");
    expect(JSON.parse(await readFile(join(agentDir, "plugin-host/marketplaces/fixture-marketplace/source.json"), "utf8")).kind).toBe("local");
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.name).toBe("demo");
    await expect(host.updatePlugin("fixture-marketplace", "demo")).rejects.toThrow("plugin is not installed: demo@fixture-marketplace");

    await host.installPlugin("fixture-marketplace", "demo");
    const installedRoot = join(agentDir, "plugin-host/plugins/fixture-marketplace/demo");
    expect(await readFile(join(installedRoot, "version.txt"), "utf8")).toBe("one");
    expect(await readFile(join(agentDir, "plugin-host/plugins/fixture-marketplace/demo/.pi-plugin.json"), "utf8")).toContain("fixture-marketplace");
    expect(await readFile(join(agentDir, "plugin-host/data/fixture-marketplace/demo/.keep"), "utf8").catch(() => "missing")).toBe("missing");

    await writeFile(join(repository, "plugins/demo/version.txt"), "two");
    await host.updatePlugin("fixture-marketplace", "demo");
    expect(await readFile(join(installedRoot, "version.txt"), "utf8")).toBe("two");

    await host.disablePlugin("fixture-marketplace", "demo");
    expect((await host.listInstalled())[0]?.enabled).toBe(false);
    await host.installPlugin("fixture-marketplace", "demo");
    expect((await host.listInstalled())[0]?.enabled).toBe(false);
    await host.enablePlugin("fixture-marketplace", "demo");
    expect((await host.listInstalled())[0]?.enabled).toBe(true);
    const dataFile = join(agentDir, "plugin-host/data/fixture-marketplace/demo/value.txt");
    await writeFile(dataFile, "persistent");
    await host.removePlugin("fixture-marketplace", "demo");
    expect((await host.listInstalled())).toHaveLength(0);
    expect(await readFile(dataFile, "utf8")).toBe("persistent");
    await host.removePlugin("fixture-marketplace", "demo", true);
    await expect(readFile(dataFile, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("normalizes read-only source copies so installed caches remain replaceable", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository);
    const skillRoot = join(repository, "plugins/demo/skills/demo");
    const skillFile = join(skillRoot, "SKILL.md");
    await chmod(skillFile, 0o444);
    await chmod(skillRoot, 0o555);
    try {
      const host = createPluginHost(agentDir);
      await host.addMarketplace(repository);
      await host.installPlugin("fixture-marketplace", "demo");
      await host.updatePlugin("fixture-marketplace", "demo");
      await host.removePlugin("fixture-marketplace", "demo");
      expect(await host.listInstalled()).toEqual([]);
    } finally {
      await chmod(skillRoot, 0o755);
      await chmod(skillFile, 0o644);
    }
  });

  it("rejects symlinks before installation and refuses to activate a later-mutated bundle", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository);
    await symlink(join(repository, "outside.txt"), join(repository, "plugins/demo/escape.txt"));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await expect(host.installPlugin("fixture-marketplace", "demo")).rejects.toThrow(/symlink/iu);

    const installedRoot = join(agentDir, "plugin-host/plugins/fixture-marketplace/demo");
    await mkdir(join(installedRoot, "skills/demo"), { recursive: true });
    await writeFile(join(installedRoot, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
    await symlink(join(repository, "outside.txt"), join(installedRoot, "escape.txt"));
    const runtime = await host.scanRuntime();
    expect(runtime.skillPaths).toEqual([]);
    expect(runtime.diagnostics.some((item) => /symlink/iu.test(item.message))).toBe(true);
  });
});
