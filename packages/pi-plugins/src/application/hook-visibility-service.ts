import { HostConfigDocumentSchema } from "../domain/state/config-state.js";
import { DefaultHookContextVisibility, HookContextVisibilitySchema, type HookContextVisibility } from "../domain/hook-visibility.js";
import type { Sha256 } from "../domain/source.js";
import type { GenerationMutationCoordinator } from "./generation-mutation-coordinator.js";
import type { LifecycleStateStore } from "./ports/lifecycle-state-store.js";
import { parseStateMutation } from "./state-contract.js";
import {
  NativeHookVisibilityRequestSchema,
  NativeHookVisibilityResultSchema,
  type NativeHookVisibilityRequest,
  type NativeHookVisibilityResult,
} from "./hook-visibility-contract.js";

export interface HookVisibilityService {
  /** Persist a new context-visibility preference in the user-scope host configuration. */
  setVisibility(request: NativeHookVisibilityRequest, signal: AbortSignal): Promise<NativeHookVisibilityResult>;
  /** Read the CURRENT preference; shorthand for the read branch of the command. */
  currentVisibility(): Promise<NativeHookVisibilityResult>;
}

export type HookVisibilityServiceDependencies = Readonly<{
  state: LifecycleStateStore;
  mutations: GenerationMutationCoordinator;
  sha256: Sha256;
}>;

/**
 * Call-time provider over the state store. The hook decision adapter reads
 * the preference per event so a change takes effect without a restart;
 * unavailable state degrades to the default transcript-line visibility
 * rather than failing hook delivery.
 */
export function createHookContextVisibilityProvider(state: LifecycleStateStore): () => Promise<HookContextVisibility> {
  return async () => {
    const loaded = await state.read({ kind: "user" }, new AbortController().signal);
    if (!loaded.ok || !("config" in loaded.snapshot)) return DefaultHookContextVisibility;
    return loaded.snapshot.config.hooks.contextVisibility;
  };
}

export function createHookVisibilityService(dependencies: HookVisibilityServiceDependencies): HookVisibilityService {
  if (dependencies === null || typeof dependencies !== "object" || typeof dependencies.sha256 !== "function") {
    throw new TypeError("hook visibility dependencies are required");
  }

  async function currentVisibility(): Promise<NativeHookVisibilityResult> {
    const visibility = await createHookContextVisibilityProvider(dependencies.state)();
    return NativeHookVisibilityResultSchema.parse({ kind: "current", visibility });
  }

  async function setVisibility(request: NativeHookVisibilityRequest, signal: AbortSignal): Promise<NativeHookVisibilityResult> {
    signal.throwIfAborted();
    const parsed = NativeHookVisibilityRequestSchema.parse(request);
    if (parsed.visibility === undefined) return currentVisibility();
    const visibility = HookContextVisibilitySchema.parse(parsed.visibility);
    const loaded = await dependencies.state.read({ kind: "user" }, signal);
    if (!loaded.ok || !("config" in loaded.snapshot)) {
      return NativeHookVisibilityResultSchema.parse({ kind: "rejected", code: "STATE_UNAVAILABLE" });
    }
    const before = loaded.snapshot.config.hooks.contextVisibility;
    const result = await dependencies.mutations.runPreparedMutation(
      { scope: { kind: "user" }, plugins: [], expectedGeneration: loaded.snapshot.generation },
      async ({ snapshot }) => {
        if (!("config" in snapshot)) throw new Error("hook visibility requires user scope");
        // Same replace pattern as the host precedence service: rebuild the
        // whole hostConfig document through its schema so the mutation stays
        // a verified, generation-checked replacement.
        const config = HostConfigDocumentSchema.parse({
          ...snapshot.config,
          generation: snapshot.generation,
          hooks: { contextVisibility: visibility },
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
    if (result.kind !== "committed") return NativeHookVisibilityResultSchema.parse({ kind: "stale", reason: "generation" });
    return NativeHookVisibilityResultSchema.parse({
      kind: before === visibility ? "unchanged" : "changed",
      visibility,
    });
  }

  return Object.freeze({ setVisibility, currentVisibility });
}
