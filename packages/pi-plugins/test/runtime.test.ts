import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { executeHookCommand, registerPluginHooks } from "../src/hooks.js";
import { createPluginHost } from "../src/index.js";
import type { RuntimeSnapshot } from "../src/index.js";

const temporary: string[] = [];
async function tempDir(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "pi-plugins-runtime-"));
  temporary.push(value);
  return value;
}
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(cwd: string): ExtensionContext {
  return { cwd, hasUI: false, mode: "tui", signal: undefined } as unknown as ExtensionContext;
}

describe("filesystem plugin runtime", () => {
  it("executes hooks with the documented cwd, roots, timeout, and cancellation boundary", async () => {
    const root = await tempDir();
    const result = await executeHookCommand({
      command: `${process.execPath} -e "process.stdout.write(JSON.stringify({cwd:process.cwd(),root:process.env.PLUGIN_ROOT,data:process.env.PLUGIN_DATA}))"`,
      cwd: root,
      environment: { PLUGIN_ROOT: "/plugin", CLAUDE_PLUGIN_ROOT: "/plugin", PLUGIN_DATA: "/data", CLAUDE_PLUGIN_DATA: "/data", CLAUDE_PROJECT_DIR: "/project" },
      timeoutMs: 2_000,
      stdin: { cwd: root },
    });
    expect(result.ok).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual({ cwd: root, root: "/plugin", data: "/data" });

    const controller = new AbortController();
    const running = executeHookCommand({
      command: `${process.execPath} -e "setTimeout(() => {}, 60000)"`,
      cwd: root,
      environment: {},
      timeoutMs: 60_000,
      signal: controller.signal,
      stdin: { cwd: root },
    });
    controller.abort(new Error("stop"));
    await expect(running).resolves.toMatchObject({ ok: false, error: { name: "AbortError" } });

    await expect(executeHookCommand({
      command: "exit 0",
      cwd: root,
      environment: {},
      timeoutMs: 2_000,
      stdin: { payload: "x".repeat(256_000) },
    })).resolves.toMatchObject({ ok: true });
  });

  it("discovers conventional skills and maps Workbench SessionStart context into Pi", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await mkdir(join(repository, ".agents/plugins"), { recursive: true });
    await mkdir(join(repository, "plugins/workbench/skills/workbench"), { recursive: true });
    await mkdir(join(repository, "plugins/workbench/hooks"), { recursive: true });
    await writeFile(join(repository, ".agents/plugins/marketplace.json"), JSON.stringify({ name: "nklisch-skills", plugins: [{ name: "workbench", source: "./plugins/workbench" }] }));
    await writeFile(join(repository, "plugins/workbench/skills/workbench/SKILL.md"), "---\nname: workbench\ndescription: Workbench\n---\n# Workbench");
    await writeFile(join(repository, "plugins/workbench/hooks/hooks.json"), JSON.stringify({ hooks: {
      SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: `printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "WORKBENCH_CONTEXT" } }).replace(/'/gu, "'\\''")}'` }] }],
    } }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("nklisch-skills", "workbench");
    const snapshot = await host.scanRuntime();
    expect(snapshot.skillPaths).toEqual([join(agentDir, "plugin-host/plugins/nklisch-skills/workbench/skills")]);
    expect(snapshot.plugins[0]?.hooks[0]?.event).toBe("SessionStart");

    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerPluginHooks({ on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI, snapshot);
    const ctx = context(repository);
    await handlers.get("session_start")?.({ reason: "reload" }, ctx);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx);
    expect(result).toEqual({ systemPrompt: "BASE\n\nWORKBENCH_CONTEXT" });
  });

  it("builds MCP configuration with recursive plugin root/data substitutions and collision namespaces", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await mkdir(join(repository, ".claude-plugin"), { recursive: true });
    await mkdir(join(repository, "plugins/alpha"), { recursive: true });
    await mkdir(join(repository, "plugins/beta"), { recursive: true });
    await mkdir(join(repository, "plugins/gamma"), { recursive: true });
    await writeFile(join(repository, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "m", plugins: [
      { name: "alpha", source: "./plugins/alpha" },
      { name: "beta", source: "./plugins/beta" },
      { name: "gamma", source: "./plugins/gamma" },
    ] }));
    const mcp = (token: string) => ({ mcpServers: { same: { command: "node", args: [`${token}/server.mjs`, "${PLUGIN_DATA}"], env: { ROOT: "${PLUGIN_ROOT}/nested" } } } });
    await writeFile(join(repository, "plugins/alpha/.mcp.json"), JSON.stringify(mcp("${PLUGIN_ROOT}")));
    await writeFile(join(repository, "plugins/beta/.mcp.json"), JSON.stringify(mcp("${CLAUDE_PLUGIN_ROOT}")));
    await writeFile(join(repository, "plugins/gamma/.mcp.json"), JSON.stringify(mcp("${PLUGIN_ROOT}")));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("m", "alpha");
    await host.installPlugin("m", "beta");
    await host.installPlugin("m", "gamma");
    const config = await host.buildMcpConfig();
    const names = Object.keys(config.mcpServers);
    expect(names).toEqual(["alpha_m_same", "beta_m_same", "gamma_m_same"]);
    expect(config.mcpServers[names[0]!] ).toMatchObject({ args: [expect.stringContaining("/alpha/server.mjs"), expect.stringContaining("/alpha")] });
  });

  it("prefers the claude MCP document over a same-named codex declaration and reports the duplicate", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await mkdir(join(repository, "plugins/krometrail-like/.claude-plugin"), { recursive: true });
    await mkdir(join(repository, "plugins/krometrail-like/.codex-plugin"), { recursive: true });
    await mkdir(join(repository, "plugins/krometrail-like/skills/demo"), { recursive: true });
    await mkdir(join(repository, ".claude-plugin"), { recursive: true });
    await writeFile(join(repository, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "m", plugins: [{ name: "krometrail-like", source: "./plugins/krometrail-like" }] }));
    await writeFile(join(repository, "plugins/krometrail-like/.claude-plugin/plugin.json"), JSON.stringify({
      name: "krometrail-like",
      mcpServers: "./.mcp.json",
    }));
    await writeFile(join(repository, "plugins/krometrail-like/.mcp.json"), JSON.stringify({
      mcpServers: { krometrail: { command: "${CLAUDE_PLUGIN_ROOT}/bin/tool", args: ["mcp"], env: { ROOT: "${CLAUDE_PLUGIN_DATA}" } } },
    }));
    await writeFile(join(repository, "plugins/krometrail-like/.codex-plugin/plugin.json"), JSON.stringify({
      name: "krometrail-like",
      mcpServers: "./.mcp.codex.json",
    }));
    await writeFile(join(repository, "plugins/krometrail-like/.mcp.codex.json"), JSON.stringify({
      krometrail: { command: "sh", args: ["bin/tool"], cwd: "." },
    }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("m", "krometrail-like");
    const snapshot = await host.scanRuntime();
    const plugin = snapshot.plugins[0]!;
    // The codex declaration must not clobber the claude declaration.
    expect(Object.keys(plugin.mcp!)).toEqual(["krometrail"]);
    expect(plugin.mcp!.krometrail).toMatchObject({ command: "${CLAUDE_PLUGIN_ROOT}/bin/tool" });
    const duplicate = snapshot.diagnostics.find((item) => item.scope === "MCP.krometrail");
    expect(duplicate?.message).toContain("duplicate");

    // Substituted config keeps the claude declaration intact.
    const config = await host.buildMcpConfig(snapshot);
    expect(config.mcpServers.krometrail).toMatchObject({ command: expect.stringContaining("/bin/tool") });
  });

  it("anchors codex-only stdio servers to the plugin root so relative commands resolve", async () => {
    const agentDir = await tempDir();
    const repository = await tempDir();
    await mkdir(join(repository, "plugins/codex-only/.codex-plugin"), { recursive: true });
    await mkdir(join(repository, ".claude-plugin"), { recursive: true });
    await writeFile(join(repository, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "m", plugins: [{ name: "codex-only", source: "./plugins/codex-only" }] }));
    await writeFile(join(repository, "plugins/codex-only/.codex-plugin/plugin.json"), JSON.stringify({
      name: "codex-only",
      mcpServers: "./.mcp.codex.json",
    }));
    await writeFile(join(repository, "plugins/codex-only/.mcp.codex.json"), JSON.stringify({
      server: { command: "sh", args: ["bin/tool", "mcp"], cwd: "." },
    }));
    const host = createPluginHost(agentDir);
    await host.addMarketplace(repository);
    await host.installPlugin("m", "codex-only");
    const snapshot = await host.scanRuntime();
    const config = await host.buildMcpConfig(snapshot);
    const declared = config.mcpServers.server as { cwd: string };
    expect(declared.cwd).toBe(join(agentDir, "plugin-host/plugins/m/codex-only"));
  });
});
