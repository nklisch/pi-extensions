import { z } from "zod";

/** UUIDs are issued by an injected adapter; lifecycle policy does not use time or randomness. */
export const LifecycleOperationIdSchema = z.string().uuid().brand<"LifecycleOperationId">();
export type LifecycleOperationId = z.infer<typeof LifecycleOperationIdSchema>;

export interface LifecycleOperationIdPort {
  create(signal: AbortSignal): Promise<LifecycleOperationId>;
}

export function parseLifecycleOperationId(input: unknown): LifecycleOperationId {
  return LifecycleOperationIdSchema.parse(input);
}
