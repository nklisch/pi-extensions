import { describe, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  StateMutationInputSchema,
  type LifecycleStateStore,
  type StateMutation,
  type UnverifiedStateMutation,
  type VerifiedStateMutation,
} from "../../src/index.js";

// Keep this call in dead code: the directive is checked by TypeScript while
// avoiding a runtime dependency on a store instance.
function assertStoreRequiresVerifiedMutation(
  store: LifecycleStateStore,
  input: UnverifiedStateMutation,
  signal: AbortSignal,
): void {
  if (false) {
    // @ts-expect-error Structural schema output must not satisfy the store port.
    void store.commit(input, signal);
  }
}

void assertStoreRequiresVerifiedMutation;

describe("verified state mutation type boundary", () => {
  it("keeps structural schema output separate from the opaque store type", () => {
    expectTypeOf<UnverifiedStateMutation>().toEqualTypeOf<
      z.infer<typeof StateMutationInputSchema>
    >();
    expectTypeOf<UnverifiedStateMutation>().not.toMatchTypeOf<VerifiedStateMutation>();
    expectTypeOf<StateMutation>().toEqualTypeOf<VerifiedStateMutation>();
    expectTypeOf<Parameters<LifecycleStateStore["commit"]>[0]>().toEqualTypeOf<VerifiedStateMutation>();
  });
});
