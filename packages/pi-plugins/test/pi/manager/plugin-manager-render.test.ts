import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createNativeControlEnvelope } from "../../../src/application/native-control-contract.js";
import { compileNativeDiagnostics } from "../../../src/application/native-diagnostic-compiler.js";
import { createPluginManagerState, pluginManagerReducer, type PluginManagerRow } from "../../../src/pi/manager/plugin-manager-model.js";
import { renderPluginManager } from "../../../src/pi/manager/plugin-manager-render.js";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";

const sha256 = (bytes: Uint8Array) => new Uint8Array(createHash("sha256").update(bytes).digest());
const safe = (text: string) => ({ text, escaped: false, truncated: false });

const theme = {
  fg: (_token: string, text: string) => `\u001b[31m${text}\u001b[39m`,
  bg: (_token: string, text: string) => `\u001b[44m${text}\u001b[49m`,
  bold: (text: string) => `\u001b[1m${text}\u001b[22m`,
} as any;
const keybindings = {
  getKeys: (id: string) => id.includes("cancel") || id === "app.interrupt" ? ["escape"] : id.includes("confirm") ? ["enter"] : id.includes("page") ? ["pageDown"] : ["up"],
} as any;
const executionId = "native-control-execution-v1:123e4567-e89b-42d3-a456-426614174000" as never;
const row: PluginManagerRow = {
  key: { subject: "installed", key: "user:demo@market", snapshotId: "snapshot", detailId: "detail" },
  title: "界 demo\u001b]52;c;bad\u0007",
  subtitle: "market · user",
  status: "ready",
  scope: "user",
  plugin: "demo@market",
  completion: { category: "plugin", value: "demo@market", safe: { text: "demo", escaped: false, truncated: false } },
  data: {},
};

function state() {
  let value = createPluginManagerState();
  value = pluginManagerReducer(value, { type: "page-loading", request: 1, append: false });
  value = pluginManagerReducer(value, { type: "page-loaded", request: 1, rows: [row], append: false });
  value = pluginManagerReducer(value, { type: "update-counts", unread: 2, unresolved: 3 });
  return value;
}

