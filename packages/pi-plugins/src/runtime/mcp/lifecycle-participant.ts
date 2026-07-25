import { z } from "zod";
import { isAbortRejection } from "../../application/abort-rejection.js";
import { canonicalJson } from "../../domain/canonical-json.js";
import { compareUtf8 } from "../../domain/canonical-json.js";
import { hashContent } from "../../domain/content-manifest.js";
import { PluginKeySchema, type PluginKey } from "../../domain/identity.js";
import {
  ScopeReferenceSchema,
  type ScopeReference,
} from "../../domain/state/scope.js";
import type { Sha256 } from "../../domain/source.js";
import {
  verifyPluginMcpProjection,
  verifyPluginMcpProjectionAgainstExpectation,
  type PluginMcpProjection,
} from "../../application/mcp-plugin-projection.js";
import {
  CurrentProjectRuntimeContextSchema,
  type CurrentProjectRuntimeContext,
} from "../../application/ports/project-trust.js";
import {
  verifyProjectionExpectation,
  type ProjectionExpectation,
} from "../../application/ports/runtime-projection.js";
import {
  McpRuntimeCapabilitiesSchemaV1,
  McpSourceIdentitySchemaV1,
  McpSourceReplaceResultSchema,
  McpSourceRemoveResultSchema,
  McpSourceStatusSchema,
  type McpLaunchValueProvider,
  type McpRuntimeCapabilities,
  type McpRuntimeLeaseProvider,
  type McpRuntimePort,
  type McpSourceIdentity,
  type McpSourceRegistration,
  type McpSourceStatus,
} from "../../application/ports/mcp-runtime.js";
import {
  McpContributionObservationSchema,
  type McpContributionObservation,
} from "../../application/ports/lifecycle-reload.js";

export type McpLifecycleState =
  | Readonly<{
      kind: "source";
      expectation: Extract<ProjectionExpectation, { kind: "active" }>;
      projection: Extract<PluginMcpProjection, { kind: "source" }>;
      capabilities: McpRuntimeCapabilities;
    }>
  | Readonly<{
      kind: "none";
      expectation: Extract<ProjectionExpectation, { kind: "active" }>;
      projection: Extract<PluginMcpProjection, { kind: "none" }>;
    }>
  | Readonly<{
      kind: "inactive";
      expectation: Extract<ProjectionExpectation, { kind: "inactive" }>;
    }>;

export type McpLifecycleTransitionRequest = Readonly<{
  from: McpLifecycleState;
  to: McpLifecycleState;
  currentProject: CurrentProjectRuntimeContext;
}>;

export const McpLifecycleFailureCodeSchema = z.enum([
  "RUNTIME_UNAVAILABLE",
  "CAPABILITY_MISMATCH",
  "INVALID_TRANSITION",
  "PROJECT_UNTRUSTED",
  "SOURCE_REJECTED",
  "ADAPTER_FAILED",
]);
export type McpLifecycleFailureCode = z.infer<typeof McpLifecycleFailureCodeSchema>;

export const McpLifecycleAmbiguityCodeSchema = z.enum([
  "INSPECTION_AMBIGUOUS",
  "MUTATION_OUTCOME_UNKNOWN",
  "SOURCE_CLEANUP_UNKNOWN",
]);
export type McpLifecycleAmbiguityCode = z.infer<typeof McpLifecycleAmbiguityCodeSchema>;

export const McpLifecycleReconcileResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied") }).strict().readonly(),
  z.object({ kind: z.literal("unchanged") }).strict().readonly(),
  z.object({ kind: z.literal("stale"), current: McpSourceIdentitySchemaV1 }).strict().readonly(),
  z.object({ kind: z.literal("failed"), code: McpLifecycleFailureCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("ambiguous"), code: McpLifecycleAmbiguityCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled") }).strict().readonly(),
]);
export type McpLifecycleReconcileResult = z.infer<typeof McpLifecycleReconcileResultSchema>;

