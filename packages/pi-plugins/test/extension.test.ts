import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginHost } from "../src/index.js";
import extension from "../src/pi/extension.js";

const temporary: string[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
async function tempDir(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-plugins-extension-"));
  temporary.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
});

describe("Pi extension boundary", () => {
  it("registers runtime discovery, hooks, and /plugins from a filesystem snapshot", async () => {
    const agentDir = await tempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const root = join(agentDir, "plugin-host/plugins/m/demo");
    await mkdir(join(root, "skills/demo"), { recursive: true });
    await writeFile(join(root, "skills/demo/SKILL.md"), "---\nname: demo\ndescription: demo\n---\n");
    const registrations: string[] = [];
    let pluginsHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      on(event: string) { registrations.push(event); },
      registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
        registrations.push(`command:${name}`);
        if (name === "plugins") pluginsHandler = options.handler;
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    expect(registrations).toContain("resources_discover");
    expect(registrations).toContain("command:plugins");
    expect(registrations).toContain("session_start");

    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await pluginsHandler?.("list", { hasUI: false, ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext);
    expect(output).toHaveBeenCalledWith("demo@m enabled");
    output.mockRestore();
  });

  it("reloads exactly once when the interactive manager closes with runtime changes", async () => {
    const agentDir = await tempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    let pluginsHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
        if (name === "plugins") pluginsHandler = options.handler;
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    const reload = vi.fn(async () => undefined);
    await pluginsHandler?.("", {
      hasUI: true,
      mode: "tui",
      reload,
      ui: { custom: vi.fn(async () => ({ reloadNeeded: true })), notify: vi.fn() },
    } as unknown as ExtensionCommandContext);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("force-updates marked plugins as one command batch and reloads exactly once after success", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    await mkdir(join(repository, ".agents/plugins"), { recursive: true });
    for (const name of ["good", "missing"]) {
      await mkdir(join(repository, `plugins/${name}`), { recursive: true });
      await writeFile(join(repository, `plugins/${name}/payload.txt`), name);
    }
    await writeFile(join(repository, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "market", plugins: [
      { name: "good", source: "./plugins/good", version: "1.0.0" },
      { name: "missing", source: "./plugins/missing", version: "1.0.0" },
    ] }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("market", "good");
    await host.installPlugin("market", "missing");
    await host.setAutoUpdate("market", "good", true);
    await host.setAutoUpdate("market", "missing", true);
    await writeFile(join(repository, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "market", plugins: [
      { name: "good", source: "./plugins/good", version: "1.0.0" },
    ] }));

    let pluginsHandler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
    const pi = {
      on() {},
      registerCommand(name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) {
        if (name === "plugins") pluginsHandler = options.handler;
      },
    } as unknown as ExtensionAPI;
    await extension(pi);
    const reload = vi.fn(async () => undefined);
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await pluginsHandler?.("update-marked", {
      hasUI: false,
      mode: "print",
      reload,
      ui: { notify: vi.fn() },
    } as unknown as ExtensionCommandContext);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(output).toHaveBeenCalledWith("Updated good@market.");
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Failed missing@market"));
    output.mockRestore();
  });
});
