import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
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

async function multiPluginRepository(root: string, versions: Record<string, string | undefined>): Promise<void> {
  await mkdir(join(root, ".agents/plugins"), { recursive: true });
  const plugins = Object.entries(versions).map(([name, version]) => ({
    name,
    source: { source: "local", path: `./plugins/${name}` },
    description: `${name} fixture`,
    ...(version === undefined ? {} : { version }),
  }));
  await writeFile(join(root, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "fixture-marketplace", plugins }));
  for (const name of Object.keys(versions)) {
    await mkdir(join(root, `plugins/${name}/skills/${name}`), { recursive: true });
    await writeFile(join(root, `plugins/${name}/skills/${name}/SKILL.md`), `---\nname: ${name}\ndescription: ${name}\n---\n# ${name}\n`);
    await writeFile(join(root, `plugins/${name}/payload.txt`), `${name}-one`);
  }
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("filesystem-first plugin core", () => {
  it.each([".claude-plugin/plugin.json", ".codex-plugin/plugin.json", "plugin.json"])("reads installed and available versions from %s without catalog duplication", async (manifestPath) => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await multiPluginRepository(repository, { demo: undefined });
    const manifest = join(repository, "plugins/demo", manifestPath);
    await mkdir(join(manifest, ".."), { recursive: true });
    await writeFile(manifest, JSON.stringify({ name: "demo", version: "1.2.3" }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.version).toBe("1.2.3");
    const installed = await host.installPlugin("fixture-marketplace", "demo");
    expect(installed.version).toBe("1.2.3");
    expect(installed.receipt?.version).toBe("1.2.3");

    // An existing install may have a missing or stale receipt. Reading the
    // bundle recovers its version without rewriting user files or borrowing latest.
    await writeFile(join(installed.root, ".pi-plugin.json"), "{}");
    expect((await host.listInstalled())[0]?.version).toBe("1.2.3");
    expect(await readFile(join(installed.root, ".pi-plugin.json"), "utf8")).toBe("{}");
    await writeFile(join(installed.root, ".pi-plugin.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(manifest, JSON.stringify({ name: "demo", version: "2.0.0" }));
    await host.refreshMarketplace("fixture-marketplace");
    expect((await host.listInstalled())[0]?.version).toBe("1.2.3");
    expect((await host.scanRuntime()).plugins[0]?.info.version).toBe("1.2.3");
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.version).toBe("2.0.0");
    await host.setAutoUpdate("fixture-marketplace", "demo", true);
    expect((await host.updateMarkedPlugins()).results[0]?.updated).toBe(true);
    expect((await host.listInstalled())[0]?.version).toBe("2.0.0");
    expect((await host.updateMarkedPlugins()).results[0]?.skipped).toBe(true);
  });

  it("checks manifest-only remote plugin releases and installs the inspected candidate", async () => {
    const agentDir = await tempDir();
    const marketplace = await tempDir();
    const remote = await tempDir();
    await pluginRepository(remote, { "plugin.json": JSON.stringify({ version: "1.0.0" }) });
    const git = (...args: string[]): void => { execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args], { cwd: remote, stdio: "pipe" }); };
    git("init"); git("add", "."); git("commit", "--no-gpg-sign", "-m", "Initial fixture");
    await mkdir(join(marketplace, ".agents/plugins"), { recursive: true });
    await writeFile(join(marketplace, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "fixture-marketplace", plugins: [{ name: "demo", source: { source: "git-subdir", url: remote, path: "plugins/demo" } }] }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(marketplace);
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.version).toBeUndefined();
    expect((await host.installPlugin("fixture-marketplace", "demo")).version).toBe("1.0.0");
    await host.setAutoUpdate("fixture-marketplace", "demo", true);
    await writeFile(join(remote, "plugins/demo/plugin.json"), JSON.stringify({ version: "2.0.0" }));
    git("add", "."); git("commit", "--no-gpg-sign", "-m", "Second fixture release");
    expect((await host.updateMarkedPlugins()).results[0]?.updated).toBe(true);
    expect((await host.listInstalled())[0]?.version).toBe("2.0.0");
    expect((await host.updateMarkedPlugins()).results[0]?.skipped).toBe(true);
  });

  it("does not mutate an installed bundle when an update is already cancelled", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, { "payload.txt": "original" });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    const installed = await host.installPlugin("fixture-marketplace", "demo");
    await writeFile(join(repository, "plugins/demo/payload.txt"), "replacement");
    await host.refreshMarketplace("fixture-marketplace");
    const controller = new AbortController();
    controller.abort("cancel fixture");
    await expect(host.updatePlugin("fixture-marketplace", "demo", { refresh: false, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(join(installed.root, "payload.txt"), "utf8")).toBe("original");
  });

  it("uses bundle versions over stale catalog versions without repeatedly updating", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, { "plugin.json": JSON.stringify({ version: "0.5.2" }) });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.version).toBe("0.5.2");
    await host.installPlugin("fixture-marketplace", "demo");
    await host.setAutoUpdate("fixture-marketplace", "demo", true);
    expect((await host.updateMarkedPlugins()).results[0]?.skipped).toBe(true);
  });

  it("ignores malformed optional metadata and uses the next native manifest", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, {
      ".claude-plugin/plugin.json": "not JSON",
      ".codex-plugin/plugin.json": JSON.stringify({ version: " 2.0.0 ", description: "Bundle description" }),
      "plugin.json": JSON.stringify({ version: "3.0.0" }),
    });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]).toMatchObject({ version: "2.0.0", description: "Demo" });
    await host.installPlugin("fixture-marketplace", "demo");
    expect((await host.listInstalled())[0]).toMatchObject({ version: "2.0.0", description: "Bundle description" });
  });

  it("does not follow escaping manifest links for browse metadata", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    const outside = await tempDir();
    await multiPluginRepository(repository, { demo: undefined });
    await writeFile(join(outside, "manifest.json"), JSON.stringify({ version: "secret-outside-value" }));
    await symlink(join(outside, "manifest.json"), join(repository, "plugins/demo/plugin.json"));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    expect((await host.browseMarketplace("fixture-marketplace")).plugins[0]?.version).toBeUndefined();
  });

  it("rejects traversal and preserves real containment boundaries", () => {
    expect(assertSafeRelativePath("./plugins/demo/")).toBe("plugins/demo");
    expect(() => assertSafeRelativePath("../outside")).toThrow();
    expect(() => assertSafeRelativePath("plugins/../outside")).toThrow();
    expect(isPathContained("/tmp/checkout", "/tmp/checkout/plugins/demo")).toBe(true);
    expect(isPathContained("/tmp/checkout", "/tmp/checkout-escape")).toBe(false);
    expect(resolveContainedPath("/tmp/checkout", "./plugins/demo")).toBe("/tmp/checkout/plugins/demo");
  });

  it("keeps missing metadata from an equivalent native catalog declaration", () => {
    const source = { kind: "git" as const, url: "https://example.test/plugin.git" };
    const merged = mergeMarketplaceCatalogs([
      { name: "market", path: "codex", plugins: [{ name: "demo", source, raw: {} }] },
      { name: "market", path: "claude", plugins: [{ name: "demo", source, version: "2.0.0", description: "Demo", raw: {} }] },
    ]);
    expect(merged.catalog.plugins[0]).toMatchObject({ version: "2.0.0", description: "Demo" });
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

  it("preserves and toggles the automatic-update marker alongside disabled state", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, { "version.txt": "one" });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("fixture-marketplace", "demo");
    await host.setAutoUpdate("fixture-marketplace", "demo", true);
    await host.disablePlugin("fixture-marketplace", "demo");

    await writeFile(join(repository, "plugins/demo/version.txt"), "two");
    await host.updatePlugin("fixture-marketplace", "demo");
    const updated = (await host.listInstalled())[0]!;
    expect(updated.autoUpdate).toBe(true);
    expect(updated.enabled).toBe(false);
    expect(await readFile(join(updated.root, "version.txt"), "utf8")).toBe("two");

    await host.setAutoUpdate("fixture-marketplace", "demo", false);
    expect((await host.listInstalled())[0]!.autoUpdate).toBe(false);
  });

  it("persists the manager check-on-open preference and defaults it off", async () => {
    const agentDir = await tempDir();
    const host = createPluginHost(agentDir);

    expect(await host.getCheckOnOpen()).toBe(false);
    await host.setCheckOnOpen(true);
    expect(await createPluginHost(agentDir).getCheckOnOpen()).toBe(true);
    await host.setCheckOnOpen(false);
    expect(await createPluginHost(agentDir).getCheckOnOpen()).toBe(false);
  });

  it("refreshes each marked marketplace once and updates only declared version changes", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await multiPluginRepository(repository, { versioned: "1.0.0", manual: undefined });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("fixture-marketplace", "versioned");
    await host.installPlugin("fixture-marketplace", "manual");
    await host.setAutoUpdate("fixture-marketplace", "versioned", true);
    await host.setAutoUpdate("fixture-marketplace", "manual", true);

    await writeFile(join(repository, ".agents/plugins/marketplace.json"), JSON.stringify({
      name: "fixture-marketplace",
      plugins: [
        { name: "versioned", source: { source: "local", path: "./plugins/versioned" }, description: "versioned", version: "2.0.0" },
        { name: "manual", source: { source: "local", path: "./plugins/manual" }, description: "manual" },
      ],
    }));
    await writeFile(join(repository, "plugins/versioned/payload.txt"), "versioned-two");
    const startup = await host.updateMarkedPlugins();
    expect(startup.refreshes).toHaveLength(1);
    expect(startup.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ identity: { plugin: "versioned", marketplace: "fixture-marketplace" }, ok: true, updated: true, skipped: false }),
      expect.objectContaining({ identity: { plugin: "manual", marketplace: "fixture-marketplace" }, ok: true, updated: false, skipped: true }),
    ]));
    expect(await readFile(join((await host.listInstalled()).find((item) => item.name === "versioned")!.root, "payload.txt"), "utf8")).toBe("versioned-two");

    const forced = await host.updateMarkedPlugins({ force: true });
    expect(forced.refreshes).toHaveLength(1);
    expect(forced.results.find((result) => result.identity.plugin === "manual")?.updated).toBe(true);
  });

  it("retains installed copies on offline marked refresh failures", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await pluginRepository(repository, { "version.txt": "installed" });
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("fixture-marketplace", "demo");
    await host.setAutoUpdate("fixture-marketplace", "demo", true);
    await rm(repository, { recursive: true, force: true });
    const result = await host.updateMarkedPlugins();
    expect(result.results[0]).toMatchObject({ ok: false, updated: false });
    expect(await readFile(join((await host.listInstalled())[0]!.root, "version.txt"), "utf8")).toBe("installed");
  });

  it("runs explicit batches sequentially with mixed results and cancellation between items", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await multiPluginRepository(repository, { good: "1.0.0", bad: "1.0.0" });
    await symlink(join(repository, "outside.txt"), join(repository, "plugins/bad/escape.txt"));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    const mixed = await host.runPluginBatch("install", [
      { plugin: "good", marketplace: "fixture-marketplace" },
      { plugin: "bad", marketplace: "fixture-marketplace" },
    ]);
    expect(mixed.results.map((result) => result.ok)).toEqual([true, false]);

    const secondAgentDir = await tempDir();
    const secondHost = createPluginHost(secondAgentDir);
    await secondHost.addMarketplace(repository);
    const controller = new AbortController();
    const cancelled = await secondHost.runPluginBatch("install", [
      { plugin: "good", marketplace: "fixture-marketplace" },
      { plugin: "bad", marketplace: "fixture-marketplace" },
    ], { onItem: () => controller.abort("stop after first"), signal: controller.signal });
    expect(cancelled.results).toHaveLength(1);
    expect(cancelled.cancelled).toBe(true);
  });
});