export const McpLifecycleObservationResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    observation: McpContributionObservationSchema,
  }).strict().readonly(),
  z.object({ kind: z.literal("failed"), code: McpLifecycleFailureCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("ambiguous"), code: McpLifecycleAmbiguityCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled") }).strict().readonly(),
]);
export type McpLifecycleObservationResult = z.infer<typeof McpLifecycleObservationResultSchema>;

const McpLifecycleOwnerSchema = z.object({
  scope: ScopeReferenceSchema,
  plugin: PluginKeySchema,
}).strict().readonly();
export type McpLifecycleOwner = z.infer<typeof McpLifecycleOwnerSchema>;

export const McpLifecycleStatusResultSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("ready"),
    owner: McpLifecycleOwnerSchema,
    status: McpSourceStatusSchema.nullable(),
  }).strict().readonly(),
  z.object({ kind: z.literal("unavailable") }).strict().readonly(),
  z.object({ kind: z.literal("failed"), code: McpLifecycleFailureCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("ambiguous"), code: McpLifecycleAmbiguityCodeSchema }).strict().readonly(),
  z.object({ kind: z.literal("cancelled") }).strict().readonly(),
]);
export type McpLifecycleStatusResult = z.infer<typeof McpLifecycleStatusResultSchema>;

export interface McpLifecycleParticipant {
  reconcile(
    request: McpLifecycleTransitionRequest,
    signal: AbortSignal,
  ): Promise<McpLifecycleReconcileResult>;
  observe(
    request: McpLifecycleTransitionRequest,
    signal: AbortSignal,
  ): Promise<McpLifecycleObservationResult>;
  status(owner: McpLifecycleOwner, signal: AbortSignal): Promise<McpLifecycleStatusResult>;
}

class InspectionAmbiguous extends Error {
  constructor() {
    super("MCP inspection evidence is ambiguous");
    this.name = "InspectionAmbiguous";
  }
}

const encoder = new TextEncoder();

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function sameScope(left: ScopeReference, right: ScopeReference): boolean {
  return sameJson(left, right);
}

function sameIdentity(left: McpSourceIdentity, right: McpSourceIdentity): boolean {
  return sameJson(left, right);
}

function stateOwner(state: McpLifecycleState): McpLifecycleOwner {
  const expectation = state.expectation;
  return expectation.kind === "active"
    ? McpLifecycleOwnerSchema.parse({
        scope: expectation.projection.scope,
        plugin: expectation.projection.plugin,
      })
    : McpLifecycleOwnerSchema.parse({ scope: expectation.scope, plugin: expectation.plugin });
}

function sourceIdentity(state: McpLifecycleState): McpSourceIdentity | undefined {
  return state.kind === "source" ? state.projection.registration.source.identity : undefined;
}

function parseState(input: McpLifecycleState, sha256: Sha256): McpLifecycleState {
  const expectation = verifyProjectionExpectation(input.expectation, sha256);
  if (input.kind === "inactive") {
    if (expectation.kind !== "inactive") throw new Error("inactive MCP state requires an inactive expectation");
    return Object.freeze({ kind: "inactive", expectation });
  }
  if (expectation.kind !== "active") throw new Error("active MCP state requires an active expectation");
  const hasMcpServers = expectation.projection.components.mcpServers.length > 0;
  if ((input.kind === "source") !== hasMcpServers) {
    throw new Error("MCP state kind differs from the authoritative component inventory");
  }
  const projection = verifyPluginMcpProjection(input.projection, sha256);
  if (projection.kind !== input.kind) throw new Error("MCP state and projection kind differ");
  const identity = projection.kind === "source"
    ? projection.registration.source.identity
    : projection.identity;
  if (!sameScope(identity.scope, expectation.projection.scope) ||
      identity.plugin !== expectation.projection.plugin ||
      identity.revision !== expectation.projection.revision ||
      identity.projectionDigest !== expectation.projection.digest) {
    throw new Error("MCP projection does not bind the complete projection expectation");
  }
  if (projection.kind === "source") {
    const capabilities = McpRuntimeCapabilitiesSchemaV1.parse(
      (input as Extract<McpLifecycleState, { kind: "source" }>).capabilities,
    );
    const authoritative = verifyPluginMcpProjectionAgainstExpectation({
      claimed: projection,
      projection: expectation.projection,
      runtimeCapabilities: capabilities,
      sha256,
    });
    if (authoritative.kind !== "source") {
      throw new Error("MCP projection differs from the authoritative whole-plugin projection");
    }
    return Object.freeze({
      kind: "source",
      expectation,
      projection: authoritative,
      capabilities,
    });
  }
  return Object.freeze({ kind: "none", expectation, projection });
}

