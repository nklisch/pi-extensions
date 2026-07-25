import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readClaudeHooks } from "../../../src/formats/claude/hook-reader.js";
import { deriveComponentId } from "../../../src/domain/component-identity.js";
import type { Provenance } from "../../../src/domain/provenance.js";
import { PluginKeySchema } from "../../../src/domain/identity.js";

const plugin = PluginKeySchema.parse("agile-workflow@nklisch-skills");
const provenance: Provenance = {
  location: {
    host: "claude",
    documentKind: "hooks",
    path: "hooks/hooks.json",
    pointer: "",
  },
};
const fixture = JSON.parse(readFileSync(
  new URL("../../fixtures/plugins/hooks/agile-workflow-hooks.json", import.meta.url),
).toString()) as unknown;
const sha256 = (bytes: Uint8Array): Uint8Array =>
  new Uint8Array(createHash("sha256").update(bytes).digest());

function context(host: "claude" | "codex" = "claude") {
  return { plugin, nativeHost: host, provenance: { ...provenance, location: { ...provenance.location, host } } };
}

describe("Claude hook reader", () => {
  it("reads the hermetic agile-workflow fixture without execution", () => {
    const result = readClaudeHooks(fixture, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(4);
    const hooks = result.value.filter((component) => component.kind === "hook");
    expect(hooks.map((hook) => hook.event.value).sort()).toEqual([
      "PostCompact",
      "PostToolUse",
      "SessionStart",
      "UserPromptSubmit",
    ]);
    const session = hooks.find((hook) => hook.event.value === "SessionStart");
    expect(session).toMatchObject({
      matcher: { value: "startup|resume|clear|compact" },
      handler: { value: { kind: "shell", timeoutMs: 5000 } },
    });
    expect(hooks.every((hook) => !Object.hasOwn(hook, "verdict"))).toBe(true);
    expect(hooks.every((hook) => !Object.hasOwn(hook, "activatable"))).toBe(true);
    expect(session?.handler.value.kind === "shell" && session.handler.value.command).toContain("prompt-context.py");
  });

  it("normalizes command and exec handlers, including timeout units and provenance", () => {
    const result = readClaudeHooks({
      hooks: {
        Event: [{
          matcher: "tool",
          hooks: [
            { type: "command", command: "echo ready", timeout: 1.5 },
            { type: "exec", command: "node", args: ["hook.js"], timeout_ms: 250 },
          ],
        }],
      },
    }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hooks = result.value.filter((component) => component.kind === "hook");
    expect(hooks.map((hook) => hook.handler.value)).toEqual(expect.arrayContaining([
      { kind: "exec", command: "node", args: ["hook.js"], timeoutMs: 250 },
      { kind: "shell", command: "echo ready", timeoutMs: 1500 },
    ]));
    expect(hooks[0]?.handler.provenance[0]?.location.pointer).toContain("/hooks/Event/0/hooks/");
    const expected = deriveComponentId(plugin, {
      kind: "hook",
      event: "Event",
      matcher: "tool",
      handler: { kind: "shell", command: "echo ready", timeoutMs: 1500 },
    }, sha256);
    expect(hooks.some((hook) => hook.id === expected)).toBe(true);
  });

  it("normalizes shell choice structurally and rejects shell-on-exec", () => {
    const powershell = readClaudeHooks({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "Write-Output ready", shell: "powershell" }] }] },
    }, context());
    expect(powershell.ok).toBe(true);
    if (powershell.ok) expect(powershell.value[0]?.kind === "hook" && powershell.value[0].handler.value).toMatchObject({ kind: "shell", shell: "powershell" });

    const bash = readClaudeHooks({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "echo ready", shell: "bash" }] }] },
    }, context());
    expect(bash.ok).toBe(true);
    if (bash.ok) expect(bash.value[0]?.kind === "hook" && bash.value[0].handler.value).toEqual({ kind: "shell", command: "echo ready" });

    const invalid = readClaudeHooks({
      hooks: { SessionStart: [{ hooks: [{ type: "exec", command: "node", args: [], shell: "bash" }] }] },
    }, context());
    expect(invalid.ok).toBe(false);
  });

  it("retains unsupported handlers as foreign inventory and preserves supplemental fields", () => {
    const result = readClaudeHooks({
      hooks: {
        Event: [{
          hooks: [
            { type: "prompt", prompt: "ask", async: true },
            { type: "command", command: "echo ready", statusMessage: "working", async: true, conditions: { flag: true } },
          ],
        }],
      },
    }, context());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const foreign = result.value.filter((component) => component.kind === "foreign");
    const hook = result.value.find((component) => component.kind === "hook");
    expect(foreign).toHaveLength(1);
    expect(foreign[0]?.declaration.value).toEqual({ type: "prompt", prompt: "ask", async: true });
    expect(hook?.metadata.map((item) => item.key)).toEqual([
      "claude.hook.handler.statusMessage",
      "claude.hook.handler.async",
      "claude.hook.handler.conditions",
    ]);
    expect(hook).not.toHaveProperty("verdict");
  });

  it("verifies foreign identities from hook semantics rather than pointer spelling", () => {
    const direct = readClaudeHooks({
      hooks: { Event: [{ type: "prompt", prompt: "ask" }] },
    }, context());
    const grouped = readClaudeHooks({
      hooks: { Event: [{ hooks: [{ type: "prompt", prompt: "ask" }] }] },
    }, context());

    expect(direct.ok).toBe(true);
    expect(grouped.ok).toBe(true);
    if (!direct.ok || !grouped.ok) return;
    const directForeign = direct.value.find((component) => component.kind === "foreign");
    const groupedForeign = grouped.value.find((component) => component.kind === "foreign");
    expect(directForeign).toMatchObject({ declarationSubkey: groupedForeign?.declarationSubkey });
    expect(directForeign?.id).toBe(groupedForeign?.id);
    expect(directForeign?.declaration.provenance[0]?.location.pointer)
      .not.toBe(groupedForeign?.declaration.provenance[0]?.location.pointer);
  });

  it("deduplicates equivalent handlers and fails malformed known shapes", () => {
    const equivalent = readClaudeHooks({
      hooks: {
        Event: [
          { hooks: [{ type: "command", command: "echo ready" }] },
          { hooks: [{ type: "shell", command: "echo ready" }] },
        ],
      },
    }, context());
    expect(equivalent.ok).toBe(true);
    if (equivalent.ok) {
      expect(equivalent.value.filter((component) => component.kind === "hook")).toHaveLength(1);
      expect(equivalent.value.every((component) => component.kind === "hook")).toBe(true);
    }

    const malformed = readClaudeHooks({
      hooks: { Event: [{ hooks: [{ type: "command", command: 42 }] }] },
    }, context());
    expect(malformed.ok).toBe(false);
    expect(malformed).toMatchObject({ diagnostics: [{ code: "SCHEMA_INVALID", location: { pointer: "/hooks/Event/0/hooks/0/command" } }] });
  });
});
