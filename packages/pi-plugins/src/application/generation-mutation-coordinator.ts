import { BoundaryError } from "../domain/errors.js";
import { PluginKeySchema, type PluginKey } from "../domain/identity.js";
import { z } from "zod";
import {
  GenerationSchema,
  HostConfigDocumentSchema,
  type Generation,
} from "../domain/state/config-state.js";
import { InstalledUserStateDocumentSchema } from "../domain/state/installed-state.js";
import { ProjectLocalStateDocumentSchema } from "../domain/state/project-state.js";
import { StatePointersDocumentSchema } from "../domain/state/pointers.js";
import { TrustStateDocumentSchema } from "../domain/state/trust-state.js";
import { StateCorruptionSchema } from "../domain/state/codec.js";
import {
  ProjectIdentitySchema,
  ProjectKeySchema,
  ScopeContextSchema,
  ScopeReferenceSchema,
  toScopeReference,
  type ScopeContext,
  type ScopeReference,
} from "../domain/state/scope.js";
import {
  isVerifiedStateMutation,
  StateLoadFailureSchema,
  type GenerationSnapshot,
  type StateCommitResult,
  type StateLoadResult,
  type VerifiedStateMutation,
} from "./state-contract.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import type { ScopeLockLease, ScopeLockManager } from "./ports/scope-lock.js";
import type {
  KeyedMutationScheduler,
  MutationSubject,
} from "./mutation-coordination.js";

export type PreparedMutationRequest = Readonly<{
  scope: ScopeContext;
  plugins: readonly PluginKey[];
  expectedGeneration: Generation;
}>;

export type PreparedMutationContext = Readonly<{
  snapshot: GenerationSnapshot;
  assertOwned(): Promise<void>;
}>;

export type PreparedMutation<T> = Readonly<{
  mutation: VerifiedStateMutation;
  value: T;
  /** Last authority check while the scope lease is still owned, immediately before durable commit. */
  beforeCommit?: () => Promise<void>;
}>;

export type GenerationMutationResult<T> =
  | Readonly<{
      kind: "committed";
      value: T;
      snapshot: GenerationSnapshot;
    }>
  | Readonly<{
      kind: "stale-generation";
      expected: Generation;
      actual: Generation;
    }>
  | Readonly<{
      kind: "commit-failed";
      value: T;
      expected: Generation;
      actual: Generation;
    }>
  | Readonly<{
      kind: "commit-ambiguous";
      value: T;
      expected: Generation;
      actual?: Generation;
    }>;

/** Retains both failures when a mutation and its lock cleanup fail together. */
export class MutationCleanupError extends Error {
  readonly operationError: unknown;
  readonly cleanupError: unknown;
  readonly causes: readonly [unknown, unknown];
  readonly outcome: GenerationMutationResult<unknown> | undefined;
  readonly observedSnapshot: GenerationSnapshot | undefined;

  constructor(
    operationError: unknown,
    cleanupError: unknown,
    evidence: Readonly<{
      outcome?: GenerationMutationResult<unknown>;
      observedSnapshot?: GenerationSnapshot;
    }> = {},
  ) {
    super("mutation failed and scope-lock cleanup also failed", { cause: operationError });
    this.name = "MutationCleanupError";
    this.operationError = operationError;
    this.cleanupError = cleanupError;
    this.causes = [operationError, cleanupError];
    this.outcome = evidence.outcome;
    this.observedSnapshot = evidence.observedSnapshot;
  }
}

/**
 * A committed state result is durable even if the lease cannot be cleaned up.
 * Callers receive the evidence needed to inspect/recover instead of blindly
 * replaying a mutation whose promotion may already be visible.
 */
export class CommittedMutationCleanupError<T> extends Error {
  readonly committed: Readonly<{ value: T; snapshot: GenerationSnapshot }>;
  readonly cleanupError: unknown;
  override readonly cause: unknown;

  constructor(committed: Readonly<{ value: T; snapshot: GenerationSnapshot }>, cleanupError: unknown) {
    super("mutation committed but scope-lock cleanup failed", { cause: cleanupError });
    this.name = "CommittedMutationCleanupError";
    this.committed = committed;
    this.cleanupError = cleanupError;
    this.cause = cleanupError;
  }
}

export interface GenerationMutationCoordinator {
  runPreparedMutation<T>(
    request: PreparedMutationRequest,
    prepareCommit: (context: PreparedMutationContext) => Promise<PreparedMutation<T>>,
    signal: AbortSignal,
  ): Promise<GenerationMutationResult<T>>;
}

