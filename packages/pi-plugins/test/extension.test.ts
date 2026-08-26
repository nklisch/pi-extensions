import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
