import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { AuditLogger } from "../../audit/logger.ts";
import type { PackageRegistrationSnapshot } from "../../packs/package-registration.ts";
import type { PolicyResolver } from "../policy-cache.ts";

export interface RatchetToolDependencies {
  readonly policyResolver: PolicyResolver;
  readonly packageRegistration: () => PackageRegistrationSnapshot;
  readonly audit: AuditLogger;
}

export interface RatchetToolContext {
  readonly extensionContext: ExtensionContext;
  readonly dependencies: RatchetToolDependencies;
}
