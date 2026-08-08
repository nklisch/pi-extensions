import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../../audit/logger.ts";
import type { PackageRegistrationSnapshot } from "../../packs/package-registration.ts";
import type { PolicyResolver, ResolvedPolicy } from "../policy-cache.ts";

export interface RatchetToolDependencies {
  readonly policyResolver: PolicyResolver;
  readonly packageRegistration: () => PackageRegistrationSnapshot;
  readonly audit: AuditLogger;
  /** Refresh the active-session footer after an approved proposal writes config. */
  readonly refreshOperatorStatus?: (
    ctx: ExtensionContext,
    policy: ResolvedPolicy,
  ) => void;
}

export interface RatchetToolContext {
  readonly extensionContext: ExtensionContext;
  readonly dependencies: RatchetToolDependencies;
}
