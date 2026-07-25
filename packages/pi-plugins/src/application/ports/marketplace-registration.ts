import type {
  MarketplaceRegistrationRequest,
  MarketplaceRegistrationResult,
} from "../adoption-contract.js";
import type { MarketplaceSource } from "../../domain/source.js";

/** The normal marketplace writer. Adoption cannot bypass catalog identity,
 * portability, trust, state compare-and-commit, or lifecycle policy. */
export interface MarketplaceRegistrationPort {
  register(
    request: MarketplaceRegistrationRequest,
    signal: AbortSignal,
  ): Promise<MarketplaceRegistrationResult>;
}

/** Node owns realpath/lstat; registration policy only accepts the verified source. */
export interface MarketplaceLocalSourcePort {
  canonicalize(
    source: Extract<MarketplaceSource, { kind: "local-git" }>,
    signal: AbortSignal,
  ): Promise<Extract<MarketplaceSource, { kind: "local-git" }>>;
}
