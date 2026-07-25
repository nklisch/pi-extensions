import type { MarketplaceRefreshMemory } from "../../domain/update-policy.js";

export type RefreshClaimOwner = NonNullable<NonNullable<MarketplaceRefreshMemory["claim"]>["owner"]>;

/** Process identity authority for reclaiming refresh work after a proven crash. */
export interface RefreshClaimOwnerPort {
  /** Undefined means this process cannot establish safe reclaimable identity. */
  current(): RefreshClaimOwner | undefined;
  status(owner: RefreshClaimOwner): "live" | "dead" | "unknown";
}
