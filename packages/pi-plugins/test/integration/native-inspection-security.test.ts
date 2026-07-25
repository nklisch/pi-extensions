import { describe, expect, it, vi } from "vitest";
import { createNativeInspectionService } from "../../src/application/native-inspection-service.js";
import { NativeInspectionDetailResultSchema, SafeDisplayFieldSchema } from "../../src/application/native-inspection-contract.js";
import { projectRedactedUrl, projectSafeComponents, projectSafeProvenance, projectSafeSource } from "../../src/application/native-inspection-disclosure.js";
import { toSafeDisplayField } from "../../src/application/native-inspection-display.js";
import { evaluateCompatibility } from "../../src/domain/compatibility-evaluator.js";
import { capabilities, claimFixture, componentId, directPlugin, fixtureProvenance } from "../fixtures/compatibility/common.js";
import { createNativeInstalledHarness, nativeInspectionSha256 } from "../helpers/native-installed-inspection.js";

const unsafeScalars = [
  "\u0000", "\u001b", "\u007f", "\u0085", "\u061c", "\u200b", "\u2028", "\u202e", "\u2066", "\ufeff", "e\u0301", "x\ufe0f", "\ud800", "\udc00",
];

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(allStrings);
  return [];
}

describe("native inspection hostile-input and redaction acceptance", () => {
  it("rejects every raw unsafe scalar while accepting the sanitizer's exact projection", () => {
    for (const raw of unsafeScalars) {
      expect(() => SafeDisplayFieldSchema.parse({ text: raw, escaped: false, truncated: false })).toThrow();
      const projected = toSafeDisplayField(raw, { maxScalars: 256 });
      expect(() => SafeDisplayFieldSchema.parse(projected)).not.toThrow();
      expect(projected.escaped).toBe(true);
    }
  });

  it.each([
    "/home/alice/private",
    "\\\\server\\share\\private",
    "//server/share/private",
    "\\\\?\\C:\\private",
    "\\\\.\\pipe\\private",
    "C:\\private",
    "c:/private",
    "\\root-relative\\private",
    "FiLe:///home/alice/private",
    "fIlE://server/share/private",
  ])("redacts cross-platform absolute provenance %s", (path) => {
    const projected = projectSafeProvenance([{ location: { host: "claude", documentKind: "mcp", path } }]);
    expect(projected[0]?.path.text).toBe("[redacted-absolute-path]");
    expect(JSON.stringify(projected)).not.toContain(path);
  });

  it("preserves the deliberate declared local-source exception", () => {
    const projected = projectSafeSource({ kind: "local-git", path: "C:\\chosen\\plugin", ref: "main" });
    expect(projected.location?.text).toBe("C:\\chosen\\plugin");
  });

  it("projects hostile controls, URLs, commands, headers, and environment values through real disclosure code", () => {
    const provenance = fixtureProvenance("\\\\server\\private\\plugin.mcp.json", "/mcpServers/demo", "claude", "mcp");
    const mcp = {
      kind: "mcp-server" as const,
      id: componentId("mcp-server", "a"),
      nativeKey: claimFixture("native\u001b[2J\u202Ekey", provenance),
      declaration: claimFixture({
        transport: "streamable-http",
        url: "https://example.invalid/mcp?token=credential-value#private-fragment",
        headers: { "X-Inspection": "credential-value" },
      }, provenance),
      metadata: [],
    };
    const stdio = {
      kind: "mcp-server" as const,
      id: componentId("mcp-server", "c"),
      nativeKey: claimFixture("stdio", provenance),
      declaration: claimFixture({ transport: "stdio", command: "server", env: { PRIVATE_TOKEN: "credential-value" } }, provenance),
      metadata: [],
    };
    const hook = {
      kind: "hook" as const,
      id: componentId("hook", "b"),
      event: claimFixture("PreToolUse", fixtureProvenance("hooks.json", "/hooks/0/event", "claude", "hooks")),
      handler: claimFixture({ kind: "exec" as const, command: "node\u001b[31m", args: ["--flag\nforged", "${PLUGIN_ROOT}"] }, fixtureProvenance("hooks.json", "/hooks/0/handler", "claude", "hooks")),
      metadata: [],
    };
    const plugin = directPlugin({ components: { hooks: [hook], mcpServers: [mcp, stdio] } });
    const view = projectSafeComponents({ plugin, compatibility: evaluateCompatibility({ plugin, capabilities: capabilities() }) });
    const redactedUrl = projectRedactedUrl("https://user:password@example.invalid/mcp?token=credential-value#private-fragment");
    const json = JSON.stringify({ view, redactedUrl });
    expect(view.mcpServers.some((server) => server.nativeKey.escaped)).toBe(true);
    expect(redactedUrl).toMatchObject({ queryPresent: true, fragmentPresent: true });
    expect(view.hooks[0]?.handler.kind === "exec" && view.hooks[0].handler.command.escaped).toBe(true);
    expect(json).not.toContain("user:password");
    expect(json).not.toContain("credential-value");
    expect(json).not.toContain("private-fragment");
    expect(json).not.toContain("server\\private");
    for (const value of allStrings(view)) expect(value).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufeff]/u);
  });

  it("parses the final service detail result instead of trusting a forged projector", async () => {
    const harness = createNativeInstalledHarness({ enabled: true, remote: "connected" });
    const valid = await harness.inspector.inspect(harness.subject, harness.snapshot, new AbortController().signal);
    expect(valid.kind).toBe("found");
    if (valid.kind !== "found") return;
    const forged = structuredClone(valid);
    (forged.detail.summary.name as any) = { text: "forged\u001b[2J", escaped: false, truncated: false };
    expect(() => NativeInspectionDetailResultSchema.parse(forged)).toThrow();
    const service = createNativeInspectionService({
      evidence: { capture: async () => harness.snapshot, validate: async () => "current" },
      installed: { inspect: vi.fn(async () => forged) } as never,
      candidates: { inspect: vi.fn() },
      catalog: { search: vi.fn(), detail: vi.fn() } as never,
      adoption: { preview: vi.fn() },
      clock: { nowEpochMilliseconds: () => 1 } as never,
      sha256: nativeInspectionSha256,
    });
    await expect(service.detail({ snapshotId: valid.detail.snapshotId, detailId: valid.detail.summary.detailId }, new AbortController().signal)).rejects.toThrow();
  });
});
