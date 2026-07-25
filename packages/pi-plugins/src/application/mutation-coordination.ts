import { z } from "zod";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../domain/state/scope.js";

/** One plugin mutation target, qualified by its user/project scope. */
export const MutationSubjectSchema = z
  .object({
    scope: ScopeReferenceSchema,
    plugin: PluginKeySchema,
  })
  .strict()
  .readonly();
export type MutationSubject = z.infer<typeof MutationSubjectSchema>;

/** Serializes mutation callbacks by canonical scope-qualified plugin key. */
export interface KeyedMutationScheduler {
  run<T>(
    subjects: readonly MutationSubject[],
    work: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T>;
}

export type { PluginKey, ScopeReference };