describe("plugin manager renderer", () => {
  it.each([120, 80, 42])("renders responsive topology within %i columns", (width) => {
    const lines = renderPluginManager({ state: state(), width, height: 24, theme, keybindings, focused: true });
    expect(lines.length).toBeLessThanOrEqual(24);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.join("\n")).toContain("Plugins");
    expect(lines.join("\n")).toContain("installed");
    expect(lines.join("\n")).toContain("updates");
    expect(lines.join("\n")).not.toContain("bad\u0007");
  });

  it("keeps the selected catalog item visible in very short terminals", () => {
    const home = renderPluginManager({ state: state(), width: 42, height: 5, theme, keybindings, focused: true }).join("\n");
    expect(home).toContain("Plugins");
    let list = state();
    list = pluginManagerReducer(list, { type: "intent", intent: { type: "open-section" } });
    expect(renderPluginManager({ state: list, width: 42, height: 5, theme, keybindings, focused: true }).join("\n")).toContain("demo");
  });

  it("keeps long-list selection and the focused tail action visible in small terminals", () => {
    const rows = Array.from({ length: 50 }, (_, index): PluginManagerRow => ({
      ...row,
      key: { ...row.key, key: `user:demo-${index}@market`, detailId: `detail-${index}` },
      title: `demo-${index}`,
      plugin: `demo-${index}@market`,
    }));
    let value = createPluginManagerState();
    value = pluginManagerReducer(value, { type: "page-loading", request: 1, append: false });
    value = pluginManagerReducer(value, { type: "page-loaded", request: 1, rows, append: false });
    value = pluginManagerReducer(value, { type: "resized", columns: 70, rows: 8 });
    value = pluginManagerReducer(value, { type: "intent", intent: { type: "open-section" } });
    value = pluginManagerReducer(value, { type: "intent", intent: { type: "move-selection", delta: 49 } });
    expect(renderPluginManager({ state: value, width: 70, height: 8, theme, keybindings, focused: true }).join("\n")).toContain("demo-49");

    const selected = rows[49]!;
    value = pluginManagerReducer(value, { type: "detail-loading", request: 1, row: selected.key });
    value = pluginManagerReducer(value, {
      type: "detail-loaded",
      request: 1,
      open: true,
      row: selected.key,
      envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "ok", data: { kind: "found", detail: trustedInstallFlowFixture.chooseInspect } as never }),
    });
    value = pluginManagerReducer(value, { type: "focus", pane: "detail", action: "uninstall-delete" });
    const actionView = renderPluginManager({ state: value, width: 70, height: 8, theme, keybindings, focused: true }).join("\n");
    expect(actionView).toContain("Remove plugin");
  });

  it("preserves signed information groups and explicit empty/degraded state", () => {
    let detailed = state();
    detailed = pluginManagerReducer(detailed, { type: "intent", intent: { type: "open-section" } });
    detailed = pluginManagerReducer(detailed, { type: "intent", intent: { type: "open-detail" } });
    detailed = pluginManagerReducer(detailed, { type: "detail-loading", request: 1, row: row.key });
    detailed = pluginManagerReducer(detailed, {
      type: "detail-loaded", request: 1, row: row.key, open: true,
      envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "ok", data: { kind: "found", detail: trustedInstallFlowFixture.chooseInspect } as never }),
    });
    const rendered = renderPluginManager({ state: detailed, width: 120, height: 30, theme, keybindings, focused: true }).join("\n");
    expect(rendered).toContain("Runtime surface");
    expect(rendered).toContain("Compatibility / health");
    expect(rendered).toContain("Actions");

    let empty = createPluginManagerState();
    empty = pluginManagerReducer(empty, { type: "page-loading", request: 1, append: false });
    empty = pluginManagerReducer(empty, { type: "page-failed", request: 1, code: "HOST_BLOCKED" });
    empty = pluginManagerReducer(empty, { type: "intent", intent: { type: "open-section" } });
    const error = renderPluginManager({ state: empty, width: 60, height: 16, theme, keybindings, focused: true }).join("\n");
    expect(error).toContain("HOST_BLOCKED");
    expect(error).toContain("No plugins available");
  });

  it("names the actual reasons when compatibility is red (the krometrail scenario)", () => {
    const detailId = trustedInstallFlowFixture.chooseInspect.summary.detailId;
    const incompatibleDetail = {
      ...trustedInstallFlowFixture.chooseInspect,
      trust: "not-applicable",
      compatibility: {
        ...trustedInstallFlowFixture.chooseInspect.compatibility,
        status: "incompatible",
        requirements: [
          { id: "requirement-v1:pi.mcp.runtime:component-1", capability: safe("pi.mcp.runtime"), status: "unavailable", explanation: safe("Plugin-scoped MCP runtime is available (unavailable)"), provenance: [] },
          { id: "requirement-v1:pi.mcp.transport.stdio:component-1", capability: safe("pi.mcp.transport.stdio"), status: "unavailable", explanation: safe("MCP standard-I/O transport is available (unavailable)"), provenance: [] },
        ],
      },
      diagnostics: compileNativeDiagnostics({ findings: [
        { key: "incompatible", subjectId: detailId },
        { key: "requirementUnavailable", subjectId: detailId, componentId: "component-v1:mcp-server:" + "3".repeat(64) },
        { key: "updateAvailable", subjectId: detailId },
      ] }, sha256),
    };
    let detailed = state();
    detailed = pluginManagerReducer(detailed, { type: "intent", intent: { type: "open-detail" } });
    detailed = pluginManagerReducer(detailed, { type: "detail-loading", request: 1, row: row.key });
    detailed = pluginManagerReducer(detailed, {
      type: "detail-loaded", request: 1, row: row.key, open: true,
      envelope: createNativeControlEnvelope({ executionId, command: "inspection.show", status: "ok", data: { kind: "found", detail: incompatibleDetail } as never }),
    });
    const rendered = renderPluginManager({ state: detailed, width: 120, height: 30, theme, keybindings, focused: true }).join("\n");
    expect(rendered).toContain("Plugin-scoped MCP runtime — unavailable");
    expect(rendered).toContain("MCP standard-I/O transport — unavailable");
    expect(rendered).not.toContain("trust not-applicable");
    expect(rendered).not.toContain("requirements ·");
    expect(rendered).not.toContain("diagnostics");
    expect(rendered).not.toContain("incompatible with this host");
  });

  it("renders envelope failure in plain language without exit jargon", () => {
    let value = state();
    value = pluginManagerReducer(value, { type: "operation-started", action: "update" });
    value = pluginManagerReducer(value, {
      type: "operation-finished",
      envelope: createNativeControlEnvelope({
        executionId,
        command: "lifecycle.update",
        status: "unavailable",
        diagnostics: [{ code: "CONTROL_TARGET_SELECTION_FAILED", severity: "error", action: "reinspect" }],
      }),
    });
    const rendered = renderPluginManager({ state: value, width: 120, height: 30, theme, keybindings, focused: true }).join("\n");
    expect(rendered).toContain("couldn't finish");
    expect(rendered).toContain("current details couldn't be loaded");
    expect(rendered).not.toContain("exit");
    expect(rendered).not.toContain("CONTROL_TARGET_SELECTION_FAILED");
  });
});