function parseRequest(
  request: McpLifecycleTransitionRequest,
  sha256: Sha256,
): McpLifecycleTransitionRequest {
  const from = parseState(request.from, sha256);
  const to = parseState(request.to, sha256);
  const currentProject = CurrentProjectRuntimeContextSchema.parse(request.currentProject);
  const fromOwner = stateOwner(from);
  const toOwner = stateOwner(to);
  if (!sameScope(fromOwner.scope, toOwner.scope) || fromOwner.plugin !== toOwner.plugin) {
    throw new Error("MCP transition owners differ");
  }
  return Object.freeze({ from, to, currentProject });
}

function projectIsUsable(
  owner: McpLifecycleOwner,
  currentProject: CurrentProjectRuntimeContext,
): boolean {
  return owner.scope.kind !== "project" ||
    (owner.scope.projectKey === currentProject.projectKey && currentProject.trust.kind === "trusted");
}

function requiredCapabilitiesRemain(
  expected: McpRuntimeCapabilities,
  current: McpRuntimeCapabilities,
): boolean {
  const expectedGroups = [expected.sourceLifecycle, expected.transports, expected.oauth, expected.features] as const;
  const currentGroups = [current.sourceLifecycle, current.transports, current.oauth, current.features] as const;
  return expectedGroups.every((group, groupIndex) =>
    Object.entries(group).every(([key, required]) =>
      !required || (currentGroups[groupIndex] as Record<string, boolean>)[key] === true));
}

async function runtimeCapabilities(
  runtime: McpRuntimePort,
  states: readonly McpLifecycleState[],
  signal: AbortSignal,
): Promise<"ready" | "mismatch"> {
  const required = states.filter((state): state is Extract<McpLifecycleState, { kind: "source" }> =>
    state.kind === "source");
  if (required.length === 0) return "ready";
  const current = McpRuntimeCapabilitiesSchemaV1.parse(await runtime.capabilities(signal));
  return required.every((state) => requiredCapabilitiesRemain(state.capabilities, current))
    ? "ready"
    : "mismatch";
}

function uniqueKnownIdentities(states: readonly McpLifecycleState[]): readonly McpSourceIdentity[] {
  const byIdentity = new Map<string, McpSourceIdentity>();
  for (const state of states) {
    const identity = sourceIdentity(state);
    if (identity !== undefined) byIdentity.set(canonicalJson(identity), identity);
  }
  return [...byIdentity.values()];
}

