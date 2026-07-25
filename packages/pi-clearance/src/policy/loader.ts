import type { EffectivePolicy, PolicyPack } from "./core.ts";
import { composePolicy } from "./core.ts";

export interface LoadError {
  readonly packId: string | null;
  readonly ruleId: string | null;
  readonly path: string;
  readonly message: string;
}

export type LoadWarning = never;

export type LoadResult =
  | {
      readonly ok: true;
      readonly policy: EffectivePolicy;
      readonly warnings: readonly LoadWarning[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly LoadError[];
      readonly warnings: readonly LoadWarning[];
    };

export interface LoadEffectivePolicyInput {
  /** Sealed deny floor. Native composition validates that it is deny-only. */
  readonly floor: PolicyPack;
  /** Compiled active packs (posture + overlays). */
  readonly active: readonly PolicyPack[];
}

/** Compose the complete inspectable policy through the native sealed-floor gate. */
export function loadEffectivePolicy(
  input: LoadEffectivePolicyInput,
): LoadResult {
  const composed = composePolicy(input.floor, input.active);
  if (!composed.ok) {
    return {
      ok: false,
      errors: composed.errors,
      warnings: [],
    };
  }

  return {
    ok: true,
    policy: composed.policy,
    warnings: [],
  };
}
