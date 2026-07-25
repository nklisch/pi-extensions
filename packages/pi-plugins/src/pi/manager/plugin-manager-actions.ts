import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { NativeControlEnvelope } from "../../application/native-control-contract.js";
import type { NativeControlFrame } from "../../application/native-control-progress.js";
import type { NativeControlInputPort } from "../../application/ports/native-control-input.js";
import type {
  NativeControlExecutionReport,
  NativeControlFrameSink,
} from "../../application/ports/native-control-execution.js";
import type {
  PiManagerHandoffTicket,
  PiManagerReloadHandoff,
  PluginManagerDestination,
} from "../pi-manager-reload-handoff.js";
import { nativeControlArgv } from "./plugin-manager-commands.js";
import { createPiManagerFrameSink } from "./pi-manager-frame-sink.js";
import type { PluginManagerRow } from "./plugin-manager-model.js";

export type PluginManagerActionIntent =
  | Readonly<{ action: "enable" | "disable" | "update"; row: PluginManagerRow }>
  | Readonly<{ action: "uninstall-delete"; row: PluginManagerRow }>
  | Readonly<{ action: "install-open" | "install-run"; row: PluginManagerRow; snapshotId: string; detailId: string }>
  | Readonly<{ action: "install-apply" | "install-recover"; token: string }>
  | Readonly<{ action: "marketplace-add"; source: string; sourceKind?: "github" | "git" | "local-git"; ref?: string }>
  | Readonly<{ action: "diagnose-host" }>
  | Readonly<{ action: "marketplace-refresh" | "marketplace-remove"; row: PluginManagerRow }>
  | Readonly<{ action: "notice-acknowledge"; row: PluginManagerRow }>
  | Readonly<{ action: "update-all" }>
  | Readonly<{ action: "project-sync"; mode: "apply-intent" | "publish-intent" | "merge" }>
  | Readonly<{ action: "operation-status" | "operation-cancel"; token: string }>;

type ConfirmedPluginManagerActionIntent =
  | Readonly<{ action: "uninstall-delete"; row: PluginManagerRow }>
  | Readonly<{ action: "marketplace-remove"; row: PluginManagerRow }>
  | Readonly<{ action: "project-sync"; mode: "apply-intent" | "publish-intent" | "merge" }>;

export type PluginManagerActionConfirmation = Readonly<{
  action: "uninstall-delete" | "marketplace-remove" | "project-sync";
  title: string;
  lines: readonly string[];
  destructive: boolean;
}>;

export type PluginManagerMutationExecutionOptions = Readonly<{
  input?: NativeControlInputPort;
  sink: NativeControlFrameSink;
}>;
export type PluginManagerMutationExecutor = (
  argv: readonly string[],
  options: PluginManagerMutationExecutionOptions,
  signal: AbortSignal,
) => Promise<NativeControlExecutionReport>;

export type PluginManagerActionResult =
  | Readonly<{ kind: "completed"; envelope: NativeControlEnvelope; presentation: "local" | "successor" }>
  | Readonly<{ kind: "cancelled"; presentation: "local" }>;

export interface PluginManagerActionRunner {
  run(intent: PluginManagerActionIntent): Promise<PluginManagerActionResult>;
  cancel(): void;
  close(reason?: SessionShutdownEvent["reason"]): void;
}

function exactRow(row: PluginManagerRow): Readonly<{ plugin: string; scope: "user" | "project"; snapshotId: string; detailId: string }> {
  if (row.plugin === undefined || row.scope === undefined || row.key.snapshotId === undefined || row.key.detailId === undefined) {
    throw new TypeError("manager action requires exact current facade evidence");
  }
  return { plugin: row.plugin, scope: row.scope, snapshotId: row.key.snapshotId, detailId: row.key.detailId };
}

function needsConfirmation(intent: PluginManagerActionIntent): intent is ConfirmedPluginManagerActionIntent {
  return intent.action === "uninstall-delete" || intent.action === "marketplace-remove" || intent.action === "project-sync";
}

