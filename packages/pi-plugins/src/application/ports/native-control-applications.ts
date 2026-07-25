import type { AdoptionService } from "../adoption-service.js";
import type { HostStatusSnapshot } from "../host-observation-contract.js";
import type { MarketplaceCatalogService } from "../marketplace-catalog-service.js";
import type { MarketplaceRefreshService } from "../marketplace-refresh-service.js";
import type { MarketplaceRegistrationService } from "../marketplace-registration-service.js";
import type { NativeInspectionService } from "../native-inspection-contract.js";
import type { NativeLifecycleOperationService } from "../native-lifecycle-operation-contract.js";
import type { NativeUpdateManagementService } from "../native-update-management-service.js";
import type { TrustedInstallationService } from "../trusted-install-contract.js";
import type { HostPrecedenceService } from "../host-precedence-service.js";
import type { NativeControlExecutionId } from "../native-control-contract.js";
import type { NativeControlInputPort } from "./native-control-input.js";
import type { NativeControlProgressSink } from "./native-control-execution.js";
import type { NativeControlCurrentProjectPort } from "../native-control-selection.js";

export interface NativeControlHostStatusPort {
  snapshot(): HostStatusSnapshot;
}

export interface NativeControlConfigPort {
  readonly hostPrecedence: Pick<HostPrecedenceService, "setHostPrecedence">;
}

export interface NativeControlMarketplacePort {
  readonly registration: Pick<MarketplaceRegistrationService, "add" | "remove" | "list">;
  readonly refresh: Pick<MarketplaceRefreshService, "refresh">;
  readonly catalog: Pick<MarketplaceCatalogService, "search" | "detail">;
  readonly adoption: Pick<AdoptionService, "preview" | "import">;
}

export type NativeControlApplicationDependencies = Readonly<{
  marketplace: NativeControlMarketplacePort;
  inspection: NativeInspectionService;
  trustedInstallation: TrustedInstallationService;
  operations: NativeLifecycleOperationService;
  updates: NativeUpdateManagementService;
  config: NativeControlConfigPort;
  status: NativeControlHostStatusPort;
  currentProject: NativeControlCurrentProjectPort;
}>;

export type NativeControlDispatchContext = Readonly<{
  executionId: NativeControlExecutionId;
  input: NativeControlInputPort;
  progress: NativeControlProgressSink;
  readiness: HostStatusSnapshot;
}>;