async function inspectOwner(
  runtime: McpRuntimePort,
  owner: McpLifecycleOwner,
  knownIdentities: readonly McpSourceIdentity[],
  signal: AbortSignal,
): Promise<McpSourceStatus | undefined> {
  let statuses: readonly McpSourceStatus[];
  try {
    const raw = await runtime.inspectSources(signal);
    statuses = Object.freeze([...raw].map((status) => McpSourceStatusSchema.parse(status)));
  } catch (error) {
    if (signal.aborted || isAbortRejection(error)) throw error;
    if (error instanceof Error && error.name === "ZodError") throw new InspectionAmbiguous();
    throw error;
  }
  const owned = statuses.filter((status) =>
    sameScope(status.identity.scope, owner.scope) && status.identity.plugin === owner.plugin);
  if (owned.length > 1) throw new InspectionAmbiguous();
  const current = owned[0];
  if (current === undefined) {
    for (const identity of knownIdentities) {
      let direct: McpSourceStatus | undefined;
      try {
        const raw = await runtime.inspectSource(identity, signal);
        direct = raw === undefined ? undefined : McpSourceStatusSchema.parse(raw);
      } catch (error) {
        if (signal.aborted || isAbortRejection(error)) throw error;
        if (error instanceof Error && error.name === "ZodError") throw new InspectionAmbiguous();
        throw error;
      }
      if (direct !== undefined) throw new InspectionAmbiguous();
    }
    return undefined;
  }

  let direct: McpSourceStatus | undefined;
  try {
    const raw = await runtime.inspectSource(current.identity, signal);
    direct = raw === undefined ? undefined : McpSourceStatusSchema.parse(raw);
  } catch (error) {
    if (signal.aborted || isAbortRejection(error)) throw error;
    if (error instanceof Error && error.name === "ZodError") throw new InspectionAmbiguous();
    throw error;
  }
  if (direct === undefined || !sameJson(current, direct)) throw new InspectionAmbiguous();
  for (const identity of knownIdentities) {
    if (sameIdentity(identity, current.identity)) continue;
    const other = await runtime.inspectSource(identity, signal);
    if (other !== undefined) throw new InspectionAmbiguous();
  }
  return current;
}

function sourceStatusMatches(
  status: McpSourceStatus,
  registration: McpSourceRegistration,
): boolean {
  if (!sameIdentity(status.identity, registration.source.identity) ||
      status.registrationDigest !== registration.digest ||
      status.state !== "registered") return false;
  const expected = Object.entries(registration.source.servers)
    .sort(([left], [right]) => compareUtf8(left, right));
  if (expected.length !== status.servers.length) return false;
  return expected.every(([key, server], index) => {
    const observed = status.servers[index];
    return observed !== undefined && observed.key === key &&
      observed.componentId === server.componentId &&
      observed.nativeKey === server.nativeKey &&
      sameJson(observed.provenance, server.provenance);
  });
}

function failed(code: McpLifecycleFailureCode): McpLifecycleReconcileResult {
  return McpLifecycleReconcileResultSchema.parse({ kind: "failed", code });
}

function ambiguous(code: McpLifecycleAmbiguityCode): McpLifecycleReconcileResult {
  return McpLifecycleReconcileResultSchema.parse({ kind: "ambiguous", code });
}

function observationFailure(code: McpLifecycleFailureCode): McpLifecycleObservationResult {
  return McpLifecycleObservationResultSchema.parse({ kind: "failed", code });
}

function observationAmbiguous(code: McpLifecycleAmbiguityCode): McpLifecycleObservationResult {
  return McpLifecycleObservationResultSchema.parse({ kind: "ambiguous", code });
}

function activeSourceObservation(
  state: Extract<McpLifecycleState, { kind: "source" }>,
  currentProject: CurrentProjectRuntimeContext,
): McpContributionObservation {
  const registration = state.projection.registration;
  const entries = Object.entries(registration.source.servers)
    .sort(([left], [right]) => compareUtf8(left, right));
  return McpContributionObservationSchema.parse({
    kind: "active",
    participant: "mcp",
    scope: state.expectation.projection.scope,
    plugin: state.expectation.projection.plugin,
    revision: state.expectation.projection.revision,
    projectionDigest: state.expectation.projection.digest,
    currentProject,
    contributionDigest: state.projection.digest,
    registration: {
      kind: "source",
      identity: registration.source.identity,
      registrationDigest: registration.digest,
      serverKeys: entries.map(([key]) => key),
      componentIds: entries.map(([, server]) => server.componentId).sort(compareUtf8),
    },
  });
}

