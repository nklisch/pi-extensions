import { RefreshClaimIdSchema, type RefreshClaimId } from "../../domain/update-policy.js";

export interface RefreshClaimIdPort {
  create(): RefreshClaimId | Promise<RefreshClaimId>;
}

export { RefreshClaimIdSchema };
export type { RefreshClaimId };
