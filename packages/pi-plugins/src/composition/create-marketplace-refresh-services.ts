import {
  createNodeMarketplaceUpdateServices,
  type NodeMarketplaceUpdateServices,
  type NodeMarketplaceUpdateServicesOptions,
} from "./create-marketplace-update-services.js";

export type NodeMarketplaceRefreshServicesOptions = NodeMarketplaceUpdateServicesOptions;
export type NodeMarketplaceRefreshServices = NodeMarketplaceUpdateServices;

/** Compatibility name retained for existing hosts and direct module imports. */
export function createNodeMarketplaceRefreshServices(
  options: NodeMarketplaceRefreshServicesOptions,
): NodeMarketplaceRefreshServices {
  return createNodeMarketplaceUpdateServices(options);
}
