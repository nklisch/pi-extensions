import { z } from "zod";
import { UpdateNoticeIdSchema } from "../domain/update-policy.js";

export const AutomaticUpdateEligibilityReasonRegistry = Object.freeze({
  eligible: "eligible",
  manual: "manual",
  approvalRequired: "approval-required",
  stale: "stale",
  projectUntrusted: "project-untrusted",
  recoveryRequired: "recovery-required",
  configurationRequired: "configuration-required",
  secretUnavailable: "secret-unavailable",
  capabilityUnavailable: "capability-unavailable",
  awaitingHostContext: "awaiting-host-context",
  retryable: "retryable",
} as const);

export type AutomaticUpdateEligibilityReason =
  (typeof AutomaticUpdateEligibilityReasonRegistry)[keyof typeof AutomaticUpdateEligibilityReasonRegistry];

export const AutomaticUpdateEligibilityReasonSchema = z.enum(
  Object.values(AutomaticUpdateEligibilityReasonRegistry) as [
    AutomaticUpdateEligibilityReason,
    ...AutomaticUpdateEligibilityReason[],
  ],
);

export const AutomaticUpdateEligibilitySchema = z.object({
  noticeId: UpdateNoticeIdSchema,
  kind: AutomaticUpdateEligibilityReasonSchema,
  retryAt: z.number().int().nonnegative().optional(),
}).strict().readonly().superRefine((result, context) => {
  if ((result.kind === "retryable") !== (result.retryAt !== undefined)) context.addIssue({ code: "custom", path: ["retryAt"], message: "only retryable eligibility has retry timing" });
});
export type AutomaticUpdateEligibility = z.infer<typeof AutomaticUpdateEligibilitySchema>;
