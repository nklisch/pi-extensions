import { z } from "zod";
import { PluginDataRefSchema, type PluginDataRef } from "../../domain/state/references.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import { ScopeReferenceSchema, type ScopeReference } from "../../domain/state/scope.js";

export const PersistentDataRemovalPlanSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
  dataRef: PluginDataRefSchema,
  confirmation: z.literal("delete-confirmed"),
  capability: z.object({}).strict(),
}).strict().readonly();
export type PersistentDataRemovalPlan = z.infer<typeof PersistentDataRemovalPlanSchema>;

/** This port is not part of generic revision collection. */
export interface PersistentDataRemovalPort {
  remove(plan: PersistentDataRemovalPlan, signal: AbortSignal): Promise<"removed" | "already-absent">;
}

export type { PluginDataRef, PluginKey, ScopeReference };