function activeNoneObservation(
  state: Extract<McpLifecycleState, { kind: "none" }>,
  currentProject: CurrentProjectRuntimeContext,
): McpContributionObservation {
  return McpContributionObservationSchema.parse({
    kind: "active",
    participant: "mcp",
    scope: state.expectation.projection.scope,
    plugin: state.expectation.projection.plugin,
    revision: state.expectation.projection.revision,
    projectionDigest: state.expectation.projection.digest,
    currentProject,
    contributionDigest: state.projection.digest,
    registration: { kind: "none" },
  });
}

function inactiveObservation(
  state: Extract<McpLifecycleState, { kind: "inactive" }>,
  currentProject: CurrentProjectRuntimeContext,
  sha256: Sha256,
): McpContributionObservation {
  const contributionDigest = hashContent(
    encoder.encode(`mcp-inactive-contribution-v1\0${canonicalJson({
      scope: state.expectation.scope,
      plugin: state.expectation.plugin,
      projectionDigest: state.expectation.digest,
    })}`),
    sha256,
  );
  return McpContributionObservationSchema.parse({
    kind: "inactive",
    participant: "mcp",
    scope: state.expectation.scope,
    plugin: state.expectation.plugin,
    projectionDigest: state.expectation.digest,
    currentProject,
    contributionDigest,
    registration: { kind: "none" },
  });
}