export type GenerationMutationCoordinatorDependencies = Readonly<{
  scheduler: KeyedMutationScheduler;
  locks: ScopeLockManager;
  state: LifecycleStateStore;
}>;

function assertSignal(signal: AbortSignal): void {
  if (
    signal === null ||
    typeof signal !== "object" ||
    typeof signal.addEventListener !== "function" ||
    typeof signal.removeEventListener !== "function" ||
    typeof signal.aborted !== "boolean"
  ) {
    throw new TypeError("prepared mutation requires an AbortSignal");
  }
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const keys = Object.keys(leftRecord);
  return keys.length === Object.keys(rightRecord).length && keys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key) && sameJson(leftRecord[key], rightRecord[key]));
}

function sameScopeContext(left: ScopeContext, right: ScopeContext): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "user" || right.kind === "user") return true;
  return left.projectKey === right.projectKey && sameJson(left.identity, right.identity);
}

function sameScopeReference(left: ScopeReference, right: ScopeReference): boolean {
  if (left.kind === "user") return right.kind === "user";
  return right.kind === "project" && left.projectKey === right.projectKey;
}

function validateRequest(request: PreparedMutationRequest): {
  readonly scope: ScopeContext;
  readonly scopeReference: ScopeReference;
  readonly plugins: readonly PluginKey[];
} {
  if (request === null || typeof request !== "object") throw new TypeError("prepared mutation request is required");
  const scope = ScopeContextSchema.parse(request.scope);
  const expectedGeneration = GenerationSchema.parse(request.expectedGeneration);
  void expectedGeneration;
  if (!Array.isArray(request.plugins)) throw new TypeError("prepared mutation plugins must be an array");
  const plugins = request.plugins.map((plugin) => PluginKeySchema.parse(plugin));
  if (new Set(plugins).size !== plugins.length) throw new TypeError("prepared mutation plugins must be unique");
  return {
    scope,
    scopeReference: toScopeReference(scope),
    plugins,
  };
}

function subjects(scope: ScopeReference, plugins: readonly PluginKey[]): readonly MutationSubject[] {
  return plugins.map((plugin) => ({ scope, plugin }));
}

const UserGenerationSnapshotSchema = z.object({
  scope: z.object({ kind: z.literal("user") }).strict().readonly(),
  generation: GenerationSchema,
  pointers: StatePointersDocumentSchema,
  config: HostConfigDocumentSchema,
  installed: InstalledUserStateDocumentSchema,
  trust: TrustStateDocumentSchema,
  corruptions: z.array(StateCorruptionSchema).readonly(),
}).strict().readonly();

const ProjectGenerationSnapshotSchema = z.object({
  scope: z.object({
    kind: z.literal("project"),
    identity: ProjectIdentitySchema,
    projectKey: ProjectKeySchema,
  }).strict().readonly(),
  generation: GenerationSchema,
  pointers: StatePointersDocumentSchema,
  project: ProjectLocalStateDocumentSchema,
  corruptions: z.array(StateCorruptionSchema).readonly(),
}).strict().readonly();

function validateSnapshot(snapshot: unknown, scope: ScopeContext): GenerationSnapshot {
  if (snapshot === null || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new Error("state store returned an invalid generation snapshot");
  }
  const parsedScope = ScopeContextSchema.parse(scope);
  const parsed = parsedScope.kind === "user"
    ? UserGenerationSnapshotSchema.parse(snapshot)
    : ProjectGenerationSnapshotSchema.parse(snapshot);
  const normalized = parsed as unknown as GenerationSnapshot;
  const snapshotScope = ScopeContextSchema.parse(normalized.scope);
  if (!sameScopeContext(snapshotScope, parsedScope) || !sameScopeReference(toScopeReference(snapshotScope), toScopeReference(parsedScope))) {
    throw new Error("state store returned a snapshot for the wrong scope");
  }
  const generation = GenerationSchema.parse(parsed.generation);
  const pointers = StatePointersDocumentSchema.parse(parsed.pointers);
  if (pointers.generation !== generation || !sameScopeReference(pointers.scope, toScopeReference(parsedScope))) {
    throw new Error("state store returned pointers for the wrong scope or generation");
  }
  for (const corruption of normalized.corruptions) {
    if (!sameScopeReference(corruption.scope, toScopeReference(parsedScope))) {
      throw new Error("state store returned a corruption for the wrong scope");
    }
  }
  if (parsedScope.kind === "user") {
    const user = normalized as z.infer<typeof UserGenerationSnapshotSchema>;
    if (user.config.generation !== generation || user.installed.generation !== generation || user.trust.generation !== generation) {
      throw new Error("state store returned a user document for the wrong generation");
    }
    return user as unknown as GenerationSnapshot;
  }
  const project = normalized as z.infer<typeof ProjectGenerationSnapshotSchema>;
  if (
    project.project.generation !== generation ||
    project.project.projectKey !== parsedScope.projectKey ||
    !sameJson(project.project.identity, parsedScope.identity)
  ) {
    throw new Error("state store returned a project document for the wrong scope or generation");
  }
  return project as unknown as GenerationSnapshot;
}

