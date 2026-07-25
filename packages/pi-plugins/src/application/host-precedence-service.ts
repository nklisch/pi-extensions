import {
  DEFAULT_HOST_PRECEDENCE,
  HostPrecedenceSchema,
  type HostPrecedence,
} from "../domain/host-precedence.js";
import { HostConfigDocumentSchema } from "../domain/state/config-state.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import { parseStateMutation } from "./state-contract.js";
import {
  NativeHostPrecedenceRequestSchema,
  NativeHostPrecedenceResultSchema,
  type HostPrecedenceOrder,
  type NativeHostPrecedenceRequest,
  type NativeHostPrecedenceResult,
} from "./host-precedence-contract.js";

export interface HostPrecedenceService {
  /** Persist a new canonical host order in the user-scope host configuration. */
  setHostPrecedence(request: NativeHostPrecedenceRequest, signal: AbortSignal): Promise<NativeHostPrecedenceResult>;
  /**
   * Read the effective precedence from the CURRENT user host configuration.
   * Callers invoke this at use time so a preference change takes effect for
   * the next inspection without a restart; unavailable state degrades to the
   * canonical Claude-first default rather than failing inspection.
   */
  currentHostPrecedence(): Promise<HostPrecedence>;
}

export type HostPrecedenceServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  sha256: Sha256;
}>;

/**
 * Call-time provider over the state store. Composition roots share this so
 * inspection and the write surface always read the same current document.
 */
export function createHostPrecedenceProvider(state: LifecycleStateStore): () => Promise<HostPrecedence> {
  return async () => {
    const loaded = await state.read({ kind: "user" }, new AbortController().signal);
    if (!loaded.ok || !("config" in loaded.snapshot)) return DEFAULT_HOST_PRECEDENCE;
    return loaded.snapshot.config.global.resolution.hostPrecedence;
  };
}

function precedenceFor(order: HostPrecedenceOrder): HostPrecedence {
  return order === "codex-first"
    ? HostPrecedenceSchema.parse(["codex", "claude"])
    : HostPrecedenceSchema.parse(["claude", "codex"]);
}

function orderFor(precedence: HostPrecedence): HostPrecedenceOrder {
  return precedence[0] === "codex" ? "codex-first" : "claude-first";
}

export function createHostPrecedenceService(dependencies: HostPrecedenceServiceDependencies): HostPrecedenceService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("host precedence dependencies are required");
  }

  async function currentHostPrecedence(): Promise<HostPrecedence> {
    return createHostPrecedenceProvider(dependencies.state)();
  }

  async function setHostPrecedence(request: NativeHostPrecedenceRequest, signal: AbortSignal): Promise<NativeHostPrecedenceResult> {
    signal.throwIfAborted();
    const parsed = NativeHostPrecedenceRequestSchema.parse(request);
    const precedence = precedenceFor(parsed.order);
    const loaded = await dependencies.state.read({ kind: "user" }, signal);
    if (!loaded.ok || !("config" in loaded.snapshot)) {
      return NativeHostPrecedenceResultSchema.parse({ kind: "rejected", code: "STATE_UNAVAILABLE" });
    }
    const before = loaded.snapshot.config.global.resolution.hostPrecedence;
    const result = await dependencies.mutations.runPreparedMutation(
      { scope: { kind: "user" }, plugins: [], expectedGeneration: loaded.snapshot.generation },
      async ({ snapshot }) => {
        if (!("config" in snapshot)) throw new Error("host precedence requires user scope");
        // Same replace pattern as the update policy service: rebuild the
        // whole hostConfig document through its schema so the mutation stays
        // a verified, generation-checked replacement.
        const config = HostConfigDocumentSchema.parse({
          ...snapshot.config,
          generation: snapshot.generation,
          global: { ...snapshot.config.global, resolution: { hostPrecedence: precedence } },
        });
        return {
          mutation: parseStateMutation({
            scope: snapshot.scope,
            expectedGeneration: snapshot.generation,
            replace: { config },
          }, dependencies.sha256),
          value: undefined,
        };
      },
      signal,
    );
    if (result.kind !== "committed") return NativeHostPrecedenceResultSchema.parse({ kind: "stale", reason: "generation" });
    const changed = before[0] !== precedence[0];
    return NativeHostPrecedenceResultSchema.parse({
      kind: changed ? "changed" : "unchanged",
      order: orderFor(precedence),
      precedence,
    });
  }

  return Object.freeze({ setHostPrecedence, currentHostPrecedence });
}
