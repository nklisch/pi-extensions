import { z } from "zod";
import { HookContextVisibilitySchema } from "../domain/hook-visibility.js";

/**
 * One command reads and writes the preference: a `visibility` positional
 * sets it, an omitted positional returns the current value unchanged.
 */
export const NativeHookVisibilityRequestSchema = z.object({
  visibility: HookContextVisibilitySchema.optional(),
}).strict().readonly();
export type NativeHookVisibilityRequest = z.infer<typeof NativeHookVisibilityRequestSchema>;

export const NativeHookVisibilityResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("current"),
    visibility: HookContextVisibilitySchema,
  }).strict().readonly(),
  z.object({
    kind: z.enum(["changed", "unchanged"]),
    visibility: HookContextVisibilitySchema,
  }).strict().readonly(),
  z.object({
    kind: z.literal("rejected"),
    code: z.enum(["STATE_UNAVAILABLE"]),
  }).strict().readonly(),
  z.object({
    kind: z.literal("stale"),
    reason: z.literal("generation"),
  }).strict().readonly(),
]);
export type NativeHookVisibilityResult = z.infer<typeof NativeHookVisibilityResultSchema>;
