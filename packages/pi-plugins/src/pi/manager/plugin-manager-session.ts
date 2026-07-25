import type {
  ExtensionCommandContext,
  ExtensionContext,
  SessionShutdownEvent,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import { NativeInspectionDetailResultSchema } from "../../application/native-inspection-contract.js";
import {
  NativeUpdatePolicyApplyResultSchema,
  NativeUpdatePolicyPreviewResultSchema,
  NativeUpdateStatusSchema,
} from "../../application/native-update-contract.js";
import type { UpdateCadence } from "../../domain/update-policy.js";
import type { NativeControlDynamicCandidate } from "../../application/native-control-help.js";
import type { NativeControlEnvelope } from "../../application/native-control-contract.js";
import type { NativeControlExecutionReport, NativeControlFrameSink } from "../../application/ports/native-control-execution.js";
import type { NativeControlFrame } from "../../application/native-control-progress.js";
import {
  TrustedInstallActivationResultSchema,
  TrustedInstallOpenResultSchema,
} from "../../application/trusted-install-contract.js";
import type { PackagedPluginHost } from "../../composition/packaged-plugin-host-contract.js";
import type { PluginManagerLiveOperation, PluginManagerPresentation } from "../plugin-command.js";
import type { PiManagerReloadHandoff, PluginManagerDestination } from "../pi-manager-reload-handoff.js";
import { nativeControlHumanLines } from "../native-control-human.js";
import { plainLifecycleFailure } from "../plain-language.js";
import { ConfirmationSurface, presentConfirmationSurface } from "./confirmation-surface.js";
import { createPiControlInputPort, type PiInlinePresenter } from "./pi-control-input.js";
import { createPiManagerFrameSink } from "./pi-manager-frame-sink.js";
import { PluginInstallComponent, type PluginInstallComponentAction } from "./plugin-install-component.js";
import { createPluginInstallState, pluginInstallReducer, type PluginInstallEvent } from "./plugin-install-flow.js";
import {
  createPluginManagerActionRunner,
  type PluginManagerActionConfirmation,
  type PluginManagerActionIntent,
  type PluginManagerActionRunner,
} from "./plugin-manager-actions.js";
import { PluginManagerComponent, type PluginManagerCloseResult } from "./plugin-manager-component.js";
import { detailCommand, updatePolicySetCommand, updateStatusCommand, type UpdatePolicySetChange } from "./plugin-manager-commands.js";
import { createPluginManagerController, type PluginManagerController } from "./plugin-manager-controller.js";
import { pluginManagerVisibleRows, rowKeyIdentity, type PluginManagerRow, type PluginManagerState } from "./plugin-manager-model.js";
import { PluginOperationView } from "./plugin-operation-view.js";
import { TextInputSurface } from "./text-input-surface.js";

export interface PluginManagerSession extends PluginManagerPresentation {
  bind(context: ExtensionContext): void;
  presentHandoff(context: ExtensionContext, destination: PluginManagerDestination, envelope: NativeControlEnvelope): Promise<void>;
}

function handoffInstallSummary(envelope: NativeControlEnvelope): string {
  const activation = TrustedInstallActivationResultSchema.safeParse(envelope.data);
  if (activation.success && activation.data.kind === "succeeded") {
    return `✓ Added ${activation.data.plugin} · session reloaded`;
  }
  if (activation.success && activation.data.kind === "current-state") {
    return `✓ ${activation.data.plugin} already added · session reloaded`;
  }
  return `✓ ${nativeControlHumanLines(envelope)[0] ?? "Plugin added"} · session reloaded`;
}

function selectedRow(state: PluginManagerState): PluginManagerRow | undefined {
  const rows = pluginManagerVisibleRows(state);
  if (state.focus.row === undefined) return rows[0];
  return rows.find((row) => rowKeyIdentity(row.key) === rowKeyIdentity(state.focus.row!)) ?? rows[0];
}

function actionIntent(action: string, state: PluginManagerState): PluginManagerActionIntent {
  if (action === "update-all") return { action };
  const row = selectedRow(state);
  if (row === undefined) throw new TypeError("plugin manager action requires a selected row");
  if (action === "enable" || action === "disable" || action === "update") return { action, row };
  if (action === "uninstall-delete") return { action, row };
  if (action === "marketplace-refresh" || action === "marketplace-remove" || action === "notice-acknowledge") return { action, row };
  if (action === "project-sync-apply") return { action: "project-sync", mode: "apply-intent" };
  if (action === "project-sync-publish") return { action: "project-sync", mode: "publish-intent" };
  if (action === "project-sync-merge") return { action: "project-sync", mode: "merge" };
  if (action === "diagnose-host") return { action };
  throw new TypeError("plugin manager action is unavailable for this row");
}

function linkedAbort(parent: AbortSignal | undefined): Readonly<{ controller: AbortController; dispose(): void }> {
  const controller = new AbortController();
  if (parent === undefined) return Object.freeze({ controller, dispose() {} });
  const abort = () => controller.abort(parent.reason);
  if (parent.aborted) abort(); else parent.addEventListener("abort", abort, { once: true });
  return Object.freeze({ controller, dispose: () => parent.removeEventListener("abort", abort) });
}

/** Own one fresh controller/component/input set per command presentation. */
export function createPluginManagerSession(input: Readonly<{
  host: PackagedPluginHost;
  handoff: PiManagerReloadHandoff;
}>): PluginManagerSession {
  let bound: Readonly<{ sessionId: string; cwd: string }> | undefined;
  let activeController: PluginManagerController | undefined;
  let activeManagerComponent: PluginManagerComponent | undefined;
  let activeRunner: PluginManagerActionRunner | undefined;
  let activeClose: (() => void) | undefined;
  let activeOperationAbort: AbortController | undefined;
  let activeOperationReloadSafe = false;
  let activeOperationPresenter: PiInlinePresenter | undefined;
  let presentationDetached = false;
  let closingReason: SessionShutdownEvent["reason"] | undefined;
  let completions: readonly NativeControlDynamicCandidate[] = Object.freeze([]);
  let closed = false;

  function execute(context: ExtensionCommandContext, argv: readonly string[], options: Readonly<{ sink: NativeControlFrameSink; input?: ReturnType<typeof createPiControlInputPort> }>, signal: AbortSignal): Promise<NativeControlExecutionReport> {
    return input.host.runWithPiOperationContext(context, signal, (application) =>
      application.control.runArgv(argv, { mode: "tui", output: "json", sink: options.sink, ...(options.input === undefined ? {} : { input: options.input }) }, signal));
  }

  function currentPresenter(): PiInlinePresenter | undefined {
    if (activeManagerComponent !== undefined) return activeManagerComponent;
    return activeOperationPresenter;
  }

  function freshRunner(context: ExtensionCommandContext, options: Readonly<{
    input?: ReturnType<typeof createPiControlInputPort>;
    onFrame?(frame: NativeControlFrame): void;
    confirm?: boolean;
  }> = {}): PluginManagerActionRunner {
    const runner = createPluginManagerActionRunner({
      execute: (argv, executionOptions, signal) => execute(context, argv, { sink: executionOptions.sink, ...(executionOptions.input === undefined ? {} : { input: executionOptions.input as ReturnType<typeof createPiControlInputPort> }) }, signal),
      ...(options.input === undefined ? {} : { input: options.input }),
      handoff: input.handoff,
      session: { sessionId: context.sessionManager.getSessionId(), cwd: context.cwd },
      ...(options.onFrame === undefined ? {} : { onFrame: options.onFrame }),
      ...(options.confirm === true ? {
        confirm: (confirmation: PluginManagerActionConfirmation, signal: AbortSignal) => {
          const presenter = currentPresenter();
          if (presenter !== undefined) {
            return presenter.presentInline<boolean>((tui, theme, keybindings, done) => new ConfirmationSurface({
              theme,
              keybindings,
              title: confirmation.title,
              lines: confirmation.lines,
              height: () => tui.terminal.rows,
              done,
            })).then((confirmed) => confirmed === true);
          }
          return presentConfirmationSurface(context, {
            title: confirmation.title,
            lines: confirmation.lines,
          }, signal);
        },
      } : {}),
    });
    activeRunner = runner;
    return runner;
  }

  async function replaceActive(reason: SessionShutdownEvent["reason"] = "new"): Promise<void> {
    activeClose?.();
    activeClose = undefined;
    if (activeController !== undefined) {
      completions = activeController.dynamicCompletions();
      await activeController.close(reason);
      activeController = undefined;
    }
    activeRunner?.close(reason);
    activeRunner = undefined;
    if (activeOperationAbort !== undefined && !(reason === "reload" && activeOperationReloadSafe)) {
      activeOperationAbort.abort(new DOMException("plugin presentation replaced", "AbortError"));
    }
  }

  // Pi's own ui.select/ui.input cannot receive keystrokes while a custom
  // component owns the keyboard, so interactive prompts inside the manager
  // are presented inline like every other manager surface.
  async function promptChoice(
    context: ExtensionCommandContext,
    title: string,
    labels: readonly string[],
  ): Promise<number | undefined> {
    const manager = activeManagerComponent;
    if (manager === undefined) {
      const selected = await context.ui.select(title, [...labels]);
      const index = selected === undefined ? -1 : labels.findIndex((label) => label === selected);
      return index < 0 ? undefined : index;
    }
    return manager.presentInline<number>((tui, theme, keybindings, done) => {
      let index = 0;
      const component: Component = {
        invalidate(): void {},
        render: () => [
          theme.fg("accent", theme.bold(title)),
          "",
          ...labels.map((label, candidate) => candidate === index ? theme.bg("selectedBg", `→ ${label}`) : `  ${label}`),
          "",
          theme.fg("muted", "up/down choose · enter continue · escape cancel"),
        ],
        handleInput(data): void {
          if (keybindings.matches(data, "tui.select.up")) index = (index - 1 + labels.length) % labels.length;
          else if (keybindings.matches(data, "tui.select.down")) index = (index + 1) % labels.length;
          else if (keybindings.matches(data, "tui.select.confirm") || matchesKey(data, Key.enter)) return done(index);
          else if (keybindings.matches(data, "tui.select.cancel") || keybindings.matches(data, "app.interrupt") || matchesKey(data, Key.escape)) return done();
          manager.invalidate();
          tui.requestRender();
        },
      };
      return component;
    });
  }

  async function promptText(
    context: ExtensionCommandContext,
    label: string,
    description?: string,
  ): Promise<string | undefined> {
    const manager = activeManagerComponent;
    if (manager === undefined) return context.ui.input(label, description);
    return manager.presentInline<string>((tui, theme, keybindings, done) => new TextInputSurface({
      theme,
      keybindings,
      label,
      ...(description === undefined ? {} : { description }),
      done: (value) => done(value),
    }));
  }

  async function confirmInline(context: ExtensionCommandContext, title: string, lines: readonly string[]): Promise<boolean> {
    const presenter = currentPresenter();
    if (presenter !== undefined) {
      const confirmed = await presenter.presentInline<boolean>((tui, theme, keybindings, done) => new ConfirmationSurface({
        theme,
        keybindings,
        title,
        lines,
        height: () => tui.terminal.rows,
        done,
      }));
      return confirmed === true;
    }
    return presentConfirmationSurface(context, { title, lines }, new AbortController().signal);
  }

  /** One policy change, including the exact consent-preview round trip enabling automatic updates requires. */
  async function runPolicySet(context: ExtensionCommandContext, change: UpdatePolicySetChange): Promise<"applied" | "cancelled" | "failed"> {
    const signal = new AbortController().signal;
    const run = (argv: readonly string[]) => input.host.runWithPiOperationContext(context, signal, (application) =>
      application.control.runArgv(argv, { mode: "tui", output: "json" }, signal));
    let report = await run(updatePolicySetCommand(change));
    const preview = NativeUpdatePolicyPreviewResultSchema.safeParse(report.envelope.data);
    if (preview.success) {
      if (preview.data.kind === "rejected") {
        context.ui.notify(`Update policy change was rejected (${preview.data.code.toLowerCase().replaceAll("_", " ")}).`, "warning");
        return "failed";
      }
      const consent = preview.data.preview.consent;
      if (!consent.required || consent.consentId === undefined) {
        // Unreachable today (the facade only previews when consent is
        // required and always binds its id); fail loudly if that changes.
        context.ui.notify("Update policy preview did not match the public facade contract.", "error");
        return "failed";
      }
      const audience = consent.disclosure === "global-current-and-future" ? "every current and future plugin"
        : consent.disclosure === "scope-current-and-future" ? "current and future plugins in this scope"
          : "the current target";
      const approved = await confirmInline(context,
        change.policyKind === "application" && change.policyMode === "automatic" ? "Turn on automatic updates?" : "Change update policy?",
        [
          `Applies to ${audience}.`,
          "Eligible updates install without asking each time; trust, configuration, and recovery checks still run.",
        ]);
      if (!approved) return "cancelled";
      report = await run(updatePolicySetCommand(change, { previewId: preview.data.preview.previewId, consentId: consent.consentId }));
    }
    const applied = NativeUpdatePolicyApplyResultSchema.safeParse(report.envelope.data);
    if (!applied.success) {
      context.ui.notify("Update policy response did not match the public facade contract.", "error");
      return "failed";
    }
    if (applied.data.kind === "changed" || applied.data.kind === "unchanged") return "applied";
    if (applied.data.kind === "stale") context.ui.notify("Things changed while setting update policy — try again.", "warning");
    else if (applied.data.kind === "rejected") context.ui.notify(`Update policy change was rejected (${applied.data.code.toLowerCase().replaceAll("_", " ")}).`, "warning");
    else context.ui.notify("Update policy change could not complete.", "warning");
    return "failed";
  }

  async function runUpdatePolicyFlow(context: ExtensionCommandContext): Promise<Readonly<{ kind: "cancelled" | "handled"; presentation?: "local" | "successor" }>> {
    const signal = new AbortController().signal;
    let current: Readonly<{ application: "manual" | "automatic"; cadence: UpdateCadence }> | undefined;
    try {
      const report = await input.host.runWithPiOperationContext(context, signal, (application) =>
        application.control.runArgv(updateStatusCommand(), { mode: "tui", output: "json" }, signal));
      const status = NativeUpdateStatusSchema.safeParse(report.envelope.data);
      if (status.success) current = status.data.policy.global;
    } catch { /* an unreadable current policy must not block choosing a new one */ }
    const modeIndex = await promptChoice(context,
      `Automatic updates (currently ${current === undefined ? "unknown" : current.application === "automatic" ? "on" : "off"})`,
      ["On — install eligible updates automatically", "Off — tell me about updates, I'll apply them"]);
    if (modeIndex === undefined) return Object.freeze({ kind: "cancelled" as const });
    const mode = modeIndex === 0 ? "automatic" as const : "manual" as const;
    let cadence: UpdateCadence | undefined;
    if (mode === "automatic") {
      const cadences = [
        { value: "balanced" as const, label: "Every 6 hours (balanced)" },
        { value: "conservative" as const, label: "Once a day (conservative)" },
        { value: "frequent" as const, label: "Every hour (frequent)" },
        { value: "paused" as const, label: "Never check (paused)" },
      ];
      const cadenceIndex = await promptChoice(context, `How often should Pi check? (currently ${current?.cadence ?? "unknown"})`, cadences.map((entry) => entry.label));
      if (cadenceIndex === undefined) return Object.freeze({ kind: "cancelled" as const });
      cadence = cadences[cadenceIndex]!.value;
    }
    try {
      if (current?.application !== mode) {
        const result = await runPolicySet(context, { policyKind: "application", policyMode: mode });
        if (result === "cancelled") return Object.freeze({ kind: "cancelled" as const });
        if (result === "failed") return Object.freeze({ kind: "handled" as const, presentation: "local" as const });
      }
      if (cadence !== undefined && current?.cadence !== cadence) {
        const result = await runPolicySet(context, { policyKind: "cadence", cadence });
        if (result === "failed") return Object.freeze({ kind: "handled" as const, presentation: "local" as const });
      }
    } catch {
      context.ui.notify("Update policy change could not complete.", "error");
      return Object.freeze({ kind: "handled" as const, presentation: "local" as const });
    }
    context.ui.notify(mode === "automatic" ? `Automatic updates on · ${cadence ?? current?.cadence ?? ""}` : "Automatic updates off — you'll be notified about updates instead", "info");
    return Object.freeze({ kind: "handled" as const, presentation: "local" as const });
  }

  async function chooseInstallScope(
    context: ExtensionCommandContext,
    manager: PluginManagerComponent | undefined,
    scopes: readonly ("user" | "project")[],
  ): Promise<"user" | "project" | undefined> {
    const labels = scopes.map((scope) => scope === "project" ? "Current project" : "User account");
    const index = await promptChoice(context, "Add plugin to", labels);
    return index === undefined ? undefined : scopes[index];
  }

  async function runInstallFlow(context: ExtensionCommandContext, managerState: PluginManagerState): Promise<Readonly<{ kind: "cancelled" | "handled"; presentation?: "local" | "successor" }>> {
    let row = selectedRow(managerState);
    let detail = NativeInspectionDetailResultSchema.safeParse(managerState.detail.envelope?.data);
    const manager = activeManagerComponent;
    if (row === undefined || !detail.success || detail.data.kind !== "found") return Object.freeze({ kind: "cancelled" });
    if (row.availableScopes !== undefined && row.availableScopes.length > 1) {
      const scope = await chooseInstallScope(context, manager, row.availableScopes);
      if (scope === undefined) return Object.freeze({ kind: "cancelled" });
      if (scope !== row.scope) {
        const scopedRow = Object.freeze({ ...row, scope });
        const argv = detailCommand(scopedRow);
        if (argv === undefined) return Object.freeze({ kind: "cancelled" });
        const signal = new AbortController().signal;
        const report = await input.host.runWithPiOperationContext(context, signal, (application) =>
          application.control.runArgv(argv, { mode: "tui", output: "json" }, signal));
        detail = NativeInspectionDetailResultSchema.safeParse(report.envelope.data);
        if (!detail.success || detail.data.kind !== "found") return Object.freeze({ kind: "cancelled" });
        row = scopedRow;
      }
    }
    const candidateDetail = detail.data.detail;
    let state = createPluginInstallState(candidateDetail);
    let component: PluginInstallComponent | undefined;
    let currentRunner: PluginManagerActionRunner | undefined;
    let result: Readonly<{ kind: "cancelled" | "handled"; presentation?: "local" | "successor" }> = Object.freeze({ kind: "cancelled" });
    const present = manager === undefined ? context.ui.custom.bind(context.ui) : manager.presentInline.bind(manager);

    await present<void>((tui, theme, keybindings, done) => {
      const apply = (event: PluginInstallEvent): void => {
        state = pluginInstallReducer(state, event);
        component?.update(state);
        manager?.invalidate();
        tui.requestRender();
      };

      const runPhase = async (phase: "open" | "apply" | "recover"): Promise<void> => {
        if (state.busy) return;
        apply({ type: "busy", value: true });
        const port = phase === "open"
          ? undefined
          : createPiControlInputPort({ context, mode: "tui", preset: { nonSensitive: state.values, ...(state.consentId === undefined ? {} : { consentId: state.consentId }) }, present: currentPresenter });
        const runner = freshRunner(context, {
          ...(port === undefined ? {} : { input: port }),
          onFrame: (frame) => {
            if (!presentationDetached) apply({ type: "frame", frame });
          },
        });
        currentRunner = runner;
        try {
          if (phase === "open") {
            const phaseResult = await runner.run({
              action: "install-open",
              row,
              snapshotId: candidateDetail.snapshotId,
              detailId: candidateDetail.summary.detailId,
            });
            if (phaseResult.kind === "cancelled") {
              apply({ type: "busy", value: false });
              return;
            }
            const opened = TrustedInstallOpenResultSchema.safeParse(phaseResult.envelope.data);
            if (!opened.success || opened.data.kind !== "opened") {
              context.ui.notify("Install candidate evidence changed; review the refreshed candidate before continuing.", "warning");
              // Leave the flow so the manager can refresh authority behind it;
              // retrying with the same stale evidence would loop.
              result = Object.freeze({ kind: "handled", presentation: "local" });
              done();
              return;
            }
            apply({ type: "session-opened", session: opened.data.session });
            return;
          }

          const session = state.session;
          if (session === undefined || state.consentId !== session.consent.consentId) {
            apply({ type: "busy", value: false });
            return;
          }
          const phaseResult = await runner.run({ action: phase === "recover" ? "install-recover" : "install-apply", token: session.token });
          if (phaseResult.kind === "cancelled") {
            apply({ type: "busy", value: false });
            return;
          }
          if (phaseResult.presentation === "successor") {
            result = Object.freeze({ kind: "handled", presentation: "successor" });
            // Reload teardown already closed the predecessor custom component.
            // Calling its done callback here would reuse stale Pi/TUI state.
            return;
          }
          const activation = TrustedInstallActivationResultSchema.safeParse(phaseResult.envelope.data);
          if (!activation.success) {
            apply({ type: "busy", value: false });
            const diagnostic = phaseResult.envelope.diagnostics[0]?.code;
            context.ui.notify(`Install result did not match the public facade contract (${phaseResult.envelope.status}${diagnostic === undefined ? "" : ` · ${diagnostic}`}).`, "error");
            return;
          }
          if (activation.data.kind === "needs-input") {
            apply({ type: "session-opened", session: activation.data.session, submission: phase === "recover" ? "recover" : "apply" });
            context.ui.notify("Configuration or exact consent needs renewed input.", "warning");
            return;
          }
          if (activation.data.kind === "recovery-required") {
            // The only result that still earns the screen: it carries the
            // actionable recovery path. Everything else closes the flow and
            // lets the manager refresh flip the row behind us.
            apply({ type: "activation-result", result: activation.data });
            return;
          }
          result = Object.freeze({ kind: "handled", presentation: "local" });
          if (activation.data.kind === "succeeded") {
            context.ui.notify(`Added ${activation.data.plugin} · ${activation.data.components.skills} skills · ${activation.data.components.hooks} hooks · ${activation.data.components.mcpServers} MCP servers`, "info");
            if (candidateDetail.compatibility.components.foreign.some((component) => component.nativeKind.text === "pi-extension")) {
              context.ui.notify(`Heads up: ${activation.data.plugin} also ships a Pi extension (tools/commands), which this host doesn't run — those won't register. Install it pi-natively to use them.`, "warning");
            }
          } else if (activation.data.kind === "current-state") {
            context.ui.notify(`${activation.data.plugin} is already added`, "info");
          } else if (activation.data.kind === "rolled-back") {
            context.ui.notify(`Couldn't add it — ${plainLifecycleFailure(activation.data.failure)}. The change was undone${activation.data.restored ? "" : "; check /plugin → Health for what's left pending"}.`, "error");
          } else if (activation.data.kind === "cancelled") {
            context.ui.notify("Add cancelled — nothing was installed.", "warning");
          } else if (activation.data.kind === "rejected") {
            context.ui.notify(`Adding was rejected — ${plainLifecycleFailure(activation.data.code)}.`, "error");
          } else {
            context.ui.notify("Things changed while installing — press a to try again.", "warning");
          }
          done();
          return;
        } catch (error) {
          if (closingReason === "reload" || closed) return;
          apply({ type: "busy", value: false });
          context.ui.notify(error instanceof DOMException && error.name === "AbortError" ? "Install cancellation is waiting for owner truth." : "Install flow could not complete.", "warning");
        } finally {
          port?.dispose();
          runner.close(closingReason ?? "quit");
          if (currentRunner === runner) currentRunner = undefined;
          if (activeRunner === runner) activeRunner = undefined;
        }
      };

      const action = (event: PluginInstallComponentAction): void => {
        if (event.type === "cancel") {
          currentRunner?.cancel();
          return;
        }
        if (event.type === "edit-field") {
          // Non-sensitive values edit in place inside the component; only the
          // sensitive path routes here because secrets never enter flow state.
          if (event.sensitive) {
            context.ui.notify("Sensitive values stay out of flow state and are collected in masked custody only when Apply begins.", "info");
          }
          return;
        }
        if (event.type === "back") {
          if (state.busy) return;
          if (state.step === "activation-result") {
            result = Object.freeze({ kind: "handled", presentation: "local" });
          } else {
            // The flattened flow has no review screen to fall back to; Back
            // from configuration exits the flow like Back from the open step.
            result = Object.freeze({ kind: "cancelled" });
          }
          done();
          return;
        }
        if (state.step === "activation-result") {
          const activation = state.result;
          if (activation?.kind === "recovery-required" && activation.action !== "run-recovery" && activation.session !== undefined) {
            apply({ type: "session-opened", session: activation.session, submission: "recover" });
            return;
          }
          result = Object.freeze({ kind: "handled", presentation: "local" });
          done();
        } else void runPhase(state.step === "choose-inspect" ? "open" : state.submission);
      };

      component = new PluginInstallComponent({ state, theme, keybindings, height: () => manager === undefined ? tui.terminal.rows : Math.max(4, tui.terminal.rows - 3), onEvent: apply, onAction: action });
      if (manager === undefined) activeClose = () => done();
      // The candidate was already reviewed in the manager detail pane; open
      // the install session immediately instead of staging a review screen.
      queueMicrotask(() => action({ type: "continue" }));
      return component;
    });
    if (manager === undefined) activeClose = undefined;
    currentRunner?.close(closingReason ?? "quit");
    return result;
  }

  async function open(context: ExtensionCommandContext): Promise<void> {
    if (closed) return;
    await replaceActive("new");
    let controller!: PluginManagerController;
    const read = (argv: readonly string[], signal: AbortSignal) => input.host.runWithPiOperationContext(context, signal, (application) =>
      application.control.runArgv(argv, { mode: "tui", output: "json" }, signal));
    const actions = {
      async run(action: string, state: PluginManagerState) {
        if (action === "install") return runInstallFlow(context, state);
        if (action === "update-policy") return runUpdatePolicyFlow(context);
        let resolvedIntent: PluginManagerActionIntent;
        if (action === "marketplace-add") {
          const sourceKinds = ["github", "git", "local-git"] as const;
          const typeIndex = await promptChoice(context, "Marketplace type", ["GitHub repository", "Git URL", "Local Git checkout"]);
          if (typeIndex === undefined) return Object.freeze({ kind: "cancelled" as const, presentation: "local" as const });
          const sourceKind = sourceKinds[typeIndex]!;
          const placeholder = sourceKind === "github" ? "owner/repository" : sourceKind === "git" ? "https://example.com/plugins.git" : "/path/to/plugins";
          const source = await promptText(context, "Marketplace location", placeholder);
          if (source === undefined || source.trim().length === 0) return Object.freeze({ kind: "cancelled" as const, presentation: "local" as const });
          const ref = await promptText(context, "Git ref (optional)", "branch, tag, or commit; leave empty for default");
          if (ref === undefined) return Object.freeze({ kind: "cancelled" as const, presentation: "local" as const });
          resolvedIntent = { action: "marketplace-add", source: source.trim(), sourceKind, ...(ref.trim().length === 0 ? {} : { ref: ref.trim() }) };
        } else resolvedIntent = actionIntent(action, state);
        const port = createPiControlInputPort({ context, mode: "tui", present: currentPresenter });
        const runner = freshRunner(context, {
          input: port,
          confirm: true,
          onFrame: (frame) => {
            if (!presentationDetached) controller.observe({ type: "frame", frame });
          },
        });
        try { return await runner.run(resolvedIntent); }
        finally {
          port.dispose();
          runner.close(closingReason ?? "quit");
          if (activeRunner === runner) activeRunner = undefined;
        }
      },
      cancel(): void { activeRunner?.cancel(); },
    };
    controller = createPluginManagerController({ execute: read, actions });
    activeController = controller;
    // Mount first: facade reads may touch several local stores and should never
    // leave a command invocation looking frozen. The reducer publishes loading
    // state synchronously and authoritative results replace it in place.
    void controller.refresh("all");
    try {
      await context.ui.custom<PluginManagerCloseResult>((tui, theme, keybindings, done) => {
        const component = new PluginManagerComponent({ tui, theme, keybindings, controller, done });
        activeManagerComponent = component;
        activeClose = () => component.requestClose();
        return component;
      });
      activeClose = undefined;
    } catch {
      if (!presentationDetached) context.ui.notify("Plugin manager terminal rendering failed; facade state is unchanged.", "error");
    } finally {
      if (activeController === controller) {
        completions = controller.dynamicCompletions();
        await controller.close(closingReason ?? "quit");
        activeController = undefined;
      }
      activeManagerComponent = undefined;
      activeClose = undefined;
    }
  }

  async function presentStaticOperation(context: ExtensionContext, envelope: NativeControlEnvelope, frames: readonly NativeControlFrame[], title = "Plugin operation"): Promise<void> {
    if (context.mode !== "tui" || closed) return;
    await replaceActive("new");
    try {
      await context.ui.custom<void>((tui, theme, keybindings, done) => {
        const view = new PluginOperationView({ theme, keybindings, height: () => tui.terminal.rows, title, cancel: () => {}, close: () => done() });
        for (const frame of frames) view.push(frame);
        view.finish(envelope);
        activeClose = () => done();
        return view;
      });
    } catch {
      if (!presentationDetached) context.ui.notify(`Plugin operation ${envelope.status}; custom renderer unavailable.`, envelope.exit.code === 0 ? "info" : "error");
    } finally {
      activeClose = undefined;
    }
  }

  async function presentOperation(context: ExtensionCommandContext, operation: PluginManagerLiveOperation): Promise<void> {
    if (closed) return;
    await replaceActive("new");
    const linked = linkedAbort(operation.signal);
    activeOperationAbort = linked.controller;
    activeOperationReloadSafe = operation.reloadSafe;
    presentationDetached = false;
    let task: Promise<void> | undefined;
    let failure: unknown;
    try {
      await context.ui.custom<void>((tui, theme, keybindings, done) => {
        const view = new PluginOperationView({
          theme,
          keybindings,
          height: () => tui.terminal.rows,
          cancel: () => linked.controller.abort(new DOMException("plugin command cancelled", "AbortError")),
          close: () => done(),
          tui,
        });
        activeOperationPresenter = Object.freeze({ presentInline: (factory) => view.presentInline(factory) });
        activeClose = () => done();
        task = Promise.resolve().then(async () => {
          const sink = createPiManagerFrameSink({
            onFrame: (frame) => {
              if (presentationDetached) return;
              view.push(frame);
              tui.requestRender();
            },
          });
          try {
            const report = await operation.run(sink, linked.controller.signal);
            const presentation = operation.settle(report);
            if (presentationDetached || presentation === "successor") {
              // session_shutdown already closed the predecessor view. No Pi/TUI
              // callback remains valid once the successor owns presentation.
              return;
            }
            view.finish(report.envelope);
            tui.requestRender();
          } catch (error) {
            failure = error;
            done();
          }
        });
        return view;
      });
      await task;
      if (failure !== undefined) throw failure;
    } finally {
      linked.dispose();
      if (activeOperationAbort === linked.controller) activeOperationAbort = undefined;
      activeOperationReloadSafe = false;
      activeOperationPresenter = undefined;
      activeClose = undefined;
    }
  }

  const session: PluginManagerSession = {
    bind(context): void {
      closed = false;
      closingReason = undefined;
      presentationDetached = false;
      bound = Object.freeze({ sessionId: context.sessionManager.getSessionId(), cwd: context.cwd });
    },
    open,
    presentOperation,
    async presentReport(context: ExtensionCommandContext, report: NativeControlExecutionReport, frames: readonly NativeControlFrame[]): Promise<void> {
      await presentStaticOperation(context, report.envelope, frames);
    },
    async presentHandoff(context, destination, envelope): Promise<void> {
      const current = bound;
      if (current === undefined || current.sessionId !== context.sessionManager.getSessionId() || current.cwd !== context.cwd) return;
      // Success across a reload is one notification, not a result screen: the
      // reload itself is the visible effect, and the next /plugin open shows
      // authoritative state. Failures keep the inspectable operation view.
      if (envelope.status === "ok" || envelope.status === "no-change") {
        if (context.mode === "tui" && !closed) {
          const line = destination === "install-result"
            ? handoffInstallSummary(envelope)
            : `✓ ${nativeControlHumanLines(envelope)[0] ?? "Plugin operation completed"}`;
          context.ui.notify(line, "info");
        }
        return;
      }
      await presentStaticOperation(context, envelope, Object.freeze([]), destination === "install-result" ? "Activation result" : "Plugin operation · successor result");
    },
    dynamicCompletions(): readonly NativeControlDynamicCandidate[] {
      return activeController?.dynamicCompletions() ?? completions;
    },
    inlinePresenter(): PiInlinePresenter | undefined {
      return currentPresenter();
    },
    async close(reason: SessionShutdownEvent["reason"]): Promise<void> {
      if (closed && activeController === undefined && activeClose === undefined) return;
      closed = true;
      closingReason = reason;
      presentationDetached = true;
      activeClose?.();
      activeRunner?.close(reason);
      if (activeOperationAbort !== undefined && !(reason === "reload" && activeOperationReloadSafe)) {
        activeOperationAbort.abort(new DOMException("plugin presentation closed", "AbortError"));
      }
      if (activeController !== undefined) {
        completions = reason === "reload" ? activeController.dynamicCompletions() : Object.freeze([]);
        await activeController.close(reason);
      }
      activeController = undefined;
      activeRunner = undefined;
      activeClose = undefined;
      bound = undefined;
      if (reason !== "reload") completions = Object.freeze([]);
    },
  };
  return Object.freeze(session);
}