export function createMcpLifecycleParticipant(input: Readonly<{
  runtime?: McpRuntimePort;
  launchValues(registration: McpSourceRegistration): McpLaunchValueProvider;
  runtimeLeases(registration: McpSourceRegistration): McpRuntimeLeaseProvider;
  sha256: Sha256;
}>): McpLifecycleParticipant {
  if (input === null || typeof input !== "object" ||
      typeof input.launchValues !== "function" ||
      typeof input.runtimeLeases !== "function" ||
      typeof input.sha256 !== "function") {
    throw new TypeError("MCP lifecycle participant dependencies are required");
  }

  async function reconcile(
    requestInput: McpLifecycleTransitionRequest,
    signal: AbortSignal,
  ): Promise<McpLifecycleReconcileResult> {
    if (signal.aborted) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
    let request: McpLifecycleTransitionRequest;
    try {
      request = parseRequest(requestInput, input.sha256);
    } catch {
      return failed("INVALID_TRANSITION");
    }
    const owner = stateOwner(request.to);
    if (!projectIsUsable(owner, request.currentProject)) return failed("PROJECT_UNTRUSTED");
    const needsRuntime = request.from.kind === "source" || request.to.kind === "source";
    if (input.runtime === undefined) {
      return needsRuntime ? failed("RUNTIME_UNAVAILABLE") : McpLifecycleReconcileResultSchema.parse({ kind: "unchanged" });
    }
    const runtime = input.runtime;
    try {
      if (await runtimeCapabilities(runtime, [request.from, request.to], signal) === "mismatch") {
        return failed("CAPABILITY_MISMATCH");
      }
    } catch (error) {
      if (signal.aborted || isAbortRejection(error)) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
      return failed("ADAPTER_FAILED");
    }

    const knownIdentities = uniqueKnownIdentities([request.from, request.to]);
    let current: McpSourceStatus | undefined;
    try {
      current = await inspectOwner(runtime, owner, knownIdentities, signal);
    } catch (error) {
      if (signal.aborted || isAbortRejection(error)) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
      return error instanceof InspectionAmbiguous
        ? ambiguous("INSPECTION_AMBIGUOUS")
        : failed("ADAPTER_FAILED");
    }

    if (request.to.kind === "source") {
      const registration = request.to.projection.registration;
      if (current !== undefined && sameIdentity(current.identity, registration.source.identity)) {
        return sourceStatusMatches(current, registration)
          ? McpLifecycleReconcileResultSchema.parse({ kind: "unchanged" })
          : ambiguous("INSPECTION_AMBIGUOUS");
      }
      let expected: Readonly<{ kind: "absent" }> | Readonly<{ kind: "exact"; identity: McpSourceIdentity }>;
      if (current === undefined) {
        expected = { kind: "absent" };
      } else {
        const previousIdentity = sourceIdentity(request.from);
        if (previousIdentity === undefined || !sameIdentity(current.identity, previousIdentity)) {
          return McpLifecycleReconcileResultSchema.parse({ kind: "stale", current: current.identity });
        }
        expected = { kind: "exact", identity: previousIdentity };
      }

      try {
        const validation = await runtime.validateSource(registration, signal);
        if (!validation.ok || !sameJson(validation.value, registration)) return failed("SOURCE_REJECTED");
      } catch (error) {
        if (signal.aborted || isAbortRejection(error)) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
        return failed("ADAPTER_FAILED");
      }
      let launchValues: McpLaunchValueProvider;
      let runtimeLeases: McpRuntimeLeaseProvider;
      try {
        launchValues = input.launchValues(registration);
        runtimeLeases = input.runtimeLeases(registration);
      } catch {
        return failed("ADAPTER_FAILED");
      }
      if (signal.aborted) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
      try {
        const result = McpSourceReplaceResultSchema.parse(await runtime.replaceSource({
          registration,
          expected,
          launchValues,
          runtimeLeases,
        }, signal));
        if (result.kind === "stale") {
          return McpLifecycleReconcileResultSchema.parse({ kind: "stale", current: result.currentIdentity });
        }
        if (result.kind === "rejected") return failed("SOURCE_REJECTED");
      } catch {
        return ambiguous("MUTATION_OUTCOME_UNKNOWN");
      }
      try {
        const observed = await inspectOwner(runtime, owner, knownIdentities, signal);
        return observed !== undefined && sourceStatusMatches(observed, registration)
          ? McpLifecycleReconcileResultSchema.parse({ kind: "applied" })
          : ambiguous("MUTATION_OUTCOME_UNKNOWN");
      } catch {
        return ambiguous("MUTATION_OUTCOME_UNKNOWN");
      }
    }

    const previousIdentity = sourceIdentity(request.from);
    if (current !== undefined && (previousIdentity === undefined || !sameIdentity(current.identity, previousIdentity))) {
      return McpLifecycleReconcileResultSchema.parse({ kind: "stale", current: current.identity });
    }
    if (previousIdentity === undefined && current === undefined) {
      return McpLifecycleReconcileResultSchema.parse({ kind: "unchanged" });
    }
    // An exact from-source removal is replayed even when registration is absent;
    // only the runtime can prove provider/process/cache/lease residue is gone.
    if (previousIdentity === undefined) return failed("INVALID_TRANSITION");
    if (signal.aborted) return McpLifecycleReconcileResultSchema.parse({ kind: "cancelled" });
    try {
      const result = McpSourceRemoveResultSchema.parse(await runtime.removeSource(previousIdentity, signal));
      if (result.kind === "ownership-mismatch") {
        return McpLifecycleReconcileResultSchema.parse({ kind: "stale", current: result.currentIdentity });
      }
    } catch {
      return ambiguous("SOURCE_CLEANUP_UNKNOWN");
    }
    try {
      const observed = await inspectOwner(runtime, owner, knownIdentities, signal);
      return observed === undefined
        ? McpLifecycleReconcileResultSchema.parse({ kind: "applied" })
        : ambiguous("SOURCE_CLEANUP_UNKNOWN");
    } catch {
      return ambiguous("SOURCE_CLEANUP_UNKNOWN");
    }
  }

  async function observe(
    requestInput: McpLifecycleTransitionRequest,
    signal: AbortSignal,
  ): Promise<McpLifecycleObservationResult> {
    if (signal.aborted) return McpLifecycleObservationResultSchema.parse({ kind: "cancelled" });
    let request: McpLifecycleTransitionRequest;
    try {
      request = parseRequest(requestInput, input.sha256);
    } catch {
      return observationFailure("INVALID_TRANSITION");
    }
    const owner = stateOwner(request.to);
    if (!projectIsUsable(owner, request.currentProject)) return observationFailure("PROJECT_UNTRUSTED");
    const structuralAbsence = request.from.kind !== "source" && request.to.kind !== "source";
    if (input.runtime === undefined) {
      if (!structuralAbsence) return observationFailure("RUNTIME_UNAVAILABLE");
      if (request.to.kind === "none") {
        return McpLifecycleObservationResultSchema.parse({
          kind: "ready",
          observation: activeNoneObservation(request.to, request.currentProject),
        });
      }
      if (request.to.kind === "inactive") {
        return McpLifecycleObservationResultSchema.parse({
          kind: "ready",
          observation: inactiveObservation(request.to, request.currentProject, input.sha256),
        });
      }
      return observationFailure("RUNTIME_UNAVAILABLE");
    }
    const runtime = input.runtime;
    try {
      if (await runtimeCapabilities(runtime, [request.to], signal) === "mismatch") {
        return observationFailure("CAPABILITY_MISMATCH");
      }
      const current = await inspectOwner(
        runtime,
        owner,
        uniqueKnownIdentities([request.from, request.to]),
        signal,
      );
      if (request.to.kind === "source") {
        if (current === undefined || !sourceStatusMatches(current, request.to.projection.registration)) {
          return observationAmbiguous("INSPECTION_AMBIGUOUS");
        }
        return McpLifecycleObservationResultSchema.parse({
          kind: "ready",
          observation: activeSourceObservation(request.to, request.currentProject),
        });
      }
      if (current !== undefined) return observationAmbiguous("INSPECTION_AMBIGUOUS");
      const observation = request.to.kind === "none"
        ? activeNoneObservation(request.to, request.currentProject)
        : inactiveObservation(request.to, request.currentProject, input.sha256);
      return McpLifecycleObservationResultSchema.parse({ kind: "ready", observation });
    } catch (error) {
      if (signal.aborted || isAbortRejection(error)) return McpLifecycleObservationResultSchema.parse({ kind: "cancelled" });
      return error instanceof InspectionAmbiguous
        ? observationAmbiguous("INSPECTION_AMBIGUOUS")
        : observationFailure("ADAPTER_FAILED");
    }
  }

  async function status(
    ownerInput: McpLifecycleOwner,
    signal: AbortSignal,
  ): Promise<McpLifecycleStatusResult> {
    if (signal.aborted) return McpLifecycleStatusResultSchema.parse({ kind: "cancelled" });
    let owner: McpLifecycleOwner;
    try {
      owner = McpLifecycleOwnerSchema.parse(ownerInput);
    } catch {
      return McpLifecycleStatusResultSchema.parse({ kind: "failed", code: "INVALID_TRANSITION" });
    }
    if (input.runtime === undefined) return McpLifecycleStatusResultSchema.parse({ kind: "unavailable" });
    try {
      const observed = await inspectOwner(input.runtime, owner, [], signal);
      return McpLifecycleStatusResultSchema.parse({
        kind: "ready",
        owner,
        status: observed ?? null,
      });
    } catch (error) {
      if (signal.aborted || isAbortRejection(error)) return McpLifecycleStatusResultSchema.parse({ kind: "cancelled" });
      return error instanceof InspectionAmbiguous
        ? McpLifecycleStatusResultSchema.parse({ kind: "ambiguous", code: "INSPECTION_AMBIGUOUS" })
        : McpLifecycleStatusResultSchema.parse({ kind: "failed", code: "ADAPTER_FAILED" });
    }
  }

  return Object.freeze({ reconcile, observe, status });
}

export type {
  CurrentProjectRuntimeContext,
  McpContributionObservation,
  PluginKey,
  ProjectionExpectation,
  ScopeReference,
};
