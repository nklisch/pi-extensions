import { z } from "zod";
import { JsonValueSchema, type JsonValue } from "../domain/schema.js";
import { SafeDisplayFieldSchema } from "./native-inspection-contract.js";
import { NativeLifecycleOperationTokenSchema } from "./native-lifecycle-operation-contract.js";
import {
  NativeControlCommandIdSchema,
  NativeControlCommandRegistry,
  NativeControlGrammarVersionSchema,
  type NativeControlCommandId,
} from "./native-control-registry.js";
import { TrustedInstallSessionTokenSchema } from "./trusted-install-contract.js";

export const NativeControlEnvelopeVersionSchema = z.literal(1);
export const NativeControlExecutionIdSchema = z.string()
  .regex(/^native-control-execution-v1:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  .brand<"NativeControlExecutionId">();
export type NativeControlExecutionId = z.infer<typeof NativeControlExecutionIdSchema>;

export const NativeControlExitRegistry = Object.freeze({
  success: Object.freeze({ classification: "success", code: 0 }),
  usage: Object.freeze({ classification: "usage", code: 2 }),
  inputRequired: Object.freeze({ classification: "input-required", code: 3 }),
  notFound: Object.freeze({ classification: "not-found", code: 4 }),
  conflict: Object.freeze({ classification: "conflict-or-stale", code: 5 }),
  unavailable: Object.freeze({ classification: "unavailable", code: 6 }),
  rejected: Object.freeze({ classification: "rejected-or-blocked", code: 7 }),
  incomplete: Object.freeze({ classification: "partial-or-recovery-required", code: 8 }),
  cancelled: Object.freeze({ classification: "cancelled-or-timeout", code: 9 }),
  internal: Object.freeze({ classification: "internal", code: 10 }),
  delivery: Object.freeze({ classification: "output-delivery-failed", code: 74 }),
} as const);
export type NativeControlExitKey = keyof typeof NativeControlExitRegistry;

export type NativeControlExit = (typeof NativeControlExitRegistry)[keyof typeof NativeControlExitRegistry];
const exitSchemas = Object.values(NativeControlExitRegistry).map((entry) => z.object({
  classification: z.literal(entry.classification),
  code: z.literal(entry.code),
}).strict().readonly());
export const NativeControlExitSchema: z.ZodType<NativeControlExit> = z.union(exitSchemas as unknown as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]) as z.ZodType<NativeControlExit>;

export const NativeControlStatusSchema = z.enum([
  "ok", "no-change", "input-required", "not-found", "stale", "conflict",
  "unavailable", "rejected", "partial", "recovery-required", "cancelled",
  "failed", "presentation-required",
]);
export type NativeControlStatus = z.infer<typeof NativeControlStatusSchema>;

export const NativeControlDiagnosticSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/),
  severity: z.enum(["info", "warning", "error"]),
  field: z.string().regex(/^[a-z][a-zA-Z0-9.\[\]-]*$/).optional(),
  action: z.enum(["retry", "reparse", "provide-input", "confirm-exact", "refresh", "reinspect", "poll", "run-recovery", "none"]),
  safe: SafeDisplayFieldSchema.optional(),
}).strict().readonly();
export type NativeControlDiagnostic = z.infer<typeof NativeControlDiagnosticSchema>;

export const NativeControlOperationHandleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("trusted-install"), token: TrustedInstallSessionTokenSchema }).strict().readonly(),
  z.object({ kind: z.literal("lifecycle"), token: NativeLifecycleOperationTokenSchema }).strict().readonly(),
]);
export type NativeControlOperationHandle = z.infer<typeof NativeControlOperationHandleSchema>;

export const NativeControlPageSchema = z.object({ next: z.string().min(1).max(4096).optional() }).strict().readonly();

const statusExit: Readonly<Record<NativeControlStatus, NativeControlExitKey>> = Object.freeze({
  ok: "success",
  "no-change": "success",
  "input-required": "inputRequired",
  "not-found": "notFound",
  stale: "conflict",
  conflict: "conflict",
  unavailable: "unavailable",
  rejected: "rejected",
  partial: "incomplete",
  "recovery-required": "incomplete",
  cancelled: "cancelled",
  failed: "internal",
  "presentation-required": "success",
});

