import { satisfies, valid, validRange } from "semver";
import type { RuntimeCapabilityProbe } from "./ports/runtime-capability-probe.js";
import {
  SubagentLifecycleCapabilitiesSchemaV1,
  type SubagentLifecycleCapabilities,
  type SubagentLifecyclePort,
} from "./ports/subagent-lifecycle.js";
import {
  RuntimeCapabilityRegistry,
  RuntimeCapabilitySnapshotSchema,
  type RuntimeCapabilitySnapshot,
} from "../domain/compatibility-policy.js";
import { BoundaryError, ErrorCodeRegistry } from "../domain/errors.js";
import { isAbortRejection } from "./abort-rejection.js";

const OPERATION = "probeSubagentLifecycleCapabilities";

function adapterFailure(cause: unknown): BoundaryError {
  return new BoundaryError({
    code: ErrorCodeRegistry.adapterFailed,
    operation: OPERATION,
    message: "Subagent lifecycle capability probe failed",
    cause,
  });
}

function allTrue(values: Readonly<Record<string, boolean>>): boolean {
  return Object.values(values).every((value) => value === true);
}

function productionQualificationAvailable(
  capabilities: SubagentLifecycleCapabilities,
  runtime: Readonly<{ nodeVersion: string; piVersion: string }>,
): boolean {
  if (capabilities.provider.kind !== "published-package") return false;
  const packageVersion = valid(capabilities.provider.version);
  const nodeRange = validRange(capabilities.provider.nodeEngine);
  const piRange = validRange(capabilities.provider.piPeerRange);
  if (packageVersion === null || nodeRange === null || piRange === null) {
    throw new TypeError("published package qualification contains invalid semver evidence");
  }
  return (
    allTrue(capabilities.semantics) &&
    allTrue(capabilities.coverage) &&
    satisfies(runtime.nodeVersion, nodeRange, { includePrerelease: true }) &&
    satisfies(runtime.piVersion, piRange, { includePrerelease: true })
  );
}

function withLifecycleFact(
  base: RuntimeCapabilitySnapshot,
  capturedBy: string,
  available: boolean,
  explanation: string,
): RuntimeCapabilitySnapshot {
  return RuntimeCapabilitySnapshotSchema.parse({
    capabilities: {
      ...base.capabilities,
      [RuntimeCapabilityRegistry.subagentInterception.id]: {
        status: available ? "available" : "unavailable",
        explanation,
      },
    },
    capturedBy,
  });
}

/**
 * Decorate one complete capability snapshot. Absence is an expected production
 * configuration; malformed evidence from a present adapter remains a boundary
 * failure so it cannot be mistaken for honest package absence.
 */
export function createSubagentLifecycleCapabilityProbe(input: Readonly<{
  base: RuntimeCapabilityProbe;
  lifecycle?: Pick<SubagentLifecyclePort, "capabilities">;
  capturedBy: string;
  runtime: Readonly<{ nodeVersion: string; piVersion: string }>;
}>): RuntimeCapabilityProbe {
  if (
    input === null ||
    typeof input !== "object" ||
    input.base === null ||
    typeof input.base !== "object" ||
    typeof input.base.snapshot !== "function"
  ) {
    throw new TypeError("subagent lifecycle capability probe requires a base probe");
  }
  if (typeof input.capturedBy !== "string" || input.capturedBy.length === 0) {
    throw new TypeError("subagent lifecycle capability probe requires a capture identity");
  }
  if (
    valid(input.runtime?.nodeVersion) === null ||
    valid(input.runtime?.piVersion) === null
  ) {
    throw new TypeError("subagent lifecycle capability probe requires exact runtime versions");
  }

  return Object.freeze({
    async snapshot(signal: AbortSignal): Promise<RuntimeCapabilitySnapshot> {
      signal.throwIfAborted();

      let base: RuntimeCapabilitySnapshot;
      try {
        base = RuntimeCapabilitySnapshotSchema.parse(
          await input.base.snapshot(signal),
        );
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (isAbortRejection(cause)) throw cause;
        throw adapterFailure(cause);
      }
      signal.throwIfAborted();

      if (input.lifecycle === undefined) {
        return withLifecycleFact(
          base,
          input.capturedBy,
          false,
          "No qualified published subagent lifecycle package is composed",
        );
      }

      let capabilities: SubagentLifecycleCapabilities;
      try {
        capabilities = SubagentLifecycleCapabilitiesSchemaV1.parse(
          await input.lifecycle.capabilities(signal),
        );
        signal.throwIfAborted();
        const available = productionQualificationAvailable(
          capabilities,
          input.runtime,
        );
        return withLifecycleFact(
          base,
          input.capturedBy,
          available,
          available
            ? "Published subagent lifecycle package passed complete qualification"
            : capabilities.provider.kind === "test"
              ? "Test lifecycle evidence cannot qualify production capability"
              : "Published subagent lifecycle qualification is incomplete or runtime-incompatible",
        );
      } catch (cause) {
        if (signal.aborted) throw signal.reason;
        if (isAbortRejection(cause)) throw cause;
        throw adapterFailure(cause);
      }
    },
  });
}
