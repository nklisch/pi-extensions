import { z } from "zod";
import { PluginConfigurationRefSchema, PluginDataRefSchema, type PluginConfigurationRef, type PluginDataRef } from "../domain/state/references.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { ScopeContextSchema, type ScopeContext } from "../domain/state/scope.js";
import type { PersistentDataRemovalPlan, PersistentDataRemovalPort } from "./ports/persistent-data-removal.js";

export const ConfirmedUninstallCleanupResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("skipped"), reason: z.enum(["KEEP", "NOT_TERMINAL", "LEASE_ACTIVE", "GRACE_PENDING"]) }).strict().readonly(),
  z.object({ kind: z.literal("removed") }).strict().readonly(),
  z.object({ kind: z.literal("partial-failure"), reason: z.enum(["CONFIGURATION", "DATA"]), retained: z.literal(true) }).strict().readonly(),
]);
export type ConfirmedUninstallCleanupResult = z.infer<typeof ConfirmedUninstallCleanupResultSchema>;

export type ConfirmedUninstallCleanupDependencies = Readonly<{
  removeConfiguration(input: Readonly<{ scope: ScopeContext; plugin: PluginKey; configurationRef: PluginConfigurationRef; descriptors: readonly unknown[] }>, signal: AbortSignal): Promise<"removed" | "missing" | "partial-failure">;
  data: PersistentDataRemovalPort;
}>;
export type ConfirmedUninstallCleanupRequest = Readonly<{
  scope: ScopeContext;
  plugin: PluginKey;
  retainedData: "keep" | "delete-confirmed";
  terminalUninstall: boolean;
  noLiveOrUnknownLease: boolean;
  graceElapsed: boolean;
  dataRef: PluginDataRef;
  configurationRef?: PluginConfigurationRef;
  descriptors?: readonly unknown[];
}>;

/** Explicit data cleanup is a separate capability; generic collection cannot call it. */
export function createConfirmedUninstallCleanup(dependencies: ConfirmedUninstallCleanupDependencies) {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("confirmed cleanup dependencies are required");
  async function cleanup(input: ConfirmedUninstallCleanupRequest, signal: AbortSignal): Promise<ConfirmedUninstallCleanupResult> {
    const request = {
      ...input,
      scope: ScopeContextSchema.parse(input.scope),
      plugin: PluginKeySchema.parse(input.plugin),
      dataRef: PluginDataRefSchema.parse(input.dataRef),
      ...(input.configurationRef === undefined ? {} : { configurationRef: PluginConfigurationRefSchema.parse(input.configurationRef) }),
    };
    if (request.retainedData === "keep") return { kind: "skipped", reason: "KEEP" };
    if (!request.terminalUninstall) return { kind: "skipped", reason: "NOT_TERMINAL" };
    if (!request.noLiveOrUnknownLease) return { kind: "skipped", reason: "LEASE_ACTIVE" };
    if (!request.graceElapsed) return { kind: "skipped", reason: "GRACE_PENDING" };
    if (request.configurationRef !== undefined) {
      const configuration = await dependencies.removeConfiguration({ scope: request.scope, plugin: request.plugin, configurationRef: request.configurationRef, descriptors: request.descriptors ?? [] }, signal).catch(() => "partial-failure" as const);
      if (configuration === "partial-failure") return { kind: "partial-failure", reason: "CONFIGURATION", retained: true };
    }
    const plan: PersistentDataRemovalPlan = {
      scope: request.scope.kind === "user" ? { kind: "user" } : request.scope,
      plugin: request.plugin,
      dataRef: request.dataRef,
      confirmation: "delete-confirmed",
      capability: {},
    };
    try { await dependencies.data.remove(plan, signal); }
    catch { return { kind: "partial-failure", reason: "DATA", retained: true }; }
    return { kind: "removed" };
  }
  return Object.freeze({ cleanup });
}

export type { PluginConfigurationRef, PluginDataRef, PluginKey, ScopeContext };