export function pluginManagerActionConfirmation(intent: ConfirmedPluginManagerActionIntent): PluginManagerActionConfirmation {
  if (intent.action === "project-sync") {
    const sentence = intent.mode === "apply-intent"
      ? "Install and remove this project's plugins to match its declared intent."
      : intent.mode === "publish-intent"
        ? "Record this project's current plugins as its declared intent."
        : "Resolve the competing declared plugin intents for this project.";
    return Object.freeze({
      action: intent.action,
      title: "Synchronize project plugins?",
      lines: Object.freeze([sentence]),
      destructive: true,
    });
  }
  if (intent.action === "marketplace-remove") {
    return Object.freeze({
      action: intent.action,
      title: `Remove marketplace ${intent.row.title}?`,
      lines: Object.freeze([
        ...(intent.row.subtitle.length === 0 ? [] : [intent.row.subtitle]),
        "Plugins installed from it stay installed; they stop receiving update checks.",
      ]),
      destructive: true,
    });
  }
  const row = exactRow(intent.row);
  return Object.freeze({
    action: intent.action,
    title: `Remove ${row.plugin}?`,
    lines: Object.freeze([
      `scope: ${row.scope}`,
      "This uninstalls the plugin and erases its saved data. To keep the data, disable it instead.",
    ]),
    destructive: true,
  });
}

function actionArgv(intent: PluginManagerActionIntent, confirmed: boolean): readonly string[] {
  if (intent.action === "enable" || intent.action === "disable" || intent.action === "update") {
    const row = exactRow(intent.row);
    return nativeControlArgv(`lifecycle.${intent.action}`, [row.plugin], {
      scope: row.scope,
      snapshotId: row.snapshotId,
      detailId: row.detailId,
      confirmed,
    });
  }
  if (intent.action === "uninstall-delete") {
    const row = exactRow(intent.row);
    // Removal always deletes persistent data; keeping data behind is what
    // Disable is for.
    return nativeControlArgv("lifecycle.uninstall", [row.plugin], {
      scope: row.scope,
      snapshotId: row.snapshotId,
      detailId: row.detailId,
      confirmed,
      deleteData: true,
    });
  }
  if (intent.action === "install-open" || intent.action === "install-run") {
    if (intent.row.plugin === undefined || intent.row.scope === undefined) throw new TypeError("install requires exact plugin scope");
    return nativeControlArgv(intent.action === "install-open" ? "install.open" : "install.run", [intent.row.plugin], {
      scope: intent.row.scope,
      snapshotId: intent.snapshotId,
      detailId: intent.detailId,
    });
  }
  if (intent.action === "install-apply" || intent.action === "install-recover") {
    return nativeControlArgv(intent.action === "install-apply" ? "install.apply" : "install.recover", [intent.token]);
  }
  if (intent.action === "diagnose-host") return nativeControlArgv("inspection.diagnose");
  if (intent.action === "marketplace-add") {
    return nativeControlArgv("marketplace.add", [intent.source], { sourceKind: intent.sourceKind, ref: intent.ref });
  }
  if (intent.action === "marketplace-refresh") {
    return nativeControlArgv("marketplace.refresh", [intent.row.key.key]);
  }
  if (intent.action === "marketplace-remove") {
    return nativeControlArgv("marketplace.remove", [intent.row.key.key], { confirmed });
  }
  if (intent.action === "notice-acknowledge") {
    const ids = intent.row.unreadNoticeIds;
    return nativeControlArgv("updates.notices.acknowledge", ids !== undefined && ids.length > 0 ? [...ids] : [intent.row.key.key]);
  }
  if (intent.action === "update-all") return nativeControlArgv("updates.automatic.run", [], { limit: 100, explicit: true });
  if (intent.action === "project-sync") return nativeControlArgv("project.sync", [], { mode: intent.mode, confirmed });
  if (intent.action === "operation-status" || intent.action === "operation-cancel") {
    return nativeControlArgv(intent.action === "operation-status" ? "operation.status" : "operation.cancel", [intent.token]);
  }
  throw new TypeError("unsupported plugin manager action");
}

