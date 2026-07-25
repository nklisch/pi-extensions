import { z } from "zod";
import { PluginKeySchema } from "../domain/identity.js";
import { ScopeReferenceSchema } from "../domain/state/scope.js";

/** Redacted, read-only packaged-host capability evidence. */
export const HostCapabilityStatusSchema = z.object({
  status: z.enum(["available", "unavailable"]),
  explanation: z.string().min(1),
}).strict().readonly();
export type HostCapabilityStatus = z.infer<typeof HostCapabilityStatusSchema>;

export const HostCapabilitiesSchema = z.object({
  mcp: HostCapabilityStatusSchema,
  subagents: HostCapabilityStatusSchema,
  piReload: HostCapabilityStatusSchema,
  secrets: HostCapabilityStatusSchema,
}).strict().readonly();
export type HostCapabilities = z.infer<typeof HostCapabilitiesSchema>;

export const HostBlockedPluginSchema = z.object({
  plugin: z.union([PluginKeySchema, z.string().min(1)]),
  code: z.string().min(1),
  explanation: z.string().min(1),
}).strict().readonly();
export type HostBlockedPluginObservation = z.infer<typeof HostBlockedPluginSchema>;

export const HostReadinessStatusSchema = z.enum(["ready", "degraded", "blocked"]);
export type HostReadinessStatus = z.infer<typeof HostReadinessStatusSchema>;

export const HostStartupResultSchema = z.object({
  status: HostReadinessStatusSchema,
  blocked: z.array(HostBlockedPluginSchema).readonly(),
  capabilities: HostCapabilitiesSchema,
}).strict().readonly();
export type HostStartupResult = z.infer<typeof HostStartupResultSchema>;

export const HostStatusSnapshotSchema = z.object({
  status: HostReadinessStatusSchema,
  local: z.object({
    recovery: z.enum(["settled", "degraded", "blocked"]),
    runtime: z.enum(["reconciled", "degraded", "blocked"]),
  }).strict().readonly(),
  update: z.object({
    state: z.enum(["disabled", "standby", "running", "clock-regressed", "degraded", "stopped"]),
    unresolvedCount: z.number().int().nonnegative(),
    unreadCount: z.number().int().nonnegative(),
    scopes: z.array(z.object({
      scope: ScopeReferenceSchema,
      ownership: z.enum(["self", "other", "none"]),
      nextAt: z.number().int().nonnegative().optional(),
    }).strict().readonly()).readonly().default([]),
  }).strict().readonly(),
  blocked: z.array(HostBlockedPluginSchema).readonly(),
  capabilities: HostCapabilitiesSchema,
}).strict().readonly();
export type HostStatusSnapshot = z.infer<typeof HostStatusSnapshotSchema>;
