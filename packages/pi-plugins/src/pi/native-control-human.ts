import { HostStatusSnapshotSchema } from "../application/host-observation-contract.js";
import { NativeLifecycleOperationResultSchema } from "../application/native-lifecycle-operation-contract.js";
import { NativeControlHelpSchema } from "../application/native-control-help.js";
import { NativeInspectionPageSchema } from "../application/native-inspection-contract.js";
import { NativeControlCommandRegistry } from "../application/native-control-registry.js";
import {
  NativeControlMarketplaceCatalogResponseSchema,
  NativeControlMarketplaceListResponseSchema,
} from "../application/native-control-safe-projection.js";
import { NativeUpdateNotificationPageSchema } from "../application/native-update-contract.js";
import type { NativeControlEnvelope } from "../application/native-control-contract.js";
import { plainLifecycleFailure, plainLifecyclePhase } from "./plain-language.js";

function lifecycleLines(envelope: NativeControlEnvelope): readonly string[] | undefined {
  const parsed = NativeLifecycleOperationResultSchema.safeParse(envelope.data);
  if (!parsed.success) return undefined;
  const value = parsed.data;
  if (value.kind === "expired" || value.kind === "disposed") {
    return Object.freeze([`${envelope.command.path.join(" ") || "plugin"} · ${value.kind}`]);
  }
  const target = "before" in value ? value.before : "target" in value ? value.target : "restored" in value ? value.restored : undefined;
  const subject = target === undefined ? value.operation : `${target.plugin} · ${value.operation}`;
  const lines = [`${subject} · ${value.kind}`];
  if (value.kind === "current-state") lines.push("already in the wanted state — nothing to do");
  if (value.kind === "needs-action") lines.push(`${value.actions.length} project sync action${value.actions.length === 1 ? "" : "s"} need attention`);
  if (value.kind === "cancelled") lines.push(`cancelled during ${plainLifecyclePhase(value.phase)}`);
  if (value.kind === "stale" || value.kind === "conflict") lines.push("things changed — refresh and try again");
  if (value.kind === "rejected" || value.kind === "failed") lines.push(plainLifecycleFailure(value.code));
  if (value.kind === "recovery-required") lines.push("setup didn't finish — run recovery to complete it");
  if (value.kind === "rolled-back") lines.push(`${plainLifecycleFailure(value.failure)} · ${value.restored.plugin} was restored`);
  if (value.kind === "succeeded" && value.cleanup !== undefined) {
    lines.push(`persistent data ${value.cleanup.persistentData} · configuration ${value.cleanup.configuration} · trust ${value.cleanup.trust}`);
  }
  for (const diagnostic of [...value.diagnostics, ...envelope.diagnostics]) {
    lines.push(`${diagnostic.severity} ${diagnostic.code} · ${diagnostic.action}`);
  }
  return Object.freeze(lines);
}

/**
 * Produce useful human output from the already-safe public control envelope.
 * Command summaries are labels, not results, so they are omitted whenever
 * structured owner data or diagnostics can tell the user what actually happened.
 */
export function nativeControlHumanLines(envelope: NativeControlEnvelope): readonly string[] {
  const help = NativeControlHelpSchema.safeParse(envelope.command.id === "help" ? envelope.data : undefined);
  if (help.success) {
    return Object.freeze(help.data.commands.map((command) => {
      const path = command.path.join(" ");
      const positionals = command.positionals.map((entry) => entry.required ? `<${entry.name}>${entry.repeatable ? "..." : ""}` : `[${entry.name}${entry.repeatable ? "..." : ""}]`);
      return `${[path, ...positionals].filter(Boolean).join(" ")} — ${command.summary.text}`;
    }));
  }
  const installed = NativeInspectionPageSchema.safeParse(envelope.command.id === "inspection.list" ? envelope.data : undefined);
  if (installed.success) return Object.freeze(installed.data.items.length === 0
    ? ["No plugins added."]
    : installed.data.items.map((item) => `${item.plugin} · ${item.scope.kind} · ${item.condition} · ${item.revision.installed?.text ?? "not installed"}`));
  const sources = NativeControlMarketplaceListResponseSchema.safeParse(envelope.command.id === "marketplace.list" ? envelope.data : undefined);
  if (sources.success) return Object.freeze(sources.data.registrations.length === 0
    ? ["No plugin sources configured."]
    : sources.data.registrations.map((source) => `${source.marketplace} · ${source.source.kind} · ${source.cache.kind}`));
  const catalog = NativeControlMarketplaceCatalogResponseSchema.safeParse(envelope.command.id === "browse" ? envelope.data : undefined);
  if (catalog.success) return Object.freeze(catalog.data.candidates.length === 0
    ? ["No plugins available from configured sources."]
    : catalog.data.candidates.map((candidate) => `${candidate.plugin} · ${candidate.scope.kind} · ${candidate.availability}`));
  const notices = NativeUpdateNotificationPageSchema.safeParse(envelope.command.id === "updates.notices.list" ? envelope.data : undefined);
  if (notices.success) return Object.freeze(notices.data.notices.length === 0
    ? ["No pending plugin updates."]
    : notices.data.notices.map((notice) => `${notice.plugin} · ${notice.installed} → ${notice.available} · ${notice.disposition}`));
  const status = HostStatusSnapshotSchema.safeParse(envelope.command.id === "status" ? envelope.data : undefined);
  if (status.success) {
    const value = status.data;
    return Object.freeze([
      `Host ${value.status} · recovery ${value.local.recovery} · runtime ${value.local.runtime}`,
      `Updates ${value.update.state} · ${value.update.unreadCount} unread · ${value.update.unresolvedCount} unresolved`,
      ...Object.entries(value.capabilities).map(([name, capability]) => `${name}: ${capability.status} · ${capability.explanation}`),
      ...(value.blocked.length === 0 ? [] : value.blocked.map((blocked) => `blocked ${blocked.plugin}: ${blocked.code}`)),
      ...envelope.diagnostics.map((entry) => `${entry.severity.toUpperCase()} ${entry.code} · ${entry.action}`),
    ]);
  }
  const lifecycle = lifecycleLines(envelope);
  if (lifecycle !== undefined) return lifecycle;
  // Never dump raw result JSON: the envelope's safe human fields and
  // diagnostics are the presentation contract, and anything else reduces to
  // one status line.
  const summary = NativeControlCommandRegistry[envelope.command.id].summary.text;
  const human = envelope.human
    .map((field) => field.text)
    .filter((line) => line !== summary);
  const diagnostics = envelope.diagnostics.map((entry) => `${entry.severity.toUpperCase()} ${entry.code} · ${entry.action}`);
  const lines = [...human, ...diagnostics];
  return Object.freeze(lines.length > 0
    ? lines
    : [`${envelope.command.path.join(" ") || "plugin"}: ${envelope.status}`]);
}
