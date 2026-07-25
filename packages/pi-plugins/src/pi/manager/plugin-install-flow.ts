import type {
  TrustedInstallActivationResult,
  TrustedInstallSessionView,
} from "../../application/trusted-install-contract.js";
import type { NativeInspectionDetail } from "../../application/native-inspection-contract.js";
import type { NativeControlFrame } from "../../application/native-control-progress.js";

export type PluginInstallStep = "choose-inspect" | "configure-trust" | "activation-result";
export type PluginInstallFocus = "back" | "continue" | "disclosure" | Readonly<{ field: string }>;

export type PluginInstallState = Readonly<{
  step: PluginInstallStep;
  candidate: NativeInspectionDetail;
  session?: TrustedInstallSessionView;
  result?: TrustedInstallActivationResult;
  disclosure: ReadonlySet<string>;
  consentId?: string;
  values: Readonly<Record<string, unknown>>;
  /** In-place non-sensitive field editing; never a nested surface. */
  editing?: Readonly<{ key: string; buffer: string; cursor: number }>;
  focus: PluginInstallFocus;
  scroll: Readonly<{ content: number; disclosure: number }>;
  submission: "apply" | "recover";
  busy: boolean;
  frames: readonly NativeControlFrame[];
}>;

export type PluginInstallEvent =
  | Readonly<{ type: "session-opened"; session: TrustedInstallSessionView; submission?: "apply" | "recover" }>
  | Readonly<{ type: "activation-result"; result: TrustedInstallActivationResult }>
  | Readonly<{ type: "toggle-disclosure"; key: string }>
  | Readonly<{ type: "consent"; consentId: string }>
  | Readonly<{ type: "set-value"; key: string; value: unknown }>
  | Readonly<{ type: "edit-start"; key: string }>
  | Readonly<{ type: "edit-buffer"; buffer: string; cursor: number }>
  | Readonly<{ type: "edit-end" }>
  | Readonly<{ type: "focus"; focus: PluginInstallFocus }>
  | Readonly<{ type: "scroll"; region: "content" | "disclosure"; delta: number }>
  | Readonly<{ type: "busy"; value: boolean }>
  | Readonly<{ type: "frame"; frame: NativeControlFrame }>
  | Readonly<{ type: "back" }>
  | Readonly<{ type: "authority-stale" }>;

export function createPluginInstallState(candidate: NativeInspectionDetail): PluginInstallState {
  return Object.freeze({
    step: "choose-inspect",
    candidate,
    disclosure: new Set<string>(),
    values: Object.freeze({}),
    focus: "continue",
    scroll: Object.freeze({ content: 0, disclosure: 0 }),
    submission: "apply",
    busy: false,
    frames: Object.freeze([]),
  });
}

