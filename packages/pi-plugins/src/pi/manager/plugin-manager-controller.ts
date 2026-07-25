import type { SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import { NativeInspectionDetailResultSchema, NativeInspectionPageSchema } from "../../application/native-inspection-contract.js";
import {
  NativeControlMarketplaceCatalogResponseSchema,
  NativeControlMarketplaceListResponseSchema,
} from "../../application/native-control-safe-projection.js";
import {
  NativeUpdateNotificationPageSchema,
  NativeUpdateStatusSchema,
} from "../../application/native-update-contract.js";
import type { NativeControlDynamicCandidate } from "../../application/native-control-help.js";
import { HostStatusSnapshotSchema } from "../../application/host-observation-contract.js";
import type { NativeControlExecutionReport } from "../../application/ports/native-control-execution.js";
import type { NativeControlEnvelope } from "../../application/native-control-contract.js";
import type { NativeControlFrame } from "../../application/native-control-progress.js";
import type { JsonValue } from "../../domain/schema.js";
import { detailCommand, hostStatusCommand, pageCommand, updateNoticesCommand, updateStatusCommand } from "./plugin-manager-commands.js";
import {
  createPluginManagerState,
  pluginManagerReducer,
  pluginManagerVisibleRows,
  rowKeyIdentity,
  type PluginManagerEvent,
  type PluginManagerIntent,
  type PluginManagerRow,
  type PluginManagerState,
} from "./plugin-manager-model.js";

type PluginManagerControllerActionResult =
  | Readonly<{ kind: "completed"; envelope: NativeControlEnvelope; presentation: "local" | "successor" }>
  | Readonly<{ kind: "cancelled" | "handled"; presentation?: "local" | "successor" }>;

export type PluginManagerControlExecutor = (
  argv: readonly string[],
  signal: AbortSignal,
) => Promise<NativeControlExecutionReport>;

export interface PluginManagerController {
  state(): PluginManagerState;
  dispatch(intent: PluginManagerIntent): void;
  refresh(scope?: "view" | "detail" | "all"): Promise<void>;
  dynamicCompletions(): readonly NativeControlDynamicCandidate[];
  subscribe(listener: (state: PluginManagerState) => void): () => void;
  observe(event: Readonly<{ type: "frame"; frame: NativeControlFrame }> | Readonly<{ type: "operation-cancelling" }>): void;
  idle(): Promise<void>;
  close(reason: SessionShutdownEvent["reason"]): Promise<void>;
}

function safe(text: string) {
  return Object.freeze({ text, escaped: false, truncated: false });
}

function scopeKind(value: unknown): "user" | "project" | undefined {
  if (value !== null && typeof value === "object" && "kind" in value) {
    const kind = (value as { kind?: unknown }).kind;
    if (kind === "user" || kind === "project") return kind;
  }
  return undefined;
}

function installedRows(envelope: NativeControlEnvelope): readonly PluginManagerRow[] | undefined {
  const parsed = NativeInspectionPageSchema.safeParse(envelope.data);
  if (!parsed.success) return undefined;
  return Object.freeze(parsed.data.items.map((item) => {
    const scope = scopeKind(item.scope);
    return Object.freeze({
      key: Object.freeze({ subject: "installed" as const, key: `${scope ?? "unknown"}:${item.plugin}`, snapshotId: parsed.data.snapshotId, detailId: item.detailId }),
      title: item.name.text,
      subtitle: `${item.marketplace.text} · ${scope ?? "unknown scope"}`,
      status: "installed",
      statusTone: item.condition === "ready" ? "success" : item.condition === "degraded" ? "warning" : "error",
      ...(scope === undefined ? {} : { scope }),
      plugin: item.plugin,
      completion: Object.freeze({ category: "plugin" as const, value: item.plugin, safe: item.name }),
      data: item as unknown as JsonValue,
    });
  }));
}

function browseRows(envelope: NativeControlEnvelope): readonly PluginManagerRow[] | undefined {
  const parsed = NativeControlMarketplaceCatalogResponseSchema.safeParse(envelope.data);
  if (!parsed.success) return undefined;
  return Object.freeze(parsed.data.candidates.map((item) => {
    const scope = scopeKind(item.scope);
    return Object.freeze({
      key: Object.freeze({ subject: "candidate" as const, key: item.id, snapshotId: item.snapshot }),
      title: item.name,
      subtitle: `${item.marketplace} · ${scope ?? "unknown scope"}`,
      status: item.availability,
      statusTone: item.availability === "available" || item.availability === "installed-by-default" ? "success" : "error",
      ...(scope === undefined ? {} : { scope }),
      plugin: item.plugin,
      sourceIdentity: item.sourceIdentity,
      completion: Object.freeze({ category: "candidate" as const, value: item.id, safe: safe(item.name) }),
      data: item as unknown as JsonValue,
    });
  }));
}

function marketplaceRows(envelope: NativeControlEnvelope): readonly PluginManagerRow[] | undefined {
  const parsed = NativeControlMarketplaceListResponseSchema.safeParse(envelope.data);
  if (!parsed.success) return undefined;
  return Object.freeze(parsed.data.registrations.map((item) => {
    const scope = scopeKind(item.scope);
    return Object.freeze({
      key: Object.freeze({ subject: "marketplace" as const, key: item.id }),
      title: item.marketplace,
      subtitle: item.source.kind,
      status: item.cache.kind,
      statusTone: item.cache.kind === "ready" ? "success" : item.cache.kind === "stale" ? "warning" : "error",
      ...(scope === undefined ? {} : { scope }),
      completion: Object.freeze({ category: "marketplace" as const, value: item.id, safe: safe(item.marketplace) }),
      data: item as unknown as JsonValue,
    });
  }));
}

function noticeRows(envelope: NativeControlEnvelope): readonly PluginManagerRow[] | undefined {
  const parsed = NativeUpdateNotificationPageSchema.safeParse(envelope.data);
  if (!parsed.success) return undefined;
  return Object.freeze(parsed.data.notices.map((item) => {
    const scope = scopeKind(item.scope);
    return Object.freeze({
      key: Object.freeze({ subject: "notice" as const, key: item.id }),
      title: item.plugin,
      subtitle: `${item.installed} → ${item.available} · ${scope ?? "unknown scope"}`,
      status: `${item.disposition}${item.unresolved ? " · unresolved" : ""}`,
      statusTone: item.unresolved ? "warning" : item.disposition === "automatic-applied" ? "success" : "muted",
      ...(scope === undefined ? {} : { scope }),
      plugin: item.plugin,
      completion: Object.freeze({ category: "notice" as const, value: item.id, safe: safe(item.plugin) }),
      data: item as unknown as JsonValue,
    });
  }));
}

function rowsFor(view: PluginManagerState["view"] | "browse", envelope: NativeControlEnvelope): readonly PluginManagerRow[] | undefined {
  if (view === "installed") return installedRows(envelope);
  if (view === "browse") return browseRows(envelope);
  return marketplaceRows(envelope);
}

export function mergePluginCatalogRows(installed: readonly PluginManagerRow[], available: readonly PluginManagerRow[], notices: readonly PluginManagerRow[]): readonly PluginManagerRow[] {
  const updates = new Set(notices.flatMap((row) => row.plugin === undefined || row.scope === undefined ? [] : [`${row.scope}\0${row.plugin}`]));
  const unread = new Map<string, string[]>();
  for (const row of notices) {
    if (row.plugin === undefined || row.scope === undefined) continue;
    const notice = row.data as Readonly<{ id?: unknown; unread?: unknown }>;
    if (notice.unread !== true || typeof notice.id !== "string") continue;
    const key = `${row.scope}\0${row.plugin}`;
    unread.set(key, [...(unread.get(key) ?? []), notice.id]);
  }
  const installedKeys = new Set(installed.flatMap((row) => row.plugin === undefined || row.scope === undefined ? [] : [`${row.scope}\0${row.plugin}`]));
  const rows = installed.map((row) => {
    const key = row.plugin === undefined || row.scope === undefined ? undefined : `${row.scope}\0${row.plugin}`;
    const hasUpdate = key !== undefined && updates.has(key);
    const unreadNoticeIds = key === undefined ? undefined : unread.get(key);
    const decorated = Object.freeze({
      ...row,
      ...(hasUpdate ? { status: "update available", statusTone: "warning" as const, hasUpdate: true } : {}),
      ...(unreadNoticeIds === undefined || unreadNoticeIds.length === 0 ? {} : { unreadNoticeIds: Object.freeze(unreadNoticeIds) }),
    });
    return decorated;
  });
  const availableSources = new Map<string, number>();
  for (const row of available) {
    const key = row.plugin === undefined || row.scope === undefined ? undefined : `${row.scope}\0${row.plugin}`;
    const sourceIdentity = row.sourceIdentity;
    // The catalog projects one candidate per install scope and can observe the
    // same immutable plugin through both native-host declarations. Collapse
    // those rows by source identity while retaining every admissible scope.
    const sourceKey = sourceIdentity;
    const existingIndex = sourceKey === undefined ? undefined : availableSources.get(sourceKey);
    if (existingIndex !== undefined) {
      const existing = rows[existingIndex]!;
      const scopes = new Set([...(existing.availableScopes ?? (existing.scope === undefined ? [] : [existing.scope])), ...(row.scope === undefined ? [] : [row.scope])]);
      rows[existingIndex] = Object.freeze({ ...existing, availableScopes: Object.freeze([...scopes]) });
      continue;
    }
    if (key === undefined || !installedKeys.has(key)) {
      const index = rows.length;
      rows.push(Object.freeze({ ...row, ...(row.scope === undefined ? {} : { availableScopes: Object.freeze([row.scope]) }) }));
      if (sourceKey !== undefined) availableSources.set(sourceKey, index);
    }
  }
  return Object.freeze(rows);
}

function selectedRow(state: PluginManagerState): PluginManagerRow | undefined {
  const rows = pluginManagerVisibleRows(state);
  const selected = state.focus.row;
  if (selected === undefined) return rows[0];
  return rows.find((row) => rowKeyIdentity(row.key) === rowKeyIdentity(selected));
}

function isAbort(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || error instanceof DOMException && error.name === "AbortError";
}

/** Latest-intent-wins controller over the one control facade executor. */
export function createPluginManagerController(input: Readonly<{
  execute: PluginManagerControlExecutor;
  actions?: Readonly<{
    run(action: string, state: PluginManagerState): Promise<PluginManagerControllerActionResult>;
    cancel(): void;
  }>;
}>): PluginManagerController {
  let model = createPluginManagerState();
  let request = 0;
  let detailRequest = 0;
  let pageAbort: AbortController | undefined;
  let detailAbort: AbortController | undefined;
  let closed = false;
  let pending: Promise<void> = Promise.resolve();
  const detailCache = new Map<string, NativeControlEnvelope>();
  const listeners = new Set<(state: PluginManagerState) => void>();

  function apply(event: PluginManagerEvent): void {
    if (closed) return;
    const next = pluginManagerReducer(model, event);
    if (next === model) return;
    model = next;
    for (const listener of listeners) listener(model);
  }

  async function loadStatus(): Promise<void> {
    const controller = new AbortController();
    const updates = input.execute(updateStatusCommand(), controller.signal).then((result) => {
      const status = NativeUpdateStatusSchema.safeParse(result.envelope.data);
      if (status.success) {
        apply({ type: "update-counts", unread: status.data.unreadCount, unresolved: status.data.unresolvedCount });
        apply({ type: "updates-policy", application: status.data.policy.global.application, cadence: status.data.policy.global.cadence });
      }
    }).catch(() => undefined);
    const health = input.execute(hostStatusCommand(), controller.signal).then((result) => {
      const parsed = HostStatusSnapshotSchema.safeParse(result.envelope.data);
      if (parsed.success) apply({
        type: "health-loaded",
        status: parsed.data.status === "ready" ? "ready" : parsed.data.status === "degraded" ? "degraded" : "blocked",
        explanation: `${parsed.data.local.runtime} runtime`,
      });
      else apply({ type: "health-loaded", status: "unavailable" });
    }).catch((error) => {
      if (!isAbort(error, controller.signal)) apply({ type: "health-loaded", status: "unavailable" });
    });
    await Promise.all([updates, health]);
  }

  async function loadPage(append: boolean): Promise<void> {
    if (closed) return;
    pageAbort?.abort(new DOMException("superseded", "AbortError"));
    const controller = new AbortController();
    pageAbort = controller;
    request += 1;
    const owned = request;
    const captured = model;
    apply({ type: "page-loading", request: owned, append });
    try {
      if (captured.view === "installed" && !append) {
        const collect = async (view: "installed" | "browse" | "updates"): Promise<readonly PluginManagerRow[]> => {
          const rows: PluginManagerRow[] = [];
          let next: string | undefined;
          // Bound memory and facade work while exhausting each independent
          // cursor. A unified catalog must not pretend one source's cursor also
          // represents discovery and update-notice pagination.
          for (let page = 0; page < 5; page += 1) {
            const result = await input.execute(view === "updates"
              ? updateNoticesCommand(next)
              : pageCommand({ view, query: captured.query, ...(next === undefined ? {} : { next }) }), controller.signal);
            if (controller.signal.aborted || owned !== request || closed) return Object.freeze([]);
            const parsed = view === "updates" ? noticeRows(result.envelope) : rowsFor(view, result.envelope);
            if (parsed === undefined) throw new Error("catalog page did not match its facade contract");
            rows.push(...parsed);
            next = result.envelope.page?.next;
            if (next === undefined) break;
          }
          return Object.freeze(rows);
        };
        const [installed, available, notices] = await Promise.all([
          collect("installed"),
          collect("browse"),
          collect("updates"),
        ]);
        if (controller.signal.aborted || owned !== request || closed) return;
        apply({ type: "page-loaded", request: owned, rows: mergePluginCatalogRows(installed, available, notices), append: false });
        await reconcileDetailAfterPageLoad();
        return;
      }
      const result = await input.execute(pageCommand({
        view: captured.view,
        query: captured.query,
        ...(append && captured.page.next !== undefined ? { next: captured.page.next } : {}),
      }), controller.signal);
      if (controller.signal.aborted || owned !== request || closed) return;
      const rows = rowsFor(captured.view, result.envelope);
      if (rows === undefined) {
        apply({ type: "page-failed", request: owned, code: result.envelope.diagnostics[0]?.code ?? `CONTROL_${result.envelope.status.toUpperCase().replaceAll("-", "_")}` });
        return;
      }
      apply({ type: "page-loaded", request: owned, rows, append, ...(result.envelope.page?.next === undefined ? {} : { next: result.envelope.page.next }) });
      await reconcileDetailAfterPageLoad();
    } catch (error) {
      if (!isAbort(error, controller.signal) && owned === request && !closed) {
        apply({ type: "page-failed", request: owned, code: "CONTROL_READ_FAILED" });
      }
    } finally {
      if (pageAbort === controller) pageAbort = undefined;
    }
  }

  /**
   * After a page reload retargets the detail pane to the same plugin's new
   * authority identity, replace the now-stale displayed detail. Bounded: the
   * load reconciles detail.row to the focused row, so this cannot loop.
   */
  async function reconcileDetailAfterPageLoad(): Promise<void> {
    if (closed || model.focus.pane !== "detail" || model.focus.row === undefined) return;
    if (model.detail.row !== undefined && rowKeyIdentity(model.detail.row) === rowKeyIdentity(model.focus.row)) return;
    await loadDetail({ force: true, open: true });
  }

  async function loadDetail(options: Readonly<{ force?: boolean; open?: boolean }> = {}): Promise<boolean> {
    if (closed) return false;
    const row = selectedRow(model);
    if (row === undefined) return false;
    const argv = detailCommand(row);
    if (argv === undefined) return false;
    const identity = rowKeyIdentity(row.key);
    detailAbort?.abort(new DOMException("superseded", "AbortError"));
    detailRequest += 1;
    const owned = detailRequest;
    apply({ type: "detail-loading", request: owned, row: row.key });
    const cached = options.force === true ? undefined : detailCache.get(identity);
    if (cached !== undefined) {
      apply({ type: "detail-loaded", request: owned, row: row.key, envelope: cached, open: options.open === true });
      return true;
    }
    const controller = new AbortController();
    detailAbort = controller;
    try {
      const result = await input.execute(argv, controller.signal);
      if (controller.signal.aborted || owned !== detailRequest || closed) return false;
      const parsed = NativeInspectionDetailResultSchema.safeParse(result.envelope.data);
      const current = parsed.success && parsed.data.kind === "found";
      const cacheable = current && result.envelope.status !== "stale" && result.envelope.status !== "conflict";
      if (cacheable) {
        detailCache.set(identity, result.envelope);
        // A small FIFO bound is sufficient because authority-bearing identities
        // naturally rotate after refreshes and mutations.
        if (detailCache.size > 64) {
          const oldest = detailCache.keys().next().value;
          if (oldest !== undefined) detailCache.delete(oldest);
        }
      } else detailCache.delete(identity);
      apply({ type: "detail-loaded", request: owned, row: row.key, envelope: result.envelope, open: options.open === true });
      if (result.envelope.status === "stale" || result.envelope.status === "conflict") await loadPage(false);
      return cacheable;
    } catch (error) {
      if (!isAbort(error, controller.signal) && owned === detailRequest && !closed) {
        apply({ type: "detail-failed", request: owned, row: row.key, code: "CONTROL_DETAIL_READ_FAILED" });
      }
      return false;
    } finally {
      if (detailAbort === controller) detailAbort = undefined;
    }
  }

  async function refresh(scope: "view" | "detail" | "all" = "all"): Promise<void> {
    if (closed) return;
    if (scope === "all") detailCache.clear();
    if (scope === "detail") {
      const row = selectedRow(model);
      if (row !== undefined) detailCache.delete(rowKeyIdentity(row.key));
      return void await loadDetail({ force: true, open: model.focus.pane === "detail" });
    }
    const tasks: Promise<void>[] = [loadPage(false)];
    if (scope === "all") tasks.push(loadStatus());
    await Promise.all(tasks);
  }

  function schedule(task: () => Promise<void>): void {
    pending = task().catch(() => undefined);
  }

  const controller: PluginManagerController = {
    state: () => model,
    dispatch(intent): void {
      if (closed) return;
      const previous = model;
      apply({ type: "intent", intent });
      if (intent.type === "set-view" || intent.type === "submit-search") schedule(() => refresh("view"));
      else if (intent.type === "next-page" && model.page.next !== undefined && !model.page.loading) schedule(() => loadPage(true));
      else if (intent.type === "open-detail" || intent.type === "action" && intent.action === "inspect") schedule(() => loadDetail({ open: true }).then(() => undefined));
      else if (intent.type === "refresh") schedule(() => refresh(intent.scope));
      else if (intent.type === "cancel-operation") {
        if (previous.operation.state !== "running") return;
        input.actions?.cancel();
        apply({ type: "operation-cancelling" });
      } else if (intent.type === "action" && input.actions !== undefined) {
        const actionState = model;
        schedule(async () => {
          let resolvedState = actionState;
          if (intent.action === "install") {
            const detail = NativeInspectionDetailResultSchema.safeParse(resolvedState.detail.envelope?.data);
            if (!detail.success || detail.data.kind !== "found") {
              const requested = selectedRow(resolvedState);
              if (!await loadDetail({ open: false })) {
                apply({ type: "intent", intent: { type: "open-detail" } });
                return;
              }
              const current = selectedRow(model);
              if (requested === undefined || current === undefined || rowKeyIdentity(requested.key) !== rowKeyIdentity(current.key)) return;
              resolvedState = model;
            }
          }
          apply({ type: "operation-started", action: intent.action });
          try {
            const result = await input.actions!.run(intent.action, resolvedState);
            if (result.presentation === "successor" || closed) return;
            if (result.kind !== "completed") {
              apply({ type: "operation-abandoned" });
              if (result.kind === "handled") await refresh("all");
              return;
            }
            apply({ type: "operation-finished", envelope: result.envelope });
            detailCache.clear();
            // Refresh behind the result screen so Escape returns to current
            // authoritative state (especially after adding/removing a source).
            await refresh("all");
            if (result.envelope.status === "ok" || result.envelope.status === "no-change") {
              // A successful routine mutation needs no read-out: return to the
              // refreshed rows, where the flipped status is the confirmation.
              // Failures keep the result view so diagnostics stay visible.
              apply({ type: "intent", intent: { type: "return-manager" } });
            }
          } catch {
            if (closed) return;
            apply({ type: "intent", intent: { type: "return-manager" } });
            await refresh("all");
          }
        });
      }
    },
    refresh,
    dynamicCompletions(): readonly NativeControlDynamicCandidate[] {
      const candidates: NativeControlDynamicCandidate[] = [];
      const seen = new Set<string>();
      for (const row of model.page.rows) {
        const key = `${row.completion.category}\0${row.completion.value}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(row.completion);
        if (candidates.length === 512) break;
      }
      return Object.freeze(candidates);
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    observe(event): void { if (!closed) apply(event); },
    idle: () => pending,
    async close(_reason): Promise<void> {
      if (closed) return;
      closed = true;
      pageAbort?.abort(new DOMException("manager closed", "AbortError"));
      detailAbort?.abort(new DOMException("manager closed", "AbortError"));
      if (_reason !== "reload") {
        input.actions?.cancel();
        await pending.catch(() => undefined);
      } else {
        // Reload teardown must not await or abort the admitted mutation whose
        // plain-data result is being produced for the successor extension.
        void pending.catch(() => undefined);
      }
      listeners.clear();
      detailCache.clear();
      model = createPluginManagerState();
    },
  };
  return Object.freeze(controller);
}