function loadFailure(result: Extract<StateLoadResult, { ok: false }>): Error {
  return new BoundaryError({
    code: "ADAPTER_FAILED",
    operation: "generation-mutation.read",
    message: "authoritative lifecycle state could not be loaded for mutation",
    cause: result,
  });
}

function sameScopeOrThrow(candidate: ScopeContext, expected: ScopeContext, operation: string): ScopeContext {
  const parsed = ScopeContextSchema.parse(candidate);
  if (!sameScopeContext(parsed, expected) || !sameScopeReference(toScopeReference(parsed), toScopeReference(expected))) {
    throw new Error(`state store returned a snapshot for the wrong scope during ${operation}`);
  }
  return parsed;
}

function validateLoadResult(result: StateLoadResult, scope: ScopeContext): StateLoadResult {
  if (result === null || typeof result !== "object") throw new Error("state store returned an invalid load result");
  if (result.ok === true) {
    return { ok: true, snapshot: validateSnapshot(result.snapshot, scope) };
  }
  if (result.ok !== false) throw new Error("state store returned an unknown load result");
  const failure = StateLoadFailureSchema.parse(result);
  sameScopeOrThrow(failure.scope, scope, "load failure");
  const expectedReference = toScopeReference(scope);
  for (const corruption of failure.corruptions) {
    if (!sameScopeReference(ScopeReferenceSchema.parse(corruption.scope), expectedReference)) {
      throw new Error("state store returned a load corruption for the wrong scope");
    }
  }
  return result;
}

function staleResult(expected: Generation, actual: Generation): GenerationMutationResult<never> {
  return {
    kind: "stale-generation",
    expected: GenerationSchema.parse(expected),
    actual: GenerationSchema.parse(actual),
  };
}

function validatePreparedMutation<T>(
  prepared: PreparedMutation<T>,
  request: PreparedMutationRequest,
  scope: ScopeContext,
): PreparedMutation<T> {
  if (prepared === null || typeof prepared !== "object") throw new TypeError("prepared mutation callback must return a mutation");
  if (!isVerifiedStateMutation(prepared.mutation)) {
    throw new TypeError("prepared mutation callback must return a verified state mutation");
  }
  if (prepared.mutation.expectedGeneration !== request.expectedGeneration) {
    throw new TypeError("prepared state mutation generation does not match the request");
  }
  const mutationScope = ScopeContextSchema.parse(prepared.mutation.scope);
  if (!sameScopeContext(mutationScope, scope) || !sameScopeReference(toScopeReference(mutationScope), toScopeReference(scope))) {
    throw new TypeError("prepared state mutation scope does not match the request");
  }
  return prepared;
}

function nextGenerationDocument<T extends Readonly<{ generation: Generation }>>(
  document: T,
  generation: Generation,
): T {
  return { ...document, generation } as T;
}

function compatibleDocumentEqual(actual: unknown, expected: unknown): boolean {
  // Only one current version exists, so commit acknowledgment is an exact
  // comparison; there is no legacy envelope to normalize first.
  return sameJson(actual, expected);
}

function samePointerShape(
  before: GenerationSnapshot,
  after: GenerationSnapshot,
  generation: Generation,
): boolean {
  if (after.pointers.generation !== generation || !sameScopeReference(after.pointers.scope, before.pointers.scope)) return false;
  const beforeKinds = before.pointers.documents.map((pointer) => pointer.kind).sort();
  const afterKinds = after.pointers.documents.map((pointer) => pointer.kind).sort();
  return sameJson(beforeKinds, afterKinds) && after.pointers.documents.every((pointer) => pointer.generation === generation);
}

/**
 * A generation increment alone is not proof that this mutation committed: a
 * faulty or adversarial store could report an unrelated write at expected+1.
 * Compare every snapshot document against the pre-commit snapshot with the
 * verified replacement applied, while treating pointer digests as authority-
 * owned implementation evidence (their schema/scope/generation are checked).
 */