function destination(intent: PluginManagerActionIntent): PluginManagerDestination {
  return intent.action === "install-apply" || intent.action === "install-recover" || intent.action === "install-run" ? "install-result" : "operation-result";
}

function activating(intent: PluginManagerActionIntent): boolean {
  return ["enable", "disable", "update", "update-all", "uninstall-delete", "install-run", "install-apply", "install-recover", "project-sync"].includes(intent.action);
}

/** One foreground facade mutation with fresh confirmation, exact frame, abort, and reload semantics. */
export function createPluginManagerActionRunner(input: Readonly<{
  execute: PluginManagerMutationExecutor;
  input?: NativeControlInputPort;
  sink?: NativeControlFrameSink;
  confirm?: (confirmation: PluginManagerActionConfirmation, signal: AbortSignal) => Promise<boolean>;
  handoff?: Pick<PiManagerReloadHandoff, "open" | "publish" | "fail">;
  session?: Readonly<{ sessionId: string; cwd: string }>;
  onFrame?(frame: NativeControlFrame): void;
  onStale?(envelope: NativeControlEnvelope): void;
}>): PluginManagerActionRunner {
  let active: AbortController | undefined;
  let activeInput: (NativeControlInputPort & { cancel?: () => void }) | undefined;
  let activeIsActivating = false;
  let admitted = false;
  let closed = false;

  const runner: PluginManagerActionRunner = {
    async run(intent): Promise<PluginManagerActionResult> {
      if (closed) throw new Error("plugin manager action runner is closed");
      if (active !== undefined) throw new Error("a plugin manager mutation is already running");
      const controller = new AbortController();
      active = controller;
      activeIsActivating = activating(intent);
      admitted = false;
      let ticket: PiManagerHandoffTicket | undefined;
      try {
        // Routine reversible actions are authorized directly by the explicit
        // action keypress. Reserve a second prompt for destructive deletion.
        let confirmed = !needsConfirmation(intent);
        if (needsConfirmation(intent)) {
          if (input.confirm === undefined) throw new Error("plugin manager action requires a fresh presentation confirmation");
          confirmed = await input.confirm(pluginManagerActionConfirmation(intent), controller.signal);
          if (!confirmed || controller.signal.aborted) return Object.freeze({ kind: "cancelled", presentation: "local" });
        }
        if (activeIsActivating && input.handoff !== undefined && input.session !== undefined) {
          ticket = input.handoff.open({ ...input.session, destination: destination(intent) });
        }
        admitted = true;
        activeInput = input.input;
        const report = await input.execute(actionArgv(intent, confirmed), {
          sink: createPiManagerFrameSink({ ...(input.onFrame === undefined ? {} : { onFrame: input.onFrame }), ...(input.sink === undefined ? {} : { delegate: input.sink }) }),
          ...(input.input === undefined ? {} : { input: input.input }),
        }, controller.signal);
        if (report.envelope.status === "stale" || report.envelope.status === "conflict") input.onStale?.(report.envelope);
        const presentation = ticket === undefined || input.handoff === undefined
          ? "local" as const
          : input.handoff.publish(ticket, report);
        return Object.freeze({ kind: "completed", envelope: report.envelope, presentation });
      } catch (error) {
        if (ticket !== undefined && input.handoff !== undefined) {
          try { input.handoff.fail(ticket, error); } catch { /* preserve facade/owner failure */ }
        }
        throw error;
      } finally {
        if (active === controller) active = undefined;
        activeInput = undefined;
        activeIsActivating = false;
        admitted = false;
      }
    },
    cancel(): void {
      if (active === undefined || active.signal.aborted) return;
      activeInput?.cancel?.();
      active.abort(new DOMException("manager operation cancelled", "AbortError"));
    },
    close(reason = "quit"): void {
      if (closed) return;
      closed = true;
      // Reload is special: the admitted activation owns a plain-data handoff
      // result for the successor and must outlive predecessor UI disposal.
      if (reason === "reload" && admitted && activeIsActivating) return;
      runner.cancel();
    },
  };
  return Object.freeze(runner);
}
