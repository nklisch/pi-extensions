import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { trustedInstallFlowFixture } from "../../fixtures/trusted-install/plugin-install-flow.js";
import { createPluginInstallState, pluginInstallReducer } from "../../../src/pi/manager/plugin-install-flow.js";
import { TrustedInstallActivationResultSchema } from "../../../src/application/trusted-install-contract.js";
import { PluginInstallComponent, renderPluginInstall } from "../../../src/pi/manager/plugin-install-component.js";

const theme = { fg: (_token: string, text: string) => text, bg: (_token: string, text: string) => text, bold: (text: string) => text } as any;

describe("signed plugin install flow", () => {
  it("flattens open → configure/add → activation-result with the disclosure optional", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    let lines = renderPluginInstall({ state, width: 84, height: 30, theme });
    expect(lines.join("\n")).toContain("Add plugin");
    expect(lines.join("\n")).toContain("details you just reviewed");
    expect(lines.join("\n")).toContain("activatable");

    state = pluginInstallReducer(state, { type: "session-opened", session: trustedInstallFlowFixture.states.missingInput.session });
    lines = renderPluginInstall({ state, width: 84, height: 30, theme });
    expect(lines.join("\n")).toContain("Step 1/2 · Configure and add");
    expect(lines.join("\n")).toContain("Executable surface");
    expect(lines.join("\n")).toContain("Review exact executable disclosure (optional)");
    expect(lines.join("\n")).not.toContain("bundle-hook");

    state = pluginInstallReducer(state, { type: "toggle-disclosure", key: "executable" });
    lines = renderPluginInstall({ state, width: 84, height: 30, theme });
    expect(lines.join("\n")).toContain("bundle-hook");
    expect(lines.join("\n")).toContain("bundle-mcp");

    state = pluginInstallReducer(state, { type: "activation-result", result: trustedInstallFlowFixture.activationResult });
    lines = renderPluginInstall({ state, width: 84, height: 30, theme });
    expect(lines.join("\n")).toContain("Add plugin · Result");
    expect(lines.join("\n")).toContain("succeeded");
    expect(lines.join("\n")).toContain("1 discoverable skills");
    expect(lines.every((line) => visibleWidth(line) <= 84)).toBe(true);
  });

  it.each([
    trustedInstallFlowFixture.states.cancelled,
    trustedInstallFlowFixture.states.candidateStale,
    trustedInstallFlowFixture.states.rolledBack,
    trustedInstallFlowFixture.states.recoveryRequired,
  ])("renders owner result truth without treating cancellation as stronger evidence", (result) => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "activation-result", result });
    const output = renderPluginInstall({ state, width: 58, height: 20, theme }).join("\n");
    expect(output).toContain(result.kind);
    if (result.kind === "recovery-required") expect(output).toContain("finish setting it up");
    if (result.kind === "rolled-back") expect(output).toContain("change was undone");
  });

  it("retains only non-sensitive values across Back while exact evidence remains current", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    const session = trustedInstallFlowFixture.states.missingInput.session;
    state = pluginInstallReducer(state, { type: "session-opened", session });
    state = pluginInstallReducer(state, { type: "set-value", key: "ROOT", value: "/audit" });
    state = pluginInstallReducer(state, { type: "consent", consentId: session.consent.consentId });
    state = pluginInstallReducer(state, { type: "back" });
    state = pluginInstallReducer(state, { type: "session-opened", session });
    expect(state.values).toEqual({ ROOT: "/audit" });
    expect(state.consentId).toBeUndefined();
    expect(JSON.stringify(state)).not.toContain("SECRET-CANARY");
  });

  it("grants exact consent from the Add action without forcing disclosure review", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "session-opened", session: trustedInstallFlowFixture.states.missingInput.session });
    // All fixture fields are required: focus starts on the first one, not on the disclosure.
    expect(state.focus).toEqual({ field: "NAME" });
    const actions: unknown[] = [];
    let component!: PluginInstallComponent;
    const keybindings = {
      matches: (data: string, id: string) => id === "tui.select.confirm" ? data === "\r" : id === "tui.select.down" ? data === "\u001b[B" : false,
    } as any;
    const onEvent = (event: any) => {
      state = pluginInstallReducer(state, event);
      component.update(state);
    };
    component = new PluginInstallComponent({ state, theme, keybindings, height: () => 6, onEvent, onAction: (action) => actions.push(action) });
    component.render(44);
    // Arrow keys move focus through the menu; no scrolling is required to act.
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    component.handleInput("\u001b[B");
    expect(state.focus).toBe("continue");
    component.handleInput("\r");
    expect(state.consentId).toBe(state.session?.consent.consentId);
    expect(actions).toContainEqual({ type: "continue" });
  });

  it("lands on Add after the last required non-sensitive value is committed", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "session-opened", session: trustedInstallFlowFixture.states.missingInput.session });
    // NAME is required but defaulted; ROOT is required and missing; TOKEN is
    // required but sensitive (collected masked at apply, so it never gates).
    state = pluginInstallReducer(state, { type: "set-value", key: "ROOT", value: "/audit" });
    expect(state.focus).toBe("continue");
  });

  it("keeps focus on the field while required values are still outstanding", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    const session = trustedInstallFlowFixture.states.missingInput.session;
    const secondMissing = session.fields.map((field) => field.key === "TOKEN" ? { ...field, sensitive: false } : field);
    state = pluginInstallReducer(state, { type: "session-opened", session: { ...session, fields: secondMissing } as never });
    state = pluginInstallReducer(state, { type: "focus", focus: Object.freeze({ field: "ROOT" }) });
    state = pluginInstallReducer(state, { type: "set-value", key: "ROOT", value: "/audit" });
    expect(state.focus).toEqual({ field: "ROOT" });
    state = pluginInstallReducer(state, { type: "focus", focus: Object.freeze({ field: "TOKEN" }) });
    state = pluginInstallReducer(state, { type: "set-value", key: "TOKEN", value: "x" });
    expect(state.focus).toBe("continue");
  });

  it("never moves focus when committing an optional value", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    const session = trustedInstallFlowFixture.states.missingInput.session;
    const withOptional = [...session.fields, { key: "NICK", label: { text: "Nick", escaped: false, truncated: false }, kind: "string", required: false, sensitive: false, defaultPresent: false, constraints: {}, state: "missing" }];
    state = pluginInstallReducer(state, { type: "session-opened", session: { ...session, fields: withOptional } as never });
    state = pluginInstallReducer(state, { type: "set-value", key: "ROOT", value: "/audit" });
    expect(state.focus).toBe("continue");
    // Choosing to fill an optional value afterwards must not bounce the user.
    state = pluginInstallReducer(state, { type: "focus", focus: Object.freeze({ field: "NICK" }) });
    state = pluginInstallReducer(state, { type: "set-value", key: "NICK", value: "demo" });
    expect(state.focus).toEqual({ field: "NICK" });
  });

  it("keeps the focused control inside the visible window", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "session-opened", session: trustedInstallFlowFixture.states.missingInput.session });
    state = pluginInstallReducer(state, { type: "toggle-disclosure", key: "executable" });
    state = pluginInstallReducer(state, { type: "focus", focus: "continue" });
    // A short viewport over an expanded disclosure must still reveal the focused Add action.
    const lines = renderPluginInstall({ state, width: 60, height: 8, theme });
    expect(lines.join("\n")).toContain("Add plugin");
  });

  it("clears exact consent and retained values whenever authority becomes stale", () => {
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "session-opened", session: trustedInstallFlowFixture.states.missingInput.session });
    state = pluginInstallReducer(state, { type: "set-value", key: "ROOT", value: "/audit" });
    state = pluginInstallReducer(state, { type: "consent", consentId: trustedInstallFlowFixture.configureTrust.consent.consentId });
    expect(state.consentId).toBeDefined();
    state = pluginInstallReducer(state, { type: "activation-result", result: trustedInstallFlowFixture.states.candidateStale });
    expect(state.consentId).toBeUndefined();
    expect(state.values).toEqual({});
    expect(state.session).toBeUndefined();
    expect(state.step).toBe("activation-result");

    state = pluginInstallReducer(state, { type: "authority-stale" });
    expect(state.step).toBe("choose-inspect");
  });

  it("routes owner-provided workflow recovery back through renewed configuration and trust", () => {
    const session = trustedInstallFlowFixture.states.missingInput.session;
    const retry = TrustedInstallActivationResultSchema.parse({
      kind: "recovery-required",
      action: "retry-trust-recovery",
      session,
      progress: [],
      retained: { configuration: true, trust: false },
    });
    let state = createPluginInstallState(trustedInstallFlowFixture.chooseInspect);
    state = pluginInstallReducer(state, { type: "session-opened", session });
    state = pluginInstallReducer(state, { type: "activation-result", result: retry });
    expect(renderPluginInstall({ state, width: 72, height: 20, theme }).join("\n")).toContain("Review recovery configuration");
    state = pluginInstallReducer(state, { type: "session-opened", session: retry.session!, submission: "recover" });
    expect(state).toMatchObject({ step: "configure-trust", submission: "recover" });
    expect(state.consentId).toBeUndefined();
    expect(renderPluginInstall({ state, width: 72, height: 20, theme }).join("\n")).toContain("Finish setup");
  });
});
