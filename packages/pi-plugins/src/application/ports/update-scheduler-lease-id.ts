import type { UpdateSchedulerLeaseId } from "../../domain/update-policy.js";

export interface UpdateSchedulerLeaseIdPort {
  create(signal: AbortSignal): Promise<UpdateSchedulerLeaseId>;
}
