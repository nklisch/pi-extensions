import {
  evaluateCompatibility,
} from "../domain/compatibility-evaluator.js";
import {
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilitySnapshot,
} from "../domain/compatibility-policy.js";
import {
  MarketplaceInstallationPolicySchema,
  type MarketplaceInstallationPolicy,
} from "../domain/marketplace.js";
import {
  NormalizedPluginSchema,
  type NormalizedPlugin,
} from "../domain/plugin.js";
import {
  BoundaryError,
  ErrorCodeRegistry,
} from "../domain/errors.js";
import type { CompatibilityReport } from "../domain/compatibility.js";
import { isAbortRejection } from "./abort-rejection.js";
import type { RuntimeCapabilityProbe } from "./ports/runtime-capability-probe.js";

const OPERATION = "probeRuntimeCapabilities";

type CompatibilityAssessmentRequestRecord = Readonly<{
  plugin?: unknown;
  marketplacePolicy?: unknown;
}>;

export type CompatibilityAssessmentRequest = Readonly<{
  plugin: NormalizedPlugin;
  marketplacePolicy?: MarketplaceInstallationPolicy;
}>;

export interface CompatibilityService {
  assess(
    request: CompatibilityAssessmentRequest,
    signal: AbortSignal,
  ): Promise<CompatibilityReport>;
}

function isRecord(value: unknown): value is CompatibilityAssessmentRequestRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRequest(input: unknown): CompatibilityAssessmentRequest {
  if (!isRecord(input)) {
    throw new TypeError("compatibility assessment request must be an object");
  }

  const unknownKeys = Object.keys(input).filter(
    (key) => key !== "plugin" && key !== "marketplacePolicy",
  );
  if (unknownKeys.length > 0) {
    throw new TypeError(`compatibility assessment request contains unknown field: ${unknownKeys[0]}`);
  }

  const plugin = NormalizedPluginSchema.parse(input.plugin);
  const marketplacePolicy = input.marketplacePolicy === undefined
    ? undefined
    : MarketplaceInstallationPolicySchema.parse(input.marketplacePolicy);

  return marketplacePolicy === undefined
    ? { plugin }
    : { plugin, marketplacePolicy };
}

function adapterFailure(cause: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "runtime capability probe failed",
    cause,
  });
}

function validateSnapshot(value: unknown): RuntimeCapabilitySnapshot {
  try {
    return RuntimeCapabilitySnapshotSchema.parse(value);
  } catch (cause) {
    throw adapterFailure(cause);
  }
}

function createService(probe: RuntimeCapabilityProbe): CompatibilityService {
  return {
    async assess(
      request: CompatibilityAssessmentRequest,
      signal: AbortSignal,
    ): Promise<CompatibilityReport> {
      signal.throwIfAborted();
      const validatedRequest = validateRequest(request);

      let rawSnapshot: unknown;
      try {
        rawSnapshot = await probe.snapshot(signal);
      } catch (cause) {
        // An adapter may reject with its own abort error before the signal's
        // state is observable here. Preserve either form without wrapping it.
        if (signal.aborted) throw signal.reason;
        if (isAbortRejection(cause)) throw cause;
        throw adapterFailure(cause);
      }

      // Keep caller cancellation distinct from an unusable adapter handoff.
      signal.throwIfAborted();
      const capabilities = validateSnapshot(rawSnapshot);
      return evaluateCompatibility({
        ...validatedRequest,
        capabilities,
      });
    },
  };
}

export function createCompatibilityService(
  probe: RuntimeCapabilityProbe,
): CompatibilityService {
  if (
    probe === null ||
    typeof probe !== "object" ||
    typeof probe.snapshot !== "function"
  ) {
    throw new TypeError("compatibility service requires a runtime capability probe");
  }
  return createService(probe);
}
