import type { AutomaticUpdateCoordinator } from "./automatic-update-coordinator.js";
import type { MarketplaceUpdateScheduler } from "./marketplace-update-scheduler.js";
import {
  NativeUpdateStatusSchema,
  type NativeAutomaticUpdateRunRequest,
  type NativeAutomaticUpdateRunResult,
  type NativeUpdateAcknowledgmentRequest,
  type NativeUpdateAcknowledgmentResult,
  type NativeUpdateNotificationListRequest,
  type NativeUpdateNotificationPage,
  type NativeUpdatePolicyApplyRequest,
  type NativeUpdatePolicyApplyResult,
  type NativeUpdatePolicyPreviewResult,
  type NativeUpdateStatus,
  type NativeUpdateStatusRequest,
} from "./native-update-contract.js";
import type { NativeUpdatePolicyService } from "./native-update-policy-service.js";
import type { UpdateNotificationService } from "./update-notification-service.js";
import type { UpdatePolicyChange } from "../domain/update-policy.js";

export interface NativeUpdateManagementService {
  previewPolicy(request: UpdatePolicyChange, signal: AbortSignal): Promise<NativeUpdatePolicyPreviewResult>;
  applyPolicy(request: NativeUpdatePolicyApplyRequest, signal: AbortSignal): Promise<NativeUpdatePolicyApplyResult>;
  status(request: NativeUpdateStatusRequest, signal: AbortSignal): Promise<NativeUpdateStatus>;
  notifications(request: NativeUpdateNotificationListRequest, signal: AbortSignal): Promise<NativeUpdateNotificationPage>;
  acknowledge(request: NativeUpdateAcknowledgmentRequest, signal: AbortSignal): Promise<NativeUpdateAcknowledgmentResult>;
  runAutomatic(request: NativeAutomaticUpdateRunRequest, signal: AbortSignal): Promise<NativeAutomaticUpdateRunResult>;
}

export function createNativeUpdateManagementService(dependencies: Readonly<{
  policy: NativeUpdatePolicyService;
  notifications: UpdateNotificationService;
  automatic: AutomaticUpdateCoordinator;
  scheduler: MarketplaceUpdateScheduler;
  onCounts?: (counts: Readonly<{ unreadCount: number; unresolvedCount: number }>) => void;
}>): NativeUpdateManagementService {
  return Object.freeze({
    previewPolicy: dependencies.policy.preview.bind(dependencies.policy),
    applyPolicy: dependencies.policy.apply.bind(dependencies.policy),
    async status(
      request: NativeUpdateStatusRequest,
      signal: AbortSignal,
    ) {
      const [policy, scheduler, notices] = await Promise.all([
        dependencies.policy.status(request, signal),
        dependencies.scheduler.status(signal),
        dependencies.notifications.list({ scope: request.scope, ...(request.plugin === undefined ? {} : { plugin: request.plugin }), limit: 1 }, signal),
      ]);
      dependencies.onCounts?.({ unreadCount: notices.unreadCount, unresolvedCount: notices.unresolvedCount });
      return NativeUpdateStatusSchema.parse({ policy, scheduler, unreadCount: notices.unreadCount, unresolvedCount: notices.unresolvedCount });
    },
    async notifications(request: NativeUpdateNotificationListRequest, signal: AbortSignal) {
      const page = await dependencies.notifications.list(request, signal);
      dependencies.onCounts?.({ unreadCount: page.unreadCount, unresolvedCount: page.unresolvedCount });
      return page;
    },
    async acknowledge(request: NativeUpdateAcknowledgmentRequest, signal: AbortSignal) {
      const result = await dependencies.notifications.acknowledge(request, signal);
      dependencies.onCounts?.({ unreadCount: result.unreadCount, unresolvedCount: result.unresolvedCount });
      return result;
    },
    async runAutomatic(request: NativeAutomaticUpdateRunRequest, signal: AbortSignal) {
      const result = await dependencies.automatic.run(request, signal);
      const page = await dependencies.notifications.list({ scope: "all-current", limit: 1 }, signal);
      dependencies.onCounts?.({ unreadCount: page.unreadCount, unresolvedCount: page.unresolvedCount });
      return result;
    },
  });
}