export const NativeControlEnvelopeSchema = z.object({
  schemaVersion: NativeControlEnvelopeVersionSchema,
  grammarVersion: NativeControlGrammarVersionSchema,
  executionId: NativeControlExecutionIdSchema,
  command: z.object({
    id: NativeControlCommandIdSchema,
    path: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).max(8).readonly(),
  }).strict().readonly(),
  status: NativeControlStatusSchema,
  exit: NativeControlExitSchema,
  data: JsonValueSchema.optional(),
  operation: NativeControlOperationHandleSchema.optional(),
  page: NativeControlPageSchema.optional(),
  diagnostics: z.array(NativeControlDiagnosticSchema).max(512).readonly(),
  human: z.array(SafeDisplayFieldSchema).max(512).readonly(),
}).strict().readonly().superRefine((envelope, context) => {
  const definition = NativeControlCommandRegistry[envelope.command.id];
  if (envelope.command.path.join("\0") !== definition.path.join("\0")) {
    context.addIssue({ code: "custom", path: ["command", "path"], message: "envelope command path is not canonical" });
  }
  const expected = NativeControlExitRegistry[statusExit[envelope.status]];
  if (envelope.status === "failed" && envelope.exit.classification === "usage") {
    // Parse/usage failures deliberately use failed + usage.
  } else if (envelope.status === "presentation-required" && envelope.exit.classification === "input-required") {
    // A headless no-arg invocation retains presentation intent while reporting
    // that a UI/input provider is required.
  } else if (envelope.exit.classification !== expected.classification || envelope.exit.code !== expected.code) {
    context.addIssue({ code: "custom", path: ["exit"], message: "status and exit classification disagree" });
  }
  if (envelope.operation !== undefined && !["ok", "input-required", "partial", "recovery-required"].includes(envelope.status)) {
    context.addIssue({ code: "custom", path: ["operation"], message: "operation handle is not valid for this status" });
  }
  if (envelope.page !== undefined && envelope.data === undefined) {
    context.addIssue({ code: "custom", path: ["page"], message: "page metadata requires data" });
  }
  if (envelope.data !== undefined) {
    const projected = definition.projectedResponse.safeParse(envelope.data);
    if (!projected.success) {
      context.addIssue({ code: "custom", path: ["data"], message: "envelope data does not match the command projection schema" });
    }
  }
});
export type NativeControlEnvelope = z.infer<typeof NativeControlEnvelopeSchema>;

export function nativeControlExit(key: NativeControlExitKey): NativeControlExit {
  return NativeControlExitSchema.parse(NativeControlExitRegistry[key]);
}

export function nativeControlStatusExit(status: NativeControlStatus): NativeControlExit {
  return nativeControlExit(statusExit[status]);
}

export function createNativeControlEnvelope(input: Readonly<{
  executionId: NativeControlExecutionId;
  command: NativeControlCommandId;
  status: NativeControlStatus;
  data?: JsonValue;
  operation?: NativeControlOperationHandle;
  page?: Readonly<{ next?: string }>;
  diagnostics?: readonly NativeControlDiagnostic[];
  human?: readonly z.infer<typeof SafeDisplayFieldSchema>[];
  usageFailure?: boolean;
  exitOverride?: NativeControlExit;
}>): NativeControlEnvelope {
  const definition = NativeControlCommandRegistry[input.command];
  return NativeControlEnvelopeSchema.parse({
    schemaVersion: 1,
    grammarVersion: "plugin-control/v1",
    executionId: input.executionId,
    command: { id: input.command, path: definition.path },
    status: input.status,
    exit: input.exitOverride ?? (input.usageFailure ? NativeControlExitRegistry.usage : nativeControlStatusExit(input.status)),
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.operation === undefined ? {} : { operation: input.operation }),
    ...(input.page === undefined ? {} : { page: input.page }),
    diagnostics: input.diagnostics ?? [],
    human: input.human ?? [],
  });
}

function validateExitRegistry(): void {
  const classifications = new Set<string>();
  const codes = new Set<number>();
  for (const entry of Object.values(NativeControlExitRegistry)) {
    if (classifications.has(entry.classification) || codes.has(entry.code)) throw new Error("native control exits must be unique");
    if (!Number.isInteger(entry.code) || entry.code < 0 || entry.code > 125) throw new Error("native control exit code is outside the portable process range");
    classifications.add(entry.classification);
    codes.add(entry.code);
  }
}
validateExitRegistry();