function provesMutationResult(
  before: GenerationSnapshot,
  after: GenerationSnapshot,
  mutation: VerifiedStateMutation,
): boolean {
  const next = GenerationSchema.parse(before.generation + 1);
  if (after.generation !== next || !sameScopeContext(after.scope, before.scope) || !samePointerShape(before, after, next)) return false;
  if (!sameJson(after.corruptions, before.corruptions)) return false;

  if (
    "config" in before && "config" in after &&
    "installed" in before && "installed" in after &&
    "trust" in before && "trust" in after &&
    mutation.scope.kind === "user"
  ) {
    const replacement = mutation.replace;
    if ("project" in replacement) return false;
    return compatibleDocumentEqual(after.config, nextGenerationDocument(replacement.config ?? before.config, next)) &&
      compatibleDocumentEqual(after.installed, nextGenerationDocument(replacement.installed ?? before.installed, next)) &&
      sameJson(after.trust, nextGenerationDocument(replacement.trust ?? before.trust, next));
  }
  if ("project" in before && "project" in after && mutation.scope.kind === "project" && "project" in mutation.replace) {
    return compatibleDocumentEqual(after.project, nextGenerationDocument(mutation.replace.project, next));
  }
  return false;
}

function validateCommitResult(
  result: StateCommitResult,
  request: PreparedMutationRequest,
  scope: ScopeContext,
  before: GenerationSnapshot,
  mutation: VerifiedStateMutation,
): StateCommitResult {
  if (result === null || typeof result !== "object") throw new Error("state store returned an invalid commit result");
  if (result.kind === "stale-generation") {
    const expected = GenerationSchema.parse(result.expected);
    const actual = GenerationSchema.parse(result.actual);
    if (expected !== request.expectedGeneration || actual <= expected) {
      throw new Error("state store returned an invalid stale generation result");
    }
    return { kind: "stale-generation", expected, actual };
  }
  if (result.kind !== "committed") throw new Error("state store returned an unknown commit result");
  const snapshot = validateSnapshot(result.snapshot, scope);
  const expectedNext = GenerationSchema.parse(GenerationSchema.parse(request.expectedGeneration) + 1);
  if (snapshot.generation !== expectedNext || !provesMutationResult(before, snapshot, mutation)) {
    throw new Error("state store committed evidence does not prove this mutation");
  }
  return { kind: "committed", snapshot };
}

type CommitReconciliation<T> = Readonly<{
  outcome: GenerationMutationResult<T>;
  committed?: Readonly<{ value: T; snapshot: GenerationSnapshot }>;
  observedSnapshot?: GenerationSnapshot;
}>;

async function reconcileCommitFailure<T>(
  dependencies: GenerationMutationCoordinatorDependencies,
  lease: ScopeLockLease,
  scope: ScopeContext,
  expectedGeneration: Generation,
  before: GenerationSnapshot,
  mutation: VerifiedStateMutation,
  value: T,
): Promise<CommitReconciliation<T>> {
  const recoverySignal = new AbortController().signal;
  try {
    await lease.assertOwned(recoverySignal);
    const loaded = validateLoadResult(await dependencies.state.read(scope, recoverySignal), scope);
    if (!loaded.ok) {
      return { outcome: { kind: "commit-ambiguous", value, expected: expectedGeneration } };
    }
    const snapshot = loaded.snapshot;
    const expectedNext = GenerationSchema.parse(expectedGeneration + 1);
    if (snapshot.generation === expectedNext && provesMutationResult(before, snapshot, mutation)) {
      const committed = { value, snapshot };
      return { outcome: { kind: "committed", ...committed }, committed };
    }
    if (snapshot.generation === expectedGeneration) {
      return {
        outcome: {
          kind: "commit-failed",
          value,
          expected: expectedGeneration,
          actual: snapshot.generation,
        },
        observedSnapshot: snapshot,
      };
    }
    return {
      outcome: {
        kind: "commit-ambiguous",
        value,
        expected: expectedGeneration,
        actual: snapshot.generation,
      },
      observedSnapshot: snapshot,
    };
  } catch {
    // A malformed or unavailable authority read cannot prove that the durable
    // write did not happen. Preserve an explicit recovery outcome rather than
    // returning the caller's cancellation/error as if it settled the commit.
    return { outcome: { kind: "commit-ambiguous", value, expected: expectedGeneration } };
  }
}

class Coordinator implements GenerationMutationCoordinator {
  constructor(private readonly dependencies: GenerationMutationCoordinatorDependencies) {}

