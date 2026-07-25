import { z } from "zod";
import { HostPrecedenceSchema } from "../domain/host-precedence.js";

/** CLI-facing spelling of the canonical host order. */
export const HostPrecedenceOrderSchema = z.enum(["claude-first", "codex-first"]);
export type HostPrecedenceOrder = z.infer<typeof HostPrecedenceOrderSchema>;

export const NativeHostPrecedenceRequestSchema = z.object({
  order: HostPrecedenceOrderSchema,
}).strict().readonly();
export type NativeHostPrecedenceRequest = z.infer<typeof NativeHostPrecedenceRequestSchema>;

export const NativeHostPrecedenceResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("changed"),
    order: HostPrecedenceOrderSchema,
    precedence: HostPrecedenceSchema,
  }).strict().readonly(),
  z.object({
    kind: z.literal("unchanged"),
    order: HostPrecedenceOrderSchema,
    precedence: HostPrecedenceSchema,
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
export type NativeHostPrecedenceResult = z.infer<typeof NativeHostPrecedenceResultSchema>;
