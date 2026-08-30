import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  delete process.env.PI_PLUGIN_SESSION_ID;
  await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function context(cwd: string, session?: { id: string; file?: string }): ExtensionContext {
  return {
    cwd,
    hasUI: false,
    mode: "tui",
    signal: undefined,
    sessionManager: {
      getSessionId: () => session?.id ?? "",
      getSessionFile: () => session?.file,
    },
  } as unknown as ExtensionContext;
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
    expect(result).toEqual({
      message: {
        customType: "plugin-hook-context",
        content: "WORKBENCH_CONTEXT",
        display: false,
      },
    });
  });

  it("delivers UserPromptSubmit additional context as a model-visible message on the same turn", async () => {
    const repository = await tempDir();
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: "ADDRESSED_COMMENT_ID",
      },
    }).replace(/'/gu, "'\\''");
    const snapshot = {
      plugins: [{
        info: {
          marketplace: "m",
          name: "digest",
          root: "/plugin-root",
          data: "/plugin-data",
          enabled: true,
          autoUpdate: false,
        },
        skillPaths: [],
        skillNames: [],
        hooks: [{
          event: "UserPromptSubmit",
          command: `printf '%s' '${output}'`,
          timeoutMs: 5_000,
        }],
        diagnostics: [],
      }],
      skillPaths: [],
      diagnostics: [],
    } as unknown as RuntimeSnapshot;
    const handlers = new Map<string, (...args: any[]) => unknown>();
    registerPluginHooks({ on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI, snapshot);
    const ctx = context(repository, { id: "pi-session" });

    await handlers.get("input")?.({ text: "acknowledge", images: [], source: "rpc" }, ctx);
    const result = await handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx);

    expect(result).toEqual({
      message: {
        customType: "plugin-hook-context",
        content: "ADDRESSED_COMMENT_ID",
        display: false,
      },
    });
    await expect(handlers.get("before_agent_start")?.({ systemPrompt: "BASE" }, ctx)).resolves.toBeUndefined();
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

  it("prefers the claude MCP document over a same-named codex host alternative without warning", async () => {
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
    expect(duplicate).toBeUndefined();

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
    const declared = config.mcpServers.server as { cwd: string; env: Record<string, string> };
    expect(declared.cwd).toBe(join(agentDir, "plugin-host/plugins/m/codex-only"));
    expect(declared.env).toMatchObject({
      PI_SESSION_ID: "$env:PI_PLUGIN_SESSION_ID",
      CLAUDE_SESSION_ID: "$env:PI_PLUGIN_SESSION_ID",
    });
  });

  describe("session identity and shell result passthrough", () => {
    // Hook children spawn with ctx.cwd, so it must be a real directory.
    let cwd = "";
    beforeEach(async () => {
      cwd = await tempDir();
    });
    // A probe hook: parses the stdin payload and records it alongside the
    // identity environment variables the runtime must export, into a file
    // next to the probe script (hook stdout is reserved for hook output
    // semantics, so a file is the reliable capture channel).
    async function identityProbeSnapshot(event: string, matcher?: string): Promise<{ snapshot: RuntimeSnapshot; capture: string }> {
      const dir = await tempDir();
      const probe = join(dir, "identity-probe.mjs");
      const capture = join(dir, "captured.json");
      await writeFile(probe, [
        "import { writeFileSync } from 'node:fs';",
        "let data = '';",
        "process.stdin.on('data', (chunk) => { data += chunk; });",
        "process.stdin.on('end', () => {",
        "  const payload = JSON.parse(data);",
        "  writeFileSync(process.env.IDENTITY_PROBE_OUT, JSON.stringify({",
        "    payload,",
        "    pi_session_id: process.env.PI_SESSION_ID,",
        "    claude_session_id: process.env.CLAUDE_SESSION_ID,",
        "  }));",
        "});",
      ].join("\n"));
      const snapshot = {
        plugins: [{
          info: {
            marketplace: "m",
            name: "identity-probe",
            root: "/plugin-root",
            data: "/plugin-data",
            enabled: true,
            autoUpdate: false,
          },
          skillPaths: [],
          skillNames: [],
          hooks: [{ event, command: `IDENTITY_PROBE_OUT=${JSON.stringify(capture)} ${process.execPath} ${probe}`, timeoutMs: 5_000, ...(matcher === undefined ? {} : { matcher }) }],
          diagnostics: [],
        }],
        skillPaths: [],
        diagnostics: [],
      } as unknown as RuntimeSnapshot;
      return { snapshot, capture };
    }

    async function readCaptured(capture: string): Promise<{ payload: Record<string, unknown>; pi_session_id?: string; claude_session_id?: string }> {
      return JSON.parse(await readFile(capture, "utf8")) as { payload: Record<string, unknown>; pi_session_id?: string; claude_session_id?: string };
    }

    function handlersOf(snapshot: RuntimeSnapshot) {
      const handlers = new Map<string, (...args: any[]) => unknown>();
      registerPluginHooks({ on: (event: string, handler: (...args: any[]) => unknown) => handlers.set(event, handler) } as unknown as ExtensionAPI, snapshot);
      return handlers;
    }

    it("puts the pi session id and transcript path in every hook payload and child environment", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("SessionStart");
      const handlers = handlersOf(snapshot);
      await handlers.get("session_start")?.(
        { reason: "reload" },
        context(cwd, { id: "pi-sess-123", file: "/sessions/pi-sess-123.jsonl" }),
      );
      const delivered = await readCaptured(capture);
      expect(delivered.payload.session_id).toBe("pi-sess-123");
      expect(delivered.payload.transcript_path).toBe("/sessions/pi-sess-123.jsonl");
      // Environment parity: the same opaque instance id under both names.
      expect(delivered.pi_session_id).toBe("pi-sess-123");
      expect(delivered.claude_session_id).toBe("pi-sess-123");
    });

    it("treats the Claude manifest '*' matcher as an all-events wildcard", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("SessionStart", "*");
      const handlers = handlersOf(snapshot);
      await handlers.get("session_start")?.(
        { reason: "startup" },
        context(cwd, { id: "pi-sess-wildcard" }),
      );
      const delivered = await readCaptured(capture);
      expect(delivered.payload.hook_event_name).toBe("SessionStart");
      expect(delivered.payload.session_id).toBe("pi-sess-wildcard");
    });

    it("publishes the current identity for later MCP child startup and clears it on shutdown", async () => {
      const { snapshot } = await identityProbeSnapshot("SessionStart");
      const handlers = handlersOf(snapshot);
      const ctx = context(cwd, { id: "pi-sess-mcp-child" });
      await handlers.get("session_start")?.({ reason: "startup" }, ctx);
      expect(process.env.PI_PLUGIN_SESSION_ID).toBe("pi-sess-mcp-child");
      await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
      expect(process.env.PI_PLUGIN_SESSION_ID).toBeUndefined();
    });

    it("omits identity fields and env vars when no session is available", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("SessionStart");
      const handlers = handlersOf(snapshot);
      await handlers.get("session_start")?.({ reason: "reload" }, context(cwd));
      const delivered = await readCaptured(capture);
      expect(delivered.payload.session_id).toBeUndefined();
      expect(delivered.payload.transcript_path).toBeUndefined();
      expect(delivered.pi_session_id).toBeUndefined();
      expect(delivered.claude_session_id).toBeUndefined();
    });

    it("adds a CC-shaped tool_response for shell results while retaining tool_output", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("PostToolUse");
      const handlers = handlersOf(snapshot);
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t1",
        input: { command: "git commit -m 'x'" },
        content: [{ type: "text", text: "[main abcd123] done" }],
        isError: false,
        details: undefined,
      }, context(cwd, { id: "pi-sess-123" }));
      const delivered = await readCaptured(capture);
      expect(delivered.payload.hook_event_name).toBe("PostToolUse");
      expect(delivered.payload.tool_output).toEqual([{ type: "text", text: "[main abcd123] done" }]);
      expect(delivered.payload.tool_response).toEqual({ exit_code: 0, stdout: "[main abcd123] done", stderr: "" });
    });

    it("derives exit_code from pi's failure status line and routes the failure event", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("PostToolUseFailure");
      const handlers = handlersOf(snapshot);
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t2",
        input: { command: "git commit -m 'x'" },
        content: [{ type: "text", text: "nothing to commit\n\nCommand exited with code 1" }],
        isError: true,
        details: undefined,
      }, context(cwd, { id: "pi-sess-123" }));
      const delivered = await readCaptured(capture);
      expect(delivered.payload.hook_event_name).toBe("PostToolUseFailure");
      expect(delivered.payload.tool_response).toEqual({
        exit_code: 1,
        stdout: "nothing to commit\n\nCommand exited with code 1",
        stderr: "",
      });
    });

    it("uses pi's explicit nonzero status line even when the result event is not marked as an error", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("PostToolUse");
      const handlers = handlersOf(snapshot);
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolName: "bash",
        toolCallId: "t-status",
        input: { command: "git commit -m 'x'" },
        content: [{ type: "text", text: "nothing to commit\n\nCommand exited with code 1" }],
        isError: false,
        details: undefined,
      }, context(cwd, { id: "pi-sess-123" }));
      const delivered = await readCaptured(capture);
      expect(delivered.payload.hook_event_name).toBe("PostToolUse");
      expect(delivered.payload.tool_response).toEqual({
        exit_code: 1,
        stdout: "nothing to commit\n\nCommand exited with code 1",
        stderr: "",
      });
    });

    it("does not add tool_response for non-shell tools", async () => {
      const { snapshot, capture } = await identityProbeSnapshot("PostToolUse");
      const handlers = handlersOf(snapshot);
      await handlers.get("tool_result")?.({
        type: "tool_result",
        toolName: "read",
        toolCallId: "t3",
        input: { path: "/repo/f.txt" },
        content: [{ type: "text", text: "file body" }],
        isError: false,
        details: undefined,
      }, context(cwd, { id: "pi-sess-123" }));
      const delivered = await readCaptured(capture);
      expect(delivered.payload.tool_response).toBeUndefined();
      expect(delivered.payload.tool_output).toEqual([{ type: "text", text: "file body" }]);
    });
  });
});
