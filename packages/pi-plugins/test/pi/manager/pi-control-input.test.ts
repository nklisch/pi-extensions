import { describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withSensitiveValue } from "../../../src/application/sensitive-value.js";
import type { NativeControlInputRequest } from "../../../src/application/ports/native-control-input.js";
import { createPiControlInputPort } from "../../../src/pi/manager/pi-control-input.js";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";

const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const canary = "SECRET-CANARY-123";
const safe = (text: string) => ({ text, escaped: false, truncated: false });
const field = (sensitive: boolean) => ({
  key: sensitive ? "TOKEN" : "DIRECTORY",
  label: safe(sensitive ? "API token" : "Audit directory"),
  kind: "string" as const,
  required: true,
  sensitive,
  defaultPresent: false,
  constraints: {},
  state: "missing" as const,
});
const consentId = trustedInstallFlowFixture.configureTrust.consent.consentId;

function request(fields: readonly ReturnType<typeof field>[]): NativeControlInputRequest {
  return {
    executionId,
    purpose: "trusted-install",
    channel: { kind: "none" },
    fields,
    consent: trustedInstallFlowFixture.configureTrust.consent,
    expected: { consentId },
  };
}

function context(mode: "tui" | "rpc" | "json" | "print") {
  const input = vi.fn(async () => "/audit");
  const rendered: string[] = [];
  const custom = vi.fn(async (factory: any) => await new Promise((resolve) => {
    const component = factory(
      { terminal: { rows: 20 }, requestRender() {} },
      { fg: (_token: string, text: string) => text, bold: (text: string) => text },
      { matches: (data: string, id: string) => id.includes("confirm") ? data === "\r" : id.includes("cancel") || id === "app.interrupt" ? data === "\u001b" : false },
      resolve,
    );
    component.focused = true;
    if (component.constructor.name === "MaskedInputSurface") {
      component.handleInput(canary);
      component.handleInput("\r");
    } else {
      component.handleInput(" ");
      for (let index = 0; index < 32; index += 1) {
        rendered.push(JSON.stringify(component.render(96)));
        component.handleInput("\u001b[6~");
      }
      component.handleInput("\r");
    }
  }));
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    ui: {
      input,
      custom,
      confirm: vi.fn(async () => true),
      select: vi.fn(async () => "keep"),
      setEditorText: vi.fn(),
      pasteToEditor: vi.fn(),
    },
  } as unknown as ExtensionCommandContext;
  return { ctx, input, custom, rendered };
}

function remoteConsentRequest(): NativeControlInputRequest {
  const existing = trustedInstallFlowFixture.configureTrust.consent;
  const stdio = existing.components.mcpServers[0]!;
  const consent = {
    ...existing,
    components: {
      ...existing.components,
      mcpServers: [{
        ...stdio,
        transport: "streamable-http" as const,
        command: undefined,
        args: [],
        url: {
          scheme: "https" as const,
          host: safe("example.invalid"),
          port: safe("8443"),
          path: safe("/mcp/v1"),
          queryPresent: true,
        },
        environmentNames: [safe("MCP_TOKEN")],
        authentication: "bearer-environment" as const,
      }],
    },
  };
  return { ...request([]), consent } as NativeControlInputRequest;
}

describe("Pi control input adapter", () => {
  it("collects non-sensitive and masked sensitive values with exact consent", async () => {
    const h = context("tui");
    const port = createPiControlInputPort({ context: h.ctx, mode: "tui" });
    const result = await port.collect(request([field(false), field(true)]), new AbortController().signal);
    expect(result).toMatchObject({ kind: "supplied", nonSensitive: [{ key: "DIRECTORY", value: "/audit" }], decision: { kind: "grant", consentId } });
    if (result.kind !== "supplied") throw new Error("expected supplied");
    expect(withSensitiveValue(result.sensitive[0]!.value, (plaintext) => plaintext)).toBe(canary);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect((h.ctx.ui as any).setEditorText).not.toHaveBeenCalled();
    expect((h.ctx.ui as any).pasteToEditor).not.toHaveBeenCalled();
    port.dispose();
  });

  it("uses retained non-sensitive values and exact pre-reviewed consent without reopening visible prompts", async () => {
    const h = context("tui");
    const port = createPiControlInputPort({ context: h.ctx, mode: "tui", preset: { nonSensitive: { DIRECTORY: "/retained" }, consentId } });
    const result = await port.collect(request([field(false)]), new AbortController().signal);
    expect(result).toMatchObject({ kind: "supplied", nonSensitive: [{ key: "DIRECTORY", value: "/retained" }], decision: { kind: "grant", consentId } });
    expect(h.input).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("includes exact executable disclosure in supported RPC trust confirmation", async () => {
    const h = context("rpc");
    const port = createPiControlInputPort({ context: h.ctx, mode: "rpc" });
    await expect(port.collect(request([field(false)]), new AbortController().signal)).resolves.toMatchObject({ kind: "supplied", decision: { kind: "grant", consentId } });
    expect((h.ctx.ui as any).confirm).toHaveBeenCalledWith("Plugin trust / action", expect.stringContaining("bundle-hook"), expect.any(Object));
  });

  it.each(["tui", "rpc"] as const)("presents the complete redacted MCP endpoint in %s consent", async (mode) => {
    const h = context(mode);
    const port = createPiControlInputPort({ context: h.ctx, mode });
    await expect(port.collect(remoteConsentRequest(), new AbortController().signal)).resolves.toMatchObject({
      kind: "supplied",
      decision: { kind: "grant", consentId },
    });
    const presentation = mode === "rpc"
      ? JSON.stringify((h.ctx.ui as any).confirm.mock.calls)
      : h.rendered.join("\n");
    expect(presentation).toContain("https://example.invalid:8443/mcp/v1");
    expect(presentation).not.toContain("MCP_QUERY_SECRET_CANARY");
  });

  it("fails closed for RPC secrets before opening any dialog", async () => {
    const h = context("rpc");
    const port = createPiControlInputPort({ context: h.ctx, mode: "rpc" });
    await expect(port.collect(request([field(true)]), new AbortController().signal)).resolves.toEqual({ kind: "unavailable", code: "SECRET_PROMPT_UNAVAILABLE" });
    expect(h.input).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("does not reinterpret explicit file/stdin/environment input channels", async () => {
    const h = context("tui");
    const port = createPiControlInputPort({ context: h.ctx, mode: "tui" });
    const explicit = { ...request([field(false)]), channel: { kind: "file-json" as const, locator: "/tmp/input.json" } };
    await expect(port.collect(explicit, new AbortController().signal)).resolves.toEqual({ kind: "unavailable", code: "CHANNEL_UNSUPPORTED" });
    expect(h.input).not.toHaveBeenCalled();
  });

  it.each(["json", "print"] as const)("never prompts in %s mode", async (mode) => {
    const h = context(mode);
    const port = createPiControlInputPort({ context: h.ctx, mode });
    await expect(port.collect(request([field(false)]), new AbortController().signal)).resolves.toEqual({ kind: "unavailable", code: "NO_TTY" });
    expect(h.input).not.toHaveBeenCalled();
    expect(h.custom).not.toHaveBeenCalled();
  });

  it("cancellation/disposal wins without partial input", async () => {
    const h = context("tui");
    const port = createPiControlInputPort({ context: h.ctx, mode: "tui" });
    port.cancel();
    await expect(port.collect(request([field(false)]), new AbortController().signal)).resolves.toEqual({ kind: "cancelled" });
    port.dispose();
    port.dispose();
  });
});
