import { z } from "zod";
import { ScopeContextSchema, type ScopeContext } from "../../domain/state/scope.js";

export const LifecycleStateInventorySchema = z.object({
  scopes: z.array(ScopeContextSchema).readonly(),
  complete: z.boolean(),
}).strict().readonly();
export type LifecycleStateInventory = z.infer<typeof LifecycleStateInventorySchema>;

/** Discovery is advisory; recovery always rereads each returned scope authoritatively. */
export interface LifecycleStateInventoryPort {
  discover(signal: AbortSignal): Promise<LifecycleStateInventory>;
}

export type { ScopeContext };