  async runPreparedMutation<T>(
    request: PreparedMutationRequest,
    prepareCommit: (context: PreparedMutationContext) => Promise<PreparedMutation<T>>,
    signal: AbortSignal,
  ): Promise<GenerationMutationResult<T>> {
    assertSignal(signal);
    if (typeof prepareCommit !== "function") throw new TypeError("prepared mutation callback is required");
    const validated = validateRequest(request);
    const expectedGeneration = GenerationSchema.parse(request.expectedGeneration);

    return this.dependencies.scheduler.run(
      subjects(validated.scopeReference, validated.plugins),
      () => this.runWithKeys(
        request,
        validated.scope,
        expectedGeneration,
        prepareCommit,
        signal,
      ),
      signal,
    );
  }

  private async runWithKeys<T>(
    request: PreparedMutationRequest,
    scope: ScopeContext,
    expectedGeneration: Generation,
    prepareCommit: (context: PreparedMutationContext) => Promise<PreparedMutation<T>>,
    signal: AbortSignal,
  ): Promise<GenerationMutationResult<T>> {
    const scopeReference = toScopeReference(scope);
    let lease: ScopeLockLease | undefined;
    let primaryFailure: unknown;
    let failed = false;
    let committed: Readonly<{ value: T; snapshot: GenerationSnapshot }> | undefined;
    let outcome: GenerationMutationResult<T> | undefined;
    let observedSnapshot: GenerationSnapshot | undefined;

    try {
      lease = await this.dependencies.locks.acquire(scopeReference, signal);
      await lease.assertOwned(signal);
      const loaded = validateLoadResult(await this.dependencies.state.read(scope, signal), scope);
      if (!loaded.ok) throw loadFailure(loaded);
      const snapshot = loaded.snapshot;
      if (snapshot.generation !== expectedGeneration) {
        outcome = staleResult(expectedGeneration, snapshot.generation);
      } else {
        await lease.assertOwned(signal);
        const prepared = validatePreparedMutation(
          await prepareCommit({
            snapshot,
            assertOwned: () => lease!.assertOwned(signal),
          }),
          request,
          scope,
        );
        await lease.assertOwned(signal);
        if (prepared.beforeCommit !== undefined) {
          await prepared.beforeCommit();
          await lease.assertOwned(signal);
        }
        try {
          const commitResult = validateCommitResult(
            await this.dependencies.state.commit(prepared.mutation, signal),
            request,
            scope,
            snapshot,
            prepared.mutation,
          );
          if (commitResult.kind === "stale-generation") {
            outcome = staleResult(commitResult.expected, commitResult.actual);
          } else {
            committed = { value: prepared.value, snapshot: commitResult.snapshot };
            outcome = { kind: "committed", value: prepared.value, snapshot: commitResult.snapshot };
          }
        } catch (error) {
          const reconciliation = await reconcileCommitFailure(
            this.dependencies,
            lease,
            scope,
            expectedGeneration,
            snapshot,
            prepared.mutation,
            prepared.value,
          );
          outcome = reconciliation.outcome;
          observedSnapshot = reconciliation.observedSnapshot;
          if (reconciliation.committed !== undefined) committed = reconciliation.committed;
          else primaryFailure = error;
        }
      }
    } catch (error) {
      failed = true;
      primaryFailure = error;
    }

    let cleanupFailure: unknown;
    if (lease !== undefined) {
      try {
        await lease.release();
      } catch (error) {
        cleanupFailure = error;
      }
    }

    if (cleanupFailure !== undefined) {
      if (committed !== undefined) throw new CommittedMutationCleanupError(committed, cleanupFailure);
      if (outcome !== undefined) {
        const evidence = observedSnapshot === undefined
          ? { outcome }
          : { outcome, observedSnapshot };
        throw new MutationCleanupError(primaryFailure ?? outcome, cleanupFailure, evidence);
      }
      if (failed || primaryFailure !== undefined) throw new MutationCleanupError(primaryFailure, cleanupFailure);
      throw cleanupFailure;
    }
    if (failed) throw primaryFailure;
    if (outcome === undefined) throw new Error("prepared mutation completed without a result");
    return outcome;
  }
}

export function createGenerationMutationCoordinator(
  dependencies: GenerationMutationCoordinatorDependencies,
): GenerationMutationCoordinator {
  if (dependencies === null || typeof dependencies !== "object") throw new TypeError("generation coordinator dependencies are required");
  if (dependencies.scheduler === undefined || dependencies.locks === undefined || dependencies.state === undefined) {
    throw new TypeError("generation coordinator requires scheduler, locks, and state");
  }
  return new Coordinator(dependencies);
}