export function pluginInstallReducer(state: PluginInstallState, event: PluginInstallEvent): PluginInstallState {
  if (event.type === "session-opened") {
    const evidenceCurrent = state.session === undefined || state.session.consent.consentId === event.session.consent.consentId &&
      state.session.binding.contentDigest === event.session.binding.contentDigest;
    const { result: _result, consentId: _consentId, editing: _editing, ...rest } = state;
    // Land on the first required value when one exists; otherwise land on the
    // primary action. Optional values and the exact disclosure are power-user
    // surface, never a forced gate.
    const required = event.session.fields.find((field) => field.required);
    return Object.freeze({
      ...rest,
      step: "configure-trust",
      session: event.session,
      disclosure: new Set<string>(),
      values: evidenceCurrent ? state.values : Object.freeze({}),
      focus: required === undefined ? "continue" : Object.freeze({ field: required.key }),
      scroll: Object.freeze({ content: 0, disclosure: 0 }),
      submission: event.submission ?? state.submission,
      busy: false,
      frames: Object.freeze([]),
    });
  }
  if (event.type === "activation-result") {
    const { consentId: _consentId, ...rest } = state;
    const stale = event.result.kind === "stale" || event.result.kind === "conflict";
    if (stale) {
      const { session: _session, ...withoutStaleAuthority } = rest;
      return Object.freeze({
        ...withoutStaleAuthority,
        step: "activation-result",
        result: event.result,
        values: Object.freeze({}),
        focus: "continue",
        scroll: Object.freeze({ content: 0, disclosure: 0 }),
        busy: false,
      });
    }
    return Object.freeze({ ...rest, step: "activation-result", result: event.result, focus: "continue", scroll: Object.freeze({ content: 0, disclosure: 0 }), busy: false });
  }
  if (event.type === "toggle-disclosure") {
    const disclosure = new Set(state.disclosure);
    if (disclosure.has(event.key)) disclosure.delete(event.key); else disclosure.add(event.key);
    const { consentId: _consentId, ...rest } = state;
    return Object.freeze({ ...rest, disclosure, scroll: Object.freeze({ ...state.scroll, disclosure: 0 }) });
  }
  if (event.type === "consent") return Object.freeze({ ...state, consentId: event.consentId });
  if (event.type === "set-value") {
    const values = Object.freeze({ ...state.values, [event.key]: event.value });
    // Committing the last outstanding required value lands on the primary
    // action instead of stranding focus on the field just finished. Optional
    // commits never move focus, and sensitive values are collected masked at
    // apply, so they never gate the advance.
    const committed = state.session?.fields.find((field) => field.key === event.key);
    const wasOutstanding = committed !== undefined && committed.required && !committed.sensitive &&
      ["missing", "invalid"].includes(committed.state);
    const awaiting = state.session?.fields.some((field) =>
      field.required && !field.sensitive && ["missing", "invalid"].includes(field.state) && values[field.key] === undefined) === true;
    const focus = wasOutstanding && !awaiting && typeof state.focus !== "string" ? "continue" as const : state.focus;
    return Object.freeze({ ...state, values, focus });
  }
  if (event.type === "edit-start") {
    const current = state.values[event.key];
    const buffer = typeof current === "string" ? current : "";
    return Object.freeze({ ...state, editing: Object.freeze({ key: event.key, buffer, cursor: buffer.length }) });
  }
  if (event.type === "edit-buffer") {
    if (state.editing === undefined) return state;
    return Object.freeze({ ...state, editing: Object.freeze({ ...state.editing, buffer: event.buffer, cursor: event.cursor }) });
  }
  if (event.type === "edit-end") {
    if (state.editing === undefined) return state;
    const { editing: _editing, ...rest } = state;
    return Object.freeze(rest);
  }
  if (event.type === "focus") return Object.freeze({ ...state, focus: event.focus });
  if (event.type === "scroll") return Object.freeze({ ...state, scroll: Object.freeze({ ...state.scroll, [event.region]: Math.max(0, state.scroll[event.region] + event.delta) }) });
  if (event.type === "busy") return Object.freeze({ ...state, busy: event.value, ...(event.value ? { frames: Object.freeze([]) } : {}) });
  if (event.type === "frame") return Object.freeze({ ...state, frames: Object.freeze([...state.frames.slice(-199), event.frame]) });
  if (event.type === "back") {
    if (state.step === "activation-result") return Object.freeze({ ...state, step: state.session === undefined ? "choose-inspect" : "configure-trust", focus: "continue", scroll: Object.freeze({ content: 0, disclosure: 0 }) });
    if (state.step === "configure-trust") {
      const { consentId: _consentId, editing: _editing, ...rest } = state;
      return Object.freeze({ ...rest, step: "choose-inspect", focus: "continue", disclosure: new Set<string>(), scroll: Object.freeze({ content: 0, disclosure: 0 }), busy: false });
    }
    return state;
  }
  if (event.type === "authority-stale") {
    return Object.freeze({ ...createPluginInstallState(state.candidate), values: Object.freeze({}) });
  }
  return state;
}
